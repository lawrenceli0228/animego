// bangumi_v2.go — Phase 2 Bangumi enrichment worker.
//
// Replaces the stubBangumiV2Worker placeholder.  Mirrors
// server/services/bangumi.service.js's processPhase4Queue branch:
//
//  1. Fetch /v0/subjects/{bgmId} and /v0/subjects/{bgmId}/characters
//     in parallel for the bgmID handed to us by the job args.
//  2. UpdateBangumiV2 on anime_cache — writes bangumi_score,
//     bangumi_votes (from Subject.Rating) and CONDITIONALLY fills
//     title_chinese via SQL COALESCE (so a value V1 already wrote on
//     exact native match is never clobbered).  bangumi_version → 2.
//  3. For each Bangumi Character, UpdateAnimeCharacterCN matched by
//     name_en → name_cn + voice_actor_cn + voice_actor_image_url.
//     Rows that don't match a Bangumi character stay AniList-only.
//
// Retry policy:
//   - Subject ErrNotFound (Bangumi has no record for this bgmId)
//     → return nil, permanent skip.  Retrying wouldn't help.
//   - Either call has a network / 5xx error → return wrapped error so
//     river retries per its policy (default 3 attempts, exp backoff).
//   - Subject succeeds but Characters 404 → keep going with subject
//     data (and zero character writes).  Express ignored per-char
//     failures the same way.
//   - Per-character UPDATE errors are logged but NOT fatal — unless
//     more than half error in which case we return so river retries.
//     Protects against a wedged DB connection silently degrading
//     enrichment quality while still tolerating per-row mismatches.
//
// SCOPE: writes V2 fields AND chain-enqueues a V3 heal-CN job when
// the Subject we just fetched didn't supply a Chinese title (i.e.
// we passed nil titleChinese into UpdateBangumiV2, leaving any
// existing value via SQL COALESCE).  V3 will re-fetch the Subject
// and overwrite title_chinese unconditionally as the terminal heal
// attempt.  Chaining lives here (not in a separate orchestrator)
// because the V2 worker has the only authoritative signal that the
// Subject's name_cn was missing this run — bridging that to a
// separate "watch for v2 with no CN" component would race against
// the V2 write and add a polling stage for no benefit.  V3 enqueue
// failure is non-fatal: V2 already succeeded.
package queue

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"sort"
	"time"

	"github.com/riverqueue/river"
	"golang.org/x/sync/errgroup"

	"github.com/lawrenceli0228/animego/go-api/internal/bangumi"
)

// v2WorkTimeout bounds the worker's total budget for Subject +
// Characters + N character UPDATEs.  Generous to survive Bangumi's
// worst observed latency but tight enough to free a worker slot when
// upstream is wedged.
const v2WorkTimeout = 30 * time.Second

// v2CharErrorRetryThreshold — when more than this fraction of the
// per-character UPDATEs fail, return error so river retries the whole
// job.  0.5 means "if half or more error, retry"; below that we treat
// it as best-effort partial success and return nil.
const v2CharErrorRetryThreshold = 0.5

// BangumiSubjector is the small use-site interface for Subject fetch.
// *bangumi.Client satisfies it.  Defined here at the consumer (V2
// worker) per "Accept interfaces, return structs" — tests stub one
// method without dragging the full HTTP client into scope.
type BangumiSubjector interface {
	Subject(ctx context.Context, bgmID int) (*bangumi.Subject, error)
}

// BangumiCharactersFetcher is the small use-site interface for the
// characters list fetch.  *bangumi.Client satisfies it.
type BangumiCharactersFetcher interface {
	Characters(ctx context.Context, bgmID int) ([]bangumi.Character, error)
}

// BangumiEpisodesFetcher is the small use-site interface for the episode
// list fetch (/subject/{bgmId}/ep).  *bangumi.Client satisfies it. This
// is the half that ports Express's Phase-4 episodeTitles enrichment —
// without it go-api could never fill in per-episode names.
type BangumiEpisodesFetcher interface {
	Episodes(ctx context.Context, bgmID int) (*bangumi.EpisodesResponse, error)
}

// BangumiV2Client is the merged interface BangumiV2Worker needs.  We
// keep the halves separate above so future workers can compose just the
// surface they need; this alias is for production wiring (one client,
// one type) and test-time fakes that satisfy all three.
type BangumiV2Client interface {
	BangumiSubjector
	BangumiCharactersFetcher
	BangumiEpisodesFetcher
}

