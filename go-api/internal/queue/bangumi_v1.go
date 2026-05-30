// bangumi_v1.go — Phase 1 Bangumi enrichment worker.
//
// Replaces the stubBangumiV1Worker placeholder.  Mirrors
// server/services/bangumi.service.js's fetchBangumiData + processQueue
// V1 branch:
//
//  1. Read titleNative + titleRomaji from anime_cache for the job's
//     anilistId.
//  2. keyword = titleNative || titleRomaji.  Empty → no-op completion.
//  3. POST /search/subject/<keyword>?type=2&responseGroup=small&max_results=5.
//  4. Pick the exact-native match if present, else list[0].
//  5. Write back bgm_id + (titleChinese when exact native match with a
//     real CN translation).  bangumi_version = 1.
//
// Retry policy:  errors returned from Work cause river to retry per its
// configured policy (default 3 attempts with exponential backoff).  We
// only return error for transient failures (network / 5xx / DB write
// error).  Permanent "no hit" conditions (ErrNotFound, empty keyword,
// empty list, no DB row) return nil so the job completes.
//
// SCOPE: this worker writes the V1 columns (bgm_id + title_chinese +
// bangumi_version) AND chain-enqueues the V2 follow-up job when a
// bgm_id was found.  Chaining lives here (not in a separate
// orchestrator) because the V1 worker has the only authoritative
// signal that a bgm_id was just assigned — bridging that to a separate
// "watch for new bgm_ids" component would race against the V1 write
// and add a polling stage for no benefit.  V2 enqueue failure is
// non-fatal: V1 already succeeded (row bumped to version=1), so the
// row won't be re-picked by the orphan scan; worst case is V2 never
// runs for this row, which is acceptable.
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

// V1Reader is the sqlc subset BangumiV1Worker reads — only the row
// lookup for titleNative / titleRomaji.  Defined at use-site (Accept
// interfaces, return structs) so tests can stub a single method.
type V1Reader interface {
	GetAnimeForBangumiSearch(ctx context.Context, anilistID int32) (dbgen.GetAnimeForBangumiSearchRow, error)
}

// V1Writer is the sqlc subset BangumiV1Worker writes — the V1 column
// update on a hit, and the terminal no-match write on a miss.  Split
// from V1Reader so future workers can compose just the surface they need.
type V1Writer interface {
	UpdateBangumiV1(ctx context.Context, anilistID int32, bgmID *int32, titleChinese *string) error
	MarkBangumiV1NotFound(ctx context.Context, anilistID int32) error
}

// V1DB combines the read + write surfaces this worker needs.
// dbgen.Querier satisfies it; the WorkersWithBangumi constructor takes
// this narrower interface so callers can also pass a test double.
type V1DB interface {
	V1Reader
	V1Writer
}

// BangumiV1Worker is the real Phase 1 worker.  It implements
// river.Worker[BangumiV1Args] by embedding river.WorkerDefaults, which
// wires up the retry / timeout / middleware defaults so only Work has
// to be overridden.
//
// enq is used ONLY to chain a V2 job after a successful V1 write with
// a non-nil bgmID.  Pass NoopEnqueuer{} (or nil — the constructor
// substitutes Noop) in unit tests that don't want to assert on the
// V2 chain.
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

