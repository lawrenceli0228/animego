// bangumi_v1.go — Phase 1 Bangumi enrichment worker.
//
// Binds an AniList anime to its Bangumi subject, then chains Phase 2.
// Replaces the old exact-string-or-list[0] matcher — which bound ~10% of
// rows to the WRONG subject (a live audit found wrong title_chinese +
// bangumi_score attached) — with a two-tier, confidence-gated flow:
//
//  0. Authoritative id-map (bgm_id_map, the vendored AniList->Bangumi map):
//     a hit binds the subject with source='id_map' and SKIPS search.
//  1. Otherwise read titleNative/Romaji/English + season_year/episodes.
//  2. keyword = titleNative || titleRomaji.  Empty → terminal no-match.
//  3. GET /search/subject/<keyword> (responseGroup=large → air_date + eps).
//  4. bangumi.PickBest scores every candidate (title sim + year + eps):
//     - TierHigh → bind bgm_id, source='fuzzy_high', chain V2.
//     - TierLow / TierNone → REFUSE to bind; MarkBangumiNeedsReview parks
//     the row (no bgm_id, version=2, admin_flag='needs-review').  This
//     is the core fix: we never guess a subject onto a row.  We would
//     rather show AniList romaji than a wrong Chinese name.
//
// Retry policy:  errors returned from Work cause river to retry per its
// configured policy (default 3 attempts, exp backoff).  We return error
// only for transient failures (network / 5xx / DB).  Permanent outcomes
// (no hit, empty keyword, low-confidence, no DB row) return nil so the
// job completes.
//
// SCOPE: writes the V1 columns (bgm_id + title_chinese + bgm_match_source
// + bangumi_version) AND chain-enqueues V2 when a bgm_id was bound.
// Chaining lives here because the V1 worker has the only authoritative
// signal that a bgm_id was just assigned.  V2 enqueue failure is
// non-fatal: V1 already succeeded, so the row won't be re-picked.
package queue

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"

	"github.com/lawrenceli0228/animego/go-api/internal/bangumi"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// BangumiSearcher is the small interface BangumiV1Worker consumes from
// the bangumi package.  *bangumi.Client satisfies it.  Defined here at
// the use-site so tests can supply a stub without dragging in the full
// HTTP client.
type BangumiSearcher interface {
	Search(ctx context.Context, keyword string) (*bangumi.SearchResponse, error)
}

// V1Reader is the sqlc read subset BangumiV1Worker needs.
type V1Reader interface {
	GetAnimeForBangumiSearch(ctx context.Context, anilistID int32) (dbgen.GetAnimeForBangumiSearchRow, error)
	// LookupBgmIdMap returns the authoritative bgm_id for an anilist_id
	// from the vendored map (bgm_id_map), or pgx.ErrNoRows when the anime
	// is not mapped — in which case the worker falls back to search.
	LookupBgmIdMap(ctx context.Context, anilistID int32) (int32, error)
}

// V1Writer is the sqlc write subset BangumiV1Worker needs.
type V1Writer interface {
	// UpdateBangumiV1 binds bgm_id (+ optional title_chinese) and records
	// HOW it was bound via bgmMatchSource ('id_map' | 'fuzzy_high').
	//
	// Returns rows affected.  The query carries an `AND bangumi_version = 0`
	// predicate, so 0 means "this row moved on before the job ran" — a stale
	// duplicate that was correctly refused, NOT an error.  Callers log it and
	// return nil; retrying would refuse again.
	UpdateBangumiV1(ctx context.Context, anilistID int32, bgmID *int32, titleChinese *string, bgmMatchSource *string) (int64, error)
	// MarkBangumiV1NotFound parks a row Bangumi has no record for at all
	// (no keyword / 404 / empty list): terminal version=2, no bgm_id.
	MarkBangumiV1NotFound(ctx context.Context, anilistID int32) error
	// MarkBangumiNeedsReview parks a row the scorer found candidates for
	// but none confident enough to bind: no bgm_id written, version=2,
	// admin_flag='needs-review', bgm_match_source='fuzzy_low'.
	MarkBangumiNeedsReview(ctx context.Context, anilistID int32) error
	// CountAnimeBoundToBgmID reports how many OTHER anime already hold a
	// subject.  One subject describes one work, so a non-zero answer means
	// the scorer picked a subject that is already spoken for.
	CountAnimeBoundToBgmID(ctx context.Context, bgmID int32, excludeAnilistID int32) (int64, error)
}