// V2Writer is the sqlc subset V2Worker writes.  Two methods:
//   - UpdateBangumiV2 sets score/votes (and COALESCE-protected
//     title_chinese) on anime_cache.
//   - UpdateAnimeCharacterCN updates one row of anime_characters
//     matched by (anime_id, name_en).
type V2Writer interface {
	UpdateBangumiV2(ctx context.Context, anilistID int32, bangumiScore *float64, bangumiVotes *int32, titleChinese *string) error
	UpdateAnimeCharacterCN(ctx context.Context, animeID int32, nameEn *string, nameCN *string, voiceActorCN *string, voiceActorImageURL *string) error
	UpsertEpisodeTitle(ctx context.Context, animeID int32, episode int32, nameCN *string, name *string) error
}

// V2DB combines the read + write surfaces this worker needs.  V2 has
// no DB reads (the Args carry both anilistId + bgmId already, so the
// worker bypasses anime_cache for its inputs) so V2DB == V2Writer for
// now.  Keep the interface separate from V2Writer so future workers
// adding reads don't have to touch every call site.
type V2DB interface {
	V2Writer
}

// BangumiV2Worker is the real Phase 2 worker.  Embeds
// river.WorkerDefaults so only Work has to be overridden.
//
// enq is used ONLY to chain a V3 job after a successful V2 update
// when this run's Subject didn't supply a Chinese title (Subject
// fetch may have a fresher copy on the next call).  Pass
// NoopEnqueuer{} (or nil — the constructor substitutes Noop) in
// unit tests that don't want to assert on the V3 chain.
type BangumiV2Worker struct {
	river.WorkerDefaults[BangumiV2Args]
	bangumi BangumiV2Client
	db      V2DB
	enq     Enqueuer
}

// NewBangumiV2Worker constructs a worker bound to the given bangumi
// client, DB, and Enqueuer.  bangumiClient + db are required; nil
// panics on the first job (intentional — misconfiguration should
// crash loudly, not silently no-op).
//
// enq is OPTIONAL — nil is replaced with NoopEnqueuer{} so the V3
// chain is a safe no-op when the caller hasn't wired river yet.  V3
// chain enqueue failure is non-fatal (logged + swallowed) so a busted
// river client cannot block V2 from completing.
func NewBangumiV2Worker(bangumiClient BangumiV2Client, db V2DB, enq Enqueuer) *BangumiV2Worker {
	if enq == nil {
		enq = NoopEnqueuer{}
	}
	return &BangumiV2Worker{bangumi: bangumiClient, db: db, enq: enq}
}

