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
//  4. UpdateDescriptionCn with the Subject's own Summary, once it
//     passes bangumi.CleanSummary.  Free — the summary arrived in the
//     step-1 response body.  See persistDescriptionCn.  Listed last but
//     RUNS right after step 2's write, before per-character enrichment:
//     it depends on nothing the character loop produces, so a hard
//     character failure (which retries the whole job) must not be able
//     to strand the description behind it.
//
// Retry policy:
//   - Subject ErrNotFound (Bangumi will not serve us this subject)
//     → mark the row terminal, then return nil.  Retrying wouldn't
//     help: the usual cause is R18 gating, which V1's legacy search
//     endpoint ignores and this v0 endpoint enforces, and no number
//     of anonymous retries turns into a token.  The skip is right;
//     what used to be wrong is that it wrote nothing, leaving the
//     row at bangumi_version = 1 — a state no producer selects for
//     and the admin surface still counts as outstanding.  See
//     MarkBangumiSubjectUnreadable and migration 0031.
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

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"golang.org/x/sync/errgroup"

	"github.com/lawrenceli0228/animego/go-api/internal/bangumi"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
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

// V2Writer is the sqlc subset V2Worker writes.  Five methods:
//   - UpdateBangumiV2 sets score/votes (and COALESCE-protected
//     title_chinese) on anime_cache.
//   - MarkBangumiSubjectUnreadable is the other terminal outcome:
//     upstream answered, and the answer was that this binding is not
//     ours to read.  Returns rows affected so a binding that moved
//     mid-job is reported rather than mistaken for a write.
//   - UpdateAnimeCharacterCN updates one row of anime_characters
//     matched by (anime_id, name_en).
//   - UpsertEpisodeTitleSourced fills per-episode names, labelled
//     'bangumi' and pinned to the binding they were fetched under.
//   - UpdateDescriptionCn stores the Chinese synopsis carried by the
//     same Subject payload (see persistDescriptionCn).
type V2Writer interface {
	UpdateBangumiV2(ctx context.Context, anilistID int32, bangumiScore *float64, bangumiVotes *int32, titleChinese *string) error
	MarkBangumiSubjectUnreadable(ctx context.Context, anilistID int32, bgmID int32) (int64, error)
	UpdateAnimeCharacterCN(ctx context.Context, animeID int32, nameEn *string, nameCN *string, voiceActorCN *string, voiceActorImageURL *string) error
	UpsertEpisodeTitleSourced(ctx context.Context, arg dbgen.UpsertEpisodeTitleSourcedParams) (int64, error)
	UpdateDescriptionCn(ctx context.Context, descriptionCn *string, anilistID int32, bgmID *int32) error
}

// V2Reader is the read surface the episode-title bound needs.
//
// V2 used to have no reads at all -- the Args carry both anilistId and bgmId,
// so the worker bypassed anime_cache for its inputs.  Bounding the episode
// titles to their own season needs two facts the Args cannot carry, because
// both are properties of the AniList entry rather than of the job: how many
// episodes the season has, and how many precede it in its franchise's
// continuous numbering.  Both reads are cheap primary-key lookups and both are
// best-effort -- a failure degrades to "unknown", which the bound already has
// a defined answer for.
type V2Reader interface {
	GetAnimeEpisodeCount(ctx context.Context, anilistID int32) (*int32, error)
	GetAbsoluteEpisodeOffset(ctx context.Context, anilistID int32) (dbgen.GetAbsoluteEpisodeOffsetRow, error)
}