// V1DB combines the read + write surfaces this worker needs.
// dbgen.Querier satisfies it; the WorkersWithBangumi constructor takes
// this narrower interface so callers can also pass a test double.
type V1DB interface {
	V1Reader
	V1Writer
}

// bgm_match_source values this worker writes.  'fuzzy_low' is written by
// MarkBangumiNeedsReview's SQL (not here) since it pairs with the park.
const (
	matchSourceIDMap     = "id_map"
	matchSourceFuzzyHigh = "fuzzy_high"
)

// BangumiV1Worker is the real Phase 1 worker.  It implements
// river.Worker[BangumiV1Args] by embedding river.WorkerDefaults, which
// wires up the retry / timeout / middleware defaults so only Work has
// to be overridden.
//
// enq is used ONLY to chain a V2 job after a successful bind.  Pass
// NoopEnqueuer{} (or nil — the constructor substitutes Noop) in unit
// tests that don't want to assert on the V2 chain.
type BangumiV1Worker struct {
	river.WorkerDefaults[BangumiV1Args]
	bangumi BangumiSearcher
	db      V1DB
	enq     Enqueuer
}

// NewBangumiV1Worker constructs a worker bound to the given bangumi
// client, DB, and Enqueuer.  bangumiClient + db are required; nil
// panics on the first job (intentional — misconfiguration should
// crash loudly, not silently no-op).
//
// enq is OPTIONAL — nil is replaced with NoopEnqueuer{} so the V2
// chain is a safe no-op when the caller hasn't wired river yet.  V2
// chain enqueue failure is non-fatal (logged + swallowed) so a busted
// river client cannot block V1 from completing.
func NewBangumiV1Worker(bangumiClient BangumiSearcher, db V1DB, enq Enqueuer) *BangumiV1Worker {
	if enq == nil {
		enq = NoopEnqueuer{}
	}
	return &BangumiV1Worker{bangumi: bangumiClient, db: db, enq: enq}
}