// Work is the river dispatch entrypoint.  See package doc for the
// full decision tree.  Returns nil for permanent outcomes (subject
// 404), wrapped error for transient outcomes (network / 5xx / DB).
func (w *BangumiV2Worker) Work(ctx context.Context, job *river.Job[BangumiV2Args]) error {
	anilistID := int32(job.Args.AnilistID)
	bgmID := job.Args.BgmID

	// Bound the worker's total time budget.  This caps Subject +
	// Characters + per-character UPDATEs together; an individual call
	// being slow shouldn't tie up a worker slot forever.
	ctx, cancel := context.WithTimeout(ctx, v2WorkTimeout)
	defer cancel()

	// Parallel fetch — Subject + Characters from Bangumi.
	// errgroup.WithContext cancels both calls if one fails, but we
	// inspect the individual results below to distinguish ErrNotFound
	// (permanent) from transport errors (retryable).
	var (
		subject    *bangumi.Subject
		characters []bangumi.Character
		episodes   *bangumi.EpisodesResponse
		subErr     error
		charErr    error
		epErr      error
	)

	g, gctx := errgroup.WithContext(ctx)
	g.Go(func() error {
		s, err := w.bangumi.Subject(gctx, bgmID)
		subject = s
		subErr = err
		// Don't return err here — let the joint inspection below
		// decide retry vs permanent.  Returning err would cancel the
		// peer (Characters) goroutine on a benign ErrNotFound.
		return nil
	})
	g.Go(func() error {
		cs, err := w.bangumi.Characters(gctx, bgmID)
		characters = cs
		charErr = err
		return nil
	})
	g.Go(func() error {
		eps, err := w.bangumi.Episodes(gctx, bgmID)
		episodes = eps
		epErr = err
		return nil
	})
	// errgroup.Wait won't actually error (we returned nil from both
	// goroutines) — drain it to ensure both finished before we read
	// the result variables.
	_ = g.Wait()

	// Subject not found means Bangumi has no subject for this bgmId.
	// Permanent — retrying won't help.  Express returned null and
	// dropped the row; we do the same.
	if errors.Is(subErr, bangumi.ErrNotFound) {
		slog.InfoContext(ctx, "bangumi_v2 not_found",
			"anilistId", anilistID,
			"bgmId", bgmID,
			"reason", "subject")
		return nil
	}
	// Other subject error → transient, retryable.
	if subErr != nil {
		return fmt.Errorf("bangumi_v2 subject %d (bgmId=%d): %w", anilistID, bgmID, subErr)
	}

	// Characters errors:
	//   - ErrNotFound is tolerable — Bangumi sometimes has subjects
	//     with no character rows; proceed with subject-only update.
	//   - Other errors are transient; we retry the whole job so we
	//     don't half-update the row.
	if charErr != nil && !errors.Is(charErr, bangumi.ErrNotFound) {
		return fmt.Errorf("bangumi_v2 characters %d (bgmId=%d): %w", anilistID, bgmID, charErr)
	}
	if errors.Is(charErr, bangumi.ErrNotFound) {
		// Defensive: ensure characters is nil so the loop below is a
		// no-op.  The HTTP client already returns nil on 404 but this
		// keeps the contract local.
		characters = nil
	}

	// Build the V2 update args.  All three are nullable; pass nil
	// when the upstream field is missing so the SQL COALESCE/UPDATE
	// leaves the column untouched (title_chinese) or NULL (score/votes).
	var (
		bangumiScore *float64
		bangumiVotes *int32
		titleChinese *string
	)
	if subject.Rating != nil {
		score := subject.Rating.Score
		bangumiScore = &score
		votes := int32(subject.Rating.Count)
		bangumiVotes = &votes
	}
	if subject.NameCN != "" {
		cn := subject.NameCN
		titleChinese = &cn
	}

	// 1) Persist the subject-derived V2 fields.  Any DB error is
	//    transient — river retries.
	if err := w.db.UpdateBangumiV2(ctx, anilistID, bangumiScore, bangumiVotes, titleChinese); err != nil {
		return fmt.Errorf("bangumi_v2 update %d (bgmId=%d): %w", anilistID, bgmID, err)
	}

	// 2) Per-character enrichment.  Track failure count so a wedged
	//    DB connection doesn't silently degrade enrichment quality —
	//    if more than half error, we ask river to retry the whole job
	//    (UpdateBangumiV2 is idempotent — it just rewrites the same
	//    values, no harm).
	totalChars := len(characters)
	charFailures := 0
	for i := range characters {
		c := &characters[i]

		// nameEn: Bangumi's Character.Name is the canonical name we
		// match against our anime_characters.name_en.  Pass a local
		// pointer (NOT &c.Name) so any later loop iteration mutating
		// c can't change the value we already handed to the DB.
		nameEnStr := c.Name
		nameEn := &nameEnStr

		var nameCN *string
		if c.NameCN != "" {
			cn := c.NameCN
			nameCN = &cn
		}

		var voiceActorCN *string
		if len(c.Actors) > 0 && c.Actors[0].NameCN != "" {
			va := c.Actors[0].NameCN
			voiceActorCN = &va
		}

		var voiceActorImageURL *string
		if c.Images != nil && c.Images.Medium != "" {
			img := c.Images.Medium
			voiceActorImageURL = &img
		}

		if err := w.db.UpdateAnimeCharacterCN(ctx, anilistID, nameEn, nameCN, voiceActorCN, voiceActorImageURL); err != nil {
			charFailures++
			slog.WarnContext(ctx, "bangumi_v2 char update error",
				"anilistId", anilistID,
				"bgmId", bgmID,
				"nameEn", nameEnStr,
				"err", err)
			continue
		}
	}

	// More than half the per-char UPDATEs errored — almost certainly
	// a persistent DB problem.  Return error so river retries the
	// whole job rather than silently degrading enrichment quality.
	if totalChars > 0 && float64(charFailures)/float64(totalChars) >= v2CharErrorRetryThreshold {
		return fmt.Errorf("bangumi_v2 too many char failures %d/%d for anilistId=%d (bgmId=%d)",
			charFailures, totalChars, anilistID, bgmID)
	}

	if charFailures > 0 {
		slog.WarnContext(ctx, "bangumi_v2 partial char failures",
			"anilistId", anilistID,
			"bgmId", bgmID,
			"failures", charFailures,
			"total", totalChars)
	}

	// 3) Episode titles — Express Phase-4 parity. Best-effort, like the
	//    per-character writes: an episodes ErrNotFound / transport error
	//    (or a write failure) is logged + skipped, never fails the job —
	//    the subject + character writes already committed. Without this
	//    block go-api had no path to fill per-episode names at all.
	epTitlesWritten := 0
	if epErr != nil {
		if !errors.Is(epErr, bangumi.ErrNotFound) {
			slog.WarnContext(ctx, "bangumi_v2 episodes fetch error",
				"anilistId", anilistID, "bgmId", bgmID, "err", epErr)
		}
	} else if episodes != nil {
		titles := normalizeEpisodeTitles(episodes.Eps)
		epFailures := 0
		for _, t := range titles {
			if err := w.db.UpsertEpisodeTitle(ctx, anilistID, t.episode, t.nameCN, t.name); err != nil {
				epFailures++
				continue
			}
			epTitlesWritten++
		}
		if epFailures > 0 {
			slog.WarnContext(ctx, "bangumi_v2 episode title write failures",
				"anilistId", anilistID, "bgmId", bgmID,
				"failures", epFailures, "total", len(titles))
		}
	}

	// Chain V3 heal-CN when this V2 run did NOT supply a Chinese
	// title.  Reasoning: V2's UpdateBangumiV2 uses SQL COALESCE on
	// title_chinese, so passing nil here means the column is either
	// already set (V1 hit an exact native match → CN already
	// populated) OR still NULL (neither V1 nor V2's Subject had
	// name_cn).  We can't distinguish without an extra read, so we
	// just chain V3 whenever V2's Subject was empty — if the column
	// is already set, V3's overwrite is idempotent (re-fetches the
	// same Subject and writes the same nil-or-value).  Trading one
	// extra Bangumi API call per "V2-no-CN" row for not adding a
	// pre-chain read; manageable cost given the heal pipeline only
	// processes each row at most three times.
	//
	// V3 enqueue failure is non-fatal — V2 already succeeded and the
	// row is at version=2.  Worst case: V3 never fires, row stays at
	// version=2 with possibly NULL title_chinese.  Acceptable: the
	// orphan scan can re-pick stuck rows later.
	if titleChinese == nil {
		if cErr := w.enq.EnqueueV3Many(ctx, []BangumiV3Args{{
			AnilistID: int(anilistID),
			BgmID:     bgmID,
		}}); cErr != nil {
			slog.WarnContext(ctx, "bangumi_v2 chain v3 enqueue error",
				"anilistId", anilistID,
				"bgmId", bgmID,
				"err", cErr)
		}
	}

	slog.InfoContext(ctx, "bangumi_v2 done",
		"anilistId", anilistID,
		"bgmId", bgmID,
		"hasScore", bangumiScore != nil,
		"hasChinese", titleChinese != nil,
		"chars", totalChars-charFailures,
		"epTitles", epTitlesWritten)
	return nil
}