// V2DB combines the read + write surfaces this worker needs.
type V2DB interface {
	V2Reader
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

	// Subject not found: upstream will not serve this bgmId to us.
	// Permanent — retrying won't help — but permanent is a state the
	// row has to be MOVED to, not just a branch the worker takes.
	// Returning nil on its own is what stranded 811 rows at
	// bangumi_version = 1, where the orphan scan (version = 0) and
	// heal-CN (version = 2) both step over them and the admin bar
	// counts them as work.  Mark first, then skip.
	if errors.Is(subErr, bangumi.ErrNotFound) {
		n, mErr := w.db.MarkBangumiSubjectUnreadable(ctx, anilistID, int32(bgmID))
		if mErr != nil {
			// Retryable, unlike the 404 that got us here.  A DB error
			// must not be the thing that recreates the stranding this
			// branch exists to prevent, so let river bring the job
			// back rather than returning nil over a failed write.
			return fmt.Errorf("bangumi_v2 mark unreadable %d (bgmId=%d): %w", anilistID, bgmID, mErr)
		}
		slog.InfoContext(ctx, "bangumi_v2 not_found",
			"anilistId", anilistID,
			"bgmId", bgmID,
			"reason", "subject",
			// 0 means the row was rebound between the fetch and this
			// write, so the verdict belongs to a subject id nobody has
			// asked about yet and the statement correctly refused it.
			// The rebinder owns enqueueing the new binding's V2.
			"marked", n)
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

	// 1b) Chinese description, harvested from the SAME Subject payload
	//     we just read score / votes / name_cn out of — no extra fetch.
	//     Best-effort; see persistDescriptionCn for the full rationale.
	descCnSent := persistDescriptionCn(ctx, w.db, "bangumi_v2", subject, anilistID, bgmID)

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
		total, offset := w.episodeBound(ctx, anilistID)
		titles := normalizeEpisodeTitles(episodes.Eps, total, offset)
		var epFailures int
		epTitlesWritten, epFailures = writeEpisodeTitles(ctx, w.db, anilistID, int32(bgmID), titles)
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
		"descriptionCnSent", descCnSent,
		"chars", totalChars-charFailures,
		"epTitles", epTitlesWritten)
	return nil
}

// descriptionCnWriter is the one-method surface persistDescriptionCn
// needs.  Both V2Writer and V3Writer list it, so either worker's db value
// satisfies it — the same "declare the small interface once, consume it
// from both workers" move bangumi_v3.go already makes with
// BangumiSubjector.
type descriptionCnWriter interface {
	UpdateDescriptionCn(ctx context.Context, descriptionCn *string, anilistID int32, bgmID *int32) error
}

// persistDescriptionCn stores the Chinese synopsis carried by a Subject the
// caller has ALREADY fetched.  Shared by V2 and V3 because both hold a
// Subject at the point they call it.
//
// # Why this costs zero extra upstream requests
//
// Summary rides along inside the very same /v0/subjects/{bgmId} response
// body the caller decoded to get Rating and NameCN.  bangumi.Subject has
// parsed the field all along (client.go) and every caller simply discarded
// it; this stops discarding it.  No second endpoint, no second round trip,
// no extra pressure on Bangumi's rate limit, and no new upstream failure
// mode — if the Subject fetch succeeded, the summary is already in hand.
//
// # Why ok == false is a normal path, not an error
//
// A 150-subject prod sample (see bangumi/summary.go) found ~37% of summaries
// are the untranslated Japanese original — the Chinese one simply has not
// been written by the community yet — plus a few empty or placeholder ones.
// CleanSummary returning false on those IS the feature: the row keeps
// whatever it had and the page goes on falling back to the English
// description, which beats swapping one unreadable language for another.
// Logged at debug precisely because it fires on roughly four of every ten
// enriched rows; at warn it would drown the log in non-events.
//
// # Why a write failure is never fatal
//
// The Chinese description is a bonus on top of what V2/V3 actually exist to
// do — score, votes, Chinese title.  Failing the job here would re-run (and
// possibly re-fail) the primary writes that already committed, to recover an
// optional column.  So: warn and carry on, the same best-effort shape the
// per-character and episode-title writes already use.
//
// The trust gate — bgm_id_map must independently agree with our bgm_id, and
// a 'manual' value is never clobbered — lives in the UpdateDescriptionCn
// WHERE clause, so there is deliberately no binding check here.  A row that
// fails the gate updates zero rows and returns nil: expected, not an error.
//
// The bool reports only that a cleaned value was handed to the DB without
// error; it is NOT a claim that a row changed, since the SQL gate may still
// have matched nothing.  Callers use it for logging only — and log it as
// descriptionCnSent rather than hasDescriptionCn precisely because roughly a
// third of rows have no bgm_id_map entry and will silently update zero rows.
// Coverage has to be counted in the DB (description_cn IS NOT NULL), never
// from these log lines.
func persistDescriptionCn(ctx context.Context, db descriptionCnWriter, phase string, subj *bangumi.Subject, anilistID int32, bgmID int) bool {
	// Nothing to work with — a 404'd subject or one Bangumi has no
	// synopsis for at all.  Not worth a log line.
	if subj == nil || subj.Summary == "" {
		return false
	}

	cleaned, ok := bangumi.CleanSummary(subj.Summary)
	if !ok {
		slog.DebugContext(ctx, phase+" description_cn skipped",
			"anilistId", anilistID,
			"bgmId", bgmID,
			"reason", "summary not usable Chinese")
		return false
	}

	bgm := int32(bgmID)
	if err := db.UpdateDescriptionCn(ctx, &cleaned, anilistID, &bgm); err != nil {
		slog.WarnContext(ctx, phase+" description_cn write error",
			"anilistId", anilistID,
			"bgmId", bgmID,
			"err", err)
		return false
	}
	return true
}