// Work is the river dispatch entrypoint.  See the package doc for the
// id-map-first → search → score → gate flow.
func (w *BangumiV1Worker) Work(ctx context.Context, job *river.Job[BangumiV1Args]) error {
	anilistID := int32(job.Args.AnilistID)

	// 0. Authoritative id-map first.  A hit binds the subject without any
	//    Bangumi search — the safest bindings we have.
	if bgmID, err := w.db.LookupBgmIdMap(ctx, anilistID); err == nil {
		id := bgmID
		src := matchSourceIDMap
		n, uErr := w.db.UpdateBangumiV1(ctx, anilistID, &id, nil, &src)
		if uErr != nil {
			return fmt.Errorf("bangumi_v1 id_map update %d: %w", anilistID, uErr)
		}
		if n == 0 {
			// Row left version 0 between enqueue and execution — a stale
			// duplicate.  Do NOT chain V2: whoever advanced the row owns
			// that side of the pipeline.  Not an error, so no retry.
			slog.InfoContext(ctx, "bangumi_v1 stale_skip",
				"anilistId", anilistID, "path", "id_map")
			return nil
		}
		w.chainV2(ctx, anilistID, id)
		slog.InfoContext(ctx, "bangumi_v1 id_map", "anilistId", anilistID, "bgmId", id)
		return nil
	} else if !errors.Is(err, pgx.ErrNoRows) {
		// Transient DB error on the map lookup — let river retry.
		return fmt.Errorf("bangumi_v1 id_map lookup %d: %w", anilistID, err)
	}

	// 1. Not mapped → read the row for keyword + scoring signals.
	row, err := w.db.GetAnimeForBangumiSearch(ctx, anilistID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Anime row absent — nothing to enrich.  Not retryable.
			slog.InfoContext(ctx, "bangumi_v1 no_row", "anilistId", anilistID)
			return nil
		}
		return fmt.Errorf("bangumi_v1 read anime_cache %d: %w", anilistID, err)
	}

	// 2. keyword = titleNative || titleRomaji.  Empty (both NULL/"") →
	//    terminal no-match so the orphan scan stops re-queuing the row.
	keyword := pickKeyword(row.TitleNative, row.TitleRomaji)
	if keyword == "" {
		slog.InfoContext(ctx, "bangumi_v1 no_keyword", "anilistId", anilistID)
		if mErr := w.db.MarkBangumiV1NotFound(ctx, anilistID); mErr != nil {
			return fmt.Errorf("bangumi_v1 mark_not_found %d: %w", anilistID, mErr)
		}
		return nil
	}

	// 3. Search Bangumi (responseGroup=large carries air_date + eps).
	resp, err := w.bangumi.Search(ctx, keyword)
	if err != nil {
		if errors.Is(err, bangumi.ErrNotFound) {
			// 404 → no Bangumi record. Permanent → terminal no-match.
			slog.InfoContext(ctx, "bangumi_v1 no_hit", "anilistId", anilistID, "keyword", keyword)
			if mErr := w.db.MarkBangumiV1NotFound(ctx, anilistID); mErr != nil {
				return fmt.Errorf("bangumi_v1 mark_not_found %d: %w", anilistID, mErr)
			}
			return nil
		}
		// Network / 5xx / decode — transient; let river retry.
		slog.WarnContext(ctx, "bangumi_v1 search error", "anilistId", anilistID, "keyword", keyword, "err", err)
		return fmt.Errorf("bangumi_v1 search %d: %w", anilistID, err)
	}

	// 4. Empty list → terminal no-match (same as 404).
	if len(resp.List) == 0 {
		slog.InfoContext(ctx, "bangumi_v1 no_hit", "anilistId", anilistID, "keyword", keyword)
		if mErr := w.db.MarkBangumiV1NotFound(ctx, anilistID); mErr != nil {
			return fmt.Errorf("bangumi_v1 mark_not_found %d: %w", anilistID, mErr)
		}
		return nil
	}

	// 5. Score every candidate.  Replaces the exact-or-list[0] fallback
	//    that bound wrong subjects.
	in := bangumi.MatchInput{
		TitleNative:  strDeref(row.TitleNative),
		TitleRomaji:  strDeref(row.TitleRomaji),
		TitleEnglish: strDeref(row.TitleEnglish),
		SeasonYear:   i32Deref(row.SeasonYear),
		Episodes:     i32Deref(row.Episodes),
	}
	best, score, tier := bangumi.PickBest(in, resp.List)

	// 6. Confidence gate.  Anything short of high → REFUSE to bind and
	//    park for human review.  No bgm_id is written: no wrong CN/score.
	if tier != bangumi.TierHigh || best == nil {
		slog.InfoContext(ctx, "bangumi_v1 low_confidence",
			"anilistId", anilistID, "keyword", keyword,
			"tier", string(tier), "score", score)
		if mErr := w.db.MarkBangumiNeedsReview(ctx, anilistID); mErr != nil {
			return fmt.Errorf("bangumi_v1 mark_needs_review %d: %w", anilistID, mErr)
		}
		return nil
	}

	// 7. High confidence → bind.  title_chinese only when the chosen hit
	//    carries a real CN translation (non-empty and != native name).
	var titleChinese *string
	if best.NameCN != "" && best.NameCN != best.Name {
		cn := best.NameCN
		titleChinese = &cn
	}
	bgmID := int32(best.ID)
	// A confident score is not the same as an unclaimed subject.  One
	// Bangumi subject describes one work, so binding a second anime to it
	// puts the first one's Chinese title, synopsis and episode names on the
	// second one's public page -- indistinguishable, in the schema, from a
	// correct binding.  BindBgmIdsFromIdMap has refused this since it was
	// written; this path did not, and the whole measured collision set came
	// through here (541 subjects / 1,161 rows on 2026-09-05, none of them
	// bound via id_map).
	//
	// Parked rather than skipped: leaving the row at version 0 puts it back
	// in the orphan scan, to be re-scored and to collide again on every
	// pass.  'needs-review' is the same refusal TierLow already makes, and
	// for the same reason -- we would rather show AniList romaji than
	// another show's name.
	if taken, cErr := w.db.CountAnimeBoundToBgmID(ctx, bgmID, anilistID); cErr != nil {
		// A failed read must not become a licence to bind. Treat it as
		// transient and let river retry the whole job.
		return fmt.Errorf("bangumi_v1 collision check %d (bgmId=%d): %w", anilistID, bgmID, cErr)
	} else if taken > 0 {
		slog.InfoContext(ctx, "bangumi_v1 bgm_id_taken",
			"anilistId", anilistID, "bgmId", bgmID, "heldBy", taken, "path", "fuzzy_high")
		if mErr := w.db.MarkBangumiNeedsReview(ctx, anilistID); mErr != nil {
			return fmt.Errorf("bangumi_v1 park taken %d: %w", anilistID, mErr)
		}
		return nil
	}

	src := matchSourceFuzzyHigh
	n, uErr := w.db.UpdateBangumiV1(ctx, anilistID, &bgmID, titleChinese, &src)
	if uErr != nil {
		slog.WarnContext(ctx, "bangumi_v1 db update error", "anilistId", anilistID, "bgmId", bgmID, "err", uErr)
		return fmt.Errorf("bangumi_v1 update %d: %w", anilistID, uErr)
	}
	if n == 0 {
		// Two predicates can produce this, and the log has to admit both.
		// Either the row left version 0 between enqueue and execution (a
		// stale duplicate — whoever advanced it owns that side of the
		// pipeline), or another anime took this subject between the check
		// above and this statement.  Both are correct refusals and neither
		// is retryable, so V2 is not chained either way.
		slog.InfoContext(ctx, "bangumi_v1 stale_or_taken",
			"anilistId", anilistID, "path", "fuzzy_high", "bgmId", bgmID)
		return nil
	}

	// 8. Chain V2 — best-effort.
	w.chainV2(ctx, anilistID, bgmID)
	slog.InfoContext(ctx, "bangumi_v1 done",
		"anilistId", anilistID, "bgmId", bgmID,
		"tier", "high", "hasChinese", titleChinese != nil)
	return nil
}