// epTitle is a normalized episode-title row ready for UpsertEpisodeTitle.
type epTitle struct {
	episode int32
	nameCN  *string
	name    *string
}

// normalizeEpisodeTitles ports Express fetchBangumiEpisodes
// (server/services/bangumi.service.js):
//   - keep only main episodes (Type 0, Sort > 0) — drops SP/OP/ED/PV
//   - sort by Sort ascending
//   - normalize the sort offset: a sequel's eps may start at e.g. 29
//     (S1 had 28 eps), so map the first to 1 and the rest relative to it,
//     aligning episode numbers with AniList's 1..N
//   - empty Bangumi strings become nil so the column stays NULL, not ""
func normalizeEpisodeTitles(raw []bangumi.Episode) []epTitle {
	mains := make([]bangumi.Episode, 0, len(raw))
	for _, e := range raw {
		if e.Type == 0 && e.Sort > 0 {
			mains = append(mains, e)
		}
	}
	if len(mains) == 0 {
		return nil
	}
	sort.Slice(mains, func(i, j int) bool { return mains[i].Sort < mains[j].Sort })

	offset := int(math.Floor(mains[0].Sort)) - 1
	out := make([]epTitle, 0, len(mains))
	for _, e := range mains {
		ep := int32(int(math.Round(e.Sort)) - offset)
		if ep <= 0 {
			continue // guard the episode > 0 CHECK constraint
		}
		var nameCN *string
		if e.NameCN != "" {
			cn := e.NameCN
			nameCN = &cn
		}
		var name *string
		if e.Name != "" {
			n := e.Name
			name = &n
		}
		out = append(out, epTitle{episode: ep, nameCN: nameCN, name: name})
	}
	return out
}