// epTitle is a normalized episode-title row ready for the sourced upsert.
type epTitle struct {
	episode int32
	nameCN  *string
	name    *string
}

// normalizeEpisodeTitles turns a Bangumi episode list into rows for ONE
// AniList entry's slots.  Ported from Express fetchBangumiEpisodes
// (server/services/bangumi.service.js):
//   - keep only main episodes (Type 0, Sort > 0) — drops SP/OP/ED/PV
//   - sort by Sort ascending
//   - normalize the sort offset: a sequel's eps may start at e.g. 29
//     (S1 had 28 eps), so map the first to 1 and the rest relative to it,
//     aligning episode numbers with AniList's 1..N
//   - empty Bangumi strings become nil so the column stays NULL, not ""
//
// ─── the bound, and why the shift alone is not one ──────────────────────
//
// The shift maps the lowest sort to 1, so it can never produce a number
// BELOW the season.  It says nothing about the top, and a Bangumi subject
// routinely covers more than one AniList entry: one subject for a whole
// long-running series, or for two cours AniList splits in half.  Measured on
// production 2026-09-05, 21,001 of 203,019 title rows (10.3%) across 960
// anime sit past their own season's episode count.
//
// Those rows are invisible — the grid renders 1..episodes — so the cost is
// not the overflow itself.  It is that the SAME list filled the slots that
// ARE visible, and whether those hold this season's titles depends on where
// the subject's numbering starts.  Splitting the 960 by PREQUEL edge:
//
//	594  no prequel     first season, so sorts 1..total are this season
//	                    and the overflow is a tail to drop
//	267  has prequel     a later season, so a subject numbered from 1 has
//	                    been writing the WRONG season's titles into 1..N
//	 99  no relations    unknown
//
// Refusing every overflow would destroy 594 correct sets to fix 267.  So the
// bound is a WINDOW rather than a filter: with the absolute offset known,
// this season occupies sorts [offset+1, offset+total] of the franchise's
// continuous numbering and everything outside it is a different season's.
//
// Three inputs, three answers, and the order matters:
//
//   - the shifted list fits → keep it.  This is the healthy majority and
//     the case the shift was written for (a sequel subject numbered 29..40);
//     re-deriving it from the window would change nothing and risk a
//     regression on subjects whose sorts restart at 1 per season.
//   - it overflows and the offset is known → take the window.
//   - it overflows and the offset is not → write nothing.  `known:false` is
//     not `offset:0`; picking the prefix on an unknown origin is the guess
//     that renders as a confident answer, which is the whole failure this
//     function now exists to stop.
//
// total <= 0 means AniList has no count for this row and there is nothing to
// check against, so the list passes through unbounded.  That is not a corner
// case: ListEpisodesBgmCandidates selects `WHERE ac.episodes IS NULL`, so the
// episodes_bgm worker — which derives a count FROM this list — only ever
// calls with an unknown total, and its behaviour is unchanged.
func normalizeEpisodeTitles(raw []bangumi.Episode, total int32, offset *int32) []epTitle {
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

	shifted := renumberEpisodes(mains, int(math.Floor(mains[0].Sort))-1)
	if total <= 0 {
		return shifted
	}
	if len(shifted) > 0 && shifted[len(shifted)-1].episode <= total {
		return shifted
	}
	if offset == nil {
		return nil
	}

	// The window.  `mains` is sorted and math.Round is monotonic, so this
	// selects a contiguous run; subtracting the same offset that defined the
	// window is what lands it on 1..total.
	lo, hi := int(*offset)+1, int(*offset)+int(total)
	inSeason := make([]bangumi.Episode, 0, total)
	for _, e := range mains {
		if n := int(math.Round(e.Sort)); n >= lo && n <= hi {
			inSeason = append(inSeason, e)
		}
	}
	windowed := renumberEpisodes(inSeason, int(*offset))
	if len(windowed) == 0 {
		return nil
	}
	return windowed
}