// chainV2 enqueues the Phase-2 follow-up for a freshly bound bgm_id.
// Best-effort: V1 already committed, so an enqueue failure is logged and
// swallowed (the row is at version=1 and won't be re-picked by the orphan
// scan; worst case V2 never fires for it).
func (w *BangumiV1Worker) chainV2(ctx context.Context, anilistID, bgmID int32) {
	if cErr := w.enq.EnqueueV2Many(ctx, []BangumiV2Args{{
		AnilistID: int(anilistID),
		BgmID:     int(bgmID),
	}}); cErr != nil {
		slog.WarnContext(ctx, "bangumi_v1 chain v2 enqueue error",
			"anilistId", anilistID, "bgmId", bgmID, "err", cErr)
	}
}

// pickKeyword returns titleNative if non-empty, else titleRomaji if
// non-empty, else "".  Treats nil and "" identically — both mean
// "missing".
func pickKeyword(native, romaji *string) string {
	if native != nil && *native != "" {
		return *native
	}
	if romaji != nil && *romaji != "" {
		return *romaji
	}
	return ""
}

// strDeref returns the pointed-to string, or "" for nil.
func strDeref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// i32Deref returns the pointed-to int32 as an int, or 0 for nil.
func i32Deref(n *int32) int {
	if n == nil {
		return 0
	}
	return int(*n)
}