// Work is the river dispatch entrypoint.  See package doc for the
// 5-step flow.  Returns nil on permanent "no hit" outcomes, an error
// wrapped with anilistId context for retryable failures.
func (w *BangumiV1Worker) Work(ctx context.Context, job *river.Job[BangumiV1Args]) error {
	anilistID := int32(job.Args.AnilistID)

	// 1. Read titleNative + titleRomaji from anime_cache.
	row, err := w.db.GetAnimeForBangumiSearch(ctx, anilistID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Anime row absent — nothing to enrich.  Not a retryable
			// failure: another writer would need to insert the row
			// first, but that's outside the V1 worker's contract.
			slog.InfoContext(ctx, "bangumi_v1 no_row",
				"anilistId", anilistID)
			return nil
		}
		return fmt.Errorf("bangumi_v1 read anime_cache %d: %w", anilistID, err)
	}

	// 2. Compute keyword.  titleNative first, else titleRomaji.  Treat
	//    empty string the same as nil (defensive — sqlc returns nil
	//    pointers for SQL NULL, but a value-side empty string would
	//    look like a present-but-meaningless keyword to Bangumi).
	keyword := pickKeyword(row.TitleNative, row.TitleRomaji)
	if keyword == "" {
		slog.InfoContext(ctx, "bangumi_v1 no_keyword",
			"anilistId", anilistID)
		if err := w.db.MarkBangumiV1NotFound(ctx, anilistID); err != nil {
			return fmt.Errorf("bangumi_v1 mark_not_found %d: %w", anilistID, err)
		}
		return nil
	}

	// 3. Hit the Bangumi search endpoint.
	resp, err := w.bangumi.Search(ctx, keyword)
	if err != nil {
		if errors.Is(err, bangumi.ErrNotFound) {
			// 404 → no Bangumi record for this title.  Permanent, not
			// retryable.  Mirror Express: write terminal version=2 so the
			// orphan scan (version=0) stops re-queuing this row.
			slog.InfoContext(ctx, "bangumi_v1 no_hit",
				"anilistId", anilistID,
				"keyword", keyword)
			if err := w.db.MarkBangumiV1NotFound(ctx, anilistID); err != nil {
				return fmt.Errorf("bangumi_v1 mark_not_found %d: %w", anilistID, err)
			}
			return nil
		}
		// Any other error (network, 5xx, decode failure) is
		// transient — let river retry per its policy.
		slog.WarnContext(ctx, "bangumi_v1 search error",
			"anilistId", anilistID,
			"keyword", keyword,
			"err", err)
		return fmt.Errorf("bangumi_v1 search %d: %w", anilistID, err)
	}

	// 4. Empty list is treated the same as ErrNotFound — Express
	//    returns null here too.  Bangumi sometimes returns 200 with
	//    {list:[]} for queries that don't pattern-match a real subject.
	//    Write terminal version=2 so the orphan scan stops re-queuing.
	if len(resp.List) == 0 {
		slog.InfoContext(ctx, "bangumi_v1 no_hit",
			"anilistId", anilistID,
			"keyword", keyword)
		if err := w.db.MarkBangumiV1NotFound(ctx, anilistID); err != nil {
			return fmt.Errorf("bangumi_v1 mark_not_found %d: %w", anilistID, err)
		}
		return nil
	}

	// 5. Pick the hit: exact native-title match if present, else list[0].
	hit, exactMatch := selectHit(resp.List, row.TitleNative)

	// 6. Decide titleChinese.  Express: only when exact match + non-empty
	//    name_cn that actually differs from name (i.e. a real translation).
	var titleChinese *string
	if exactMatch && hit.NameCN != "" && hit.NameCN != hit.Name {
		// Take a local copy before pointing at it so the loop variable
		// (or future caller mutation of hit) cannot affect the value
		// we hand to the DB layer.
		cn := hit.NameCN
		titleChinese = &cn
	}

	// 7. bgmID is always set when we have a hit, regardless of CN
	//    translation availability.  Phase 2 needs bgm_id; CN is a
	//    bonus only available on exact matches.
	bgmID := int32(hit.ID)

	// 8. Persist.  Any DB error is transient; river retries.
	if err := w.db.UpdateBangumiV1(ctx, anilistID, &bgmID, titleChinese); err != nil {
		slog.WarnContext(ctx, "bangumi_v1 db update error",
			"anilistId", anilistID,
			"bgmId", bgmID,
			"err", err)
		return fmt.Errorf("bangumi_v1 update %d: %w", anilistID, err)
	}

	// 9. Chain V2 — best-effort.  V1 already succeeded, so a chain
	//    enqueue failure shouldn't roll back V1's write.  Log the
	//    failure and continue: the row is now at version=1 and the
	//    orphan scan won't re-pick it, so worst case is V2 never
	//    fires for this row.  Acceptable given the failure mode is
	//    almost always "river client momentarily unavailable" and
	//    the next manual sweep will catch it.
	if cErr := w.enq.EnqueueV2Many(ctx, []BangumiV2Args{{
		AnilistID: int(anilistID),
		BgmID:     int(bgmID),
	}}); cErr != nil {
		slog.WarnContext(ctx, "bangumi_v1 chain v2 enqueue error",
			"anilistId", anilistID,
			"bgmId", bgmID,
			"err", cErr)
	}

	slog.InfoContext(ctx, "bangumi_v1 done",
		"anilistId", anilistID,
		"bgmId", bgmID,
		"hasChinese", titleChinese != nil)
	return nil
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

// selectHit walks the search results, prefers an exact native-title
// match, falls back to list[0].  exactMatch reports whether the chosen
// hit's Name equals titleNative (only true when titleNative is non-nil
// AND a matching entry was found).
//
// list MUST be non-empty (caller checks); panics otherwise — caller
// contract violation, not a runtime error.
func selectHit(list []bangumi.SearchResult, titleNative *string) (*bangumi.SearchResult, bool) {
	if titleNative != nil && *titleNative != "" {
		for i := range list {
			if list[i].Name == *titleNative {
				return &list[i], true
			}
		}
	}
	return &list[0], false
}