// renumberEpisodes maps each episode's sort to `sort - shift` and carries the
// two title strings across, dropping anything that lands at or below zero.
//
// The drop is the episode > 0 CHECK constraint restated in Go: a fractional
// sort below the shift (Bangumi numbers recaps 0.5, 12.5) would otherwise
// reach the upsert as a constraint violation surfacing as a failed job.
func renumberEpisodes(eps []bangumi.Episode, shift int) []epTitle {
	out := make([]epTitle, 0, len(eps))
	for _, e := range eps {
		ep := int32(int(math.Round(e.Sort)) - shift)
		if ep <= 0 {
			continue
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

// episodeBound reads the two facts normalizeEpisodeTitles needs to keep a
// Bangumi subject's episode list inside the season it is being filed against.
//
// Both halves fail soft, and to the SAME answer the bound already defines for
// missing data: a total of 0 means "AniList has no count, do not bound", and a
// nil offset means "we do not know what precedes this season", which makes an
// overflowing list refuse rather than guess.  A read error therefore costs a
// bound, never a wrong write -- worth stating because the tempting shortcut,
// returning 0 for a failed offset read, would assert that nothing precedes
// this season and silently reinstate the bug this bound exists to fix.
func (w *BangumiV2Worker) episodeBound(ctx context.Context, anilistID int32) (int32, *int32) {
	return episodeBound(ctx, w.db, anilistID)
}

// episodeBoundReader is the two-read surface the bound needs.  Free-standing
// because the RELEASING episode-title sweep applies the same window to the
// same table and must reach the same answer -- two copies of this would drift
// into two different definitions of "this season".
type episodeBoundReader interface {
	GetAnimeEpisodeCount(ctx context.Context, anilistID int32) (*int32, error)
	GetAbsoluteEpisodeOffset(ctx context.Context, anilistID int32) (dbgen.GetAbsoluteEpisodeOffsetRow, error)
}

func episodeBound(ctx context.Context, db episodeBoundReader, anilistID int32) (int32, *int32) {
	var total int32
	if n, err := db.GetAnimeEpisodeCount(ctx, anilistID); err != nil {
		slog.WarnContext(ctx, "bangumi_v2 episode count read failed",
			"anilistId", anilistID, "err", err)
	} else if n != nil && *n > 0 {
		total = *n
	}

	row, err := db.GetAbsoluteEpisodeOffset(ctx, anilistID)
	if err != nil {
		// pgx.ErrNoRows means the anchor is not cached, which the endpoint
		// serving this same query already treats as an ordinary unknown.
		if !errors.Is(err, pgx.ErrNoRows) {
			slog.WarnContext(ctx, "bangumi_v2 episode offset read failed",
				"anilistId", anilistID, "err", err)
		}
		return total, nil
	}
	if row.Known == nil || !*row.Known {
		return total, nil
	}
	offset := row.AbsoluteOffset
	return total, &offset
}
