// bangumi_v3.go — Phase 3 Bangumi heal-CN worker.
//
// Replaces the stubBangumiV3Worker placeholder.  Mirrors
// server/services/bangumi.service.js's processV3Queue branch:
//
//  1. Read {anilistId, bgmId} straight from job args — no DB read.
//     The V2 worker chains V3 with both ids already populated so we
//     don't need to re-derive bgm_id from anime_cache here.
//  2. Fetch /v0/subjects/{bgmId}.  V3 is the terminal heal attempt
//     for title_chinese — sometimes Bangumi's name_cn was empty at
//     V1/V2 fetch time but populated later (a Bangumi editor filled
//     it in between requests).  V3 takes one more shot.
//  3. titleChinese = Subject.NameCN (when non-empty) else nil.  The
//     UpdateBangumiV3 SQL writes the column unconditionally (NOT
//     COALESCE) — V3 is the terminal phase so a heal attempt's NULL
//     stays NULL until the next manual sweep.  Note: V2 already
//     populated title_chinese via COALESCE when its Subject had
//     name_cn — V3 only chains when V2 itself supplied nil
//     titleChinese (see bangumi_v2.go chain logic), so this overwrite
//     is safe (the column was NULL when we got here).
//  4. bangumi_version=3 set unconditionally — V3 is the terminal
//     phase.  Even a 404 from Bangumi (ErrNotFound) bumps the version
//     so the row isn't picked up by another sweep.
//
// Retry policy:
//   - Subject ErrNotFound → write NULL + bump version=3, return nil.
//     This is terminal completion (no more heal attempts), NOT a
//     transient skip — different from V2 where ErrNotFound on subject
//     is a permanent skip without any write.  Reasoning: V3 always
//     owns the version bump (so the heal pipeline can declare "done"),
//     V2 owns the score/votes write (so a 404 there means "no data to
//     write at all").
//   - Other Subject errors → return wrapped error so river retries
//     per its policy (default 3 attempts, exp backoff).
//   - DB write error → return wrapped error so river retries.
//
// SCOPE: V3 writes ONLY title_chinese + bangumi_version.  It does NOT
// chain another worker — V3 is terminal.  All character / score /
// vote enrichment was V2's responsibility.
package queue

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/riverqueue/river"

	"github.com/lawrenceli0228/animego/go-api/internal/bangumi"
)

// v3WorkTimeout bounds the worker's total budget for one Subject
// fetch + one UPDATE.  Generous (15s) to survive Bangumi's worst
// observed latency (700ms throttle + up to 8s timeout) while keeping
// a worker slot free if upstream is wedged.
const v3WorkTimeout = 15 * time.Second

// V3Writer is the sqlc subset BangumiV3Worker writes.  Single method:
// UpdateBangumiV3 sets title_chinese (nullable) and bumps
// bangumi_version=3 on anime_cache.
type V3Writer interface {
	UpdateBangumiV3(ctx context.Context, anilistID int32, titleChinese *string) error
}

// V3DB combines the read + write surfaces this worker needs.  V3 has
// no DB reads (the Args carry both anilistId + bgmId already), so
// V3DB == V3Writer for now.  Kept as a separate interface so future
// workers adding reads don't have to touch every call site.
type V3DB interface {
	V3Writer
}

// BangumiV3Worker is the real Phase 3 heal-CN worker.  Embeds
// river.WorkerDefaults so only Work has to be overridden.
//
// bangumi reuses the small BangumiSubjector interface from
// bangumi_v2.go — *bangumi.Client satisfies it.  Defining the type
// once (and consuming it in both workers) keeps the test-fake surface
// minimal: a single stub satisfies both V2 and V3.
type BangumiV3Worker struct {
	river.WorkerDefaults[BangumiV3Args]
	bangumi BangumiSubjector
	db      V3DB
}

// NewBangumiV3Worker constructs a worker bound to the given bangumi
// client and DB.  Both dependencies are required; nil panics on the
// first job (intentional — misconfiguration should crash loudly, not
// silently no-op).  Construction itself is safe with nil deps; only
// Work() dereferences.
func NewBangumiV3Worker(bangumiClient BangumiSubjector, db V3DB) *BangumiV3Worker {
	return &BangumiV3Worker{bangumi: bangumiClient, db: db}
}

// Work is the river dispatch entrypoint.  See package doc for the
// full decision tree.  Always bumps bangumi_version=3 on success or
// soft-fail (Subject 404).  Returns wrapped error only for transient
// outcomes (network / 5xx / DB).
func (w *BangumiV3Worker) Work(ctx context.Context, job *river.Job[BangumiV3Args]) error {
	anilistID := int32(job.Args.AnilistID)
	bgmID := job.Args.BgmID

	// Bound the worker's total time budget.  Caps Subject + UPDATE
	// together; an individual call being slow shouldn't tie up a
	// worker slot forever.
	ctx, cancel := context.WithTimeout(ctx, v3WorkTimeout)
	defer cancel()

	// 1. Fetch Subject.  ErrNotFound is a SOFT failure — we still
	//    bump version=3 (heal attempt complete) and write NULL.
	subj, err := w.bangumi.Subject(ctx, bgmID)
	if err != nil && !errors.Is(err, bangumi.ErrNotFound) {
		// Transient (network / 5xx / decode failure).  Surface so
		// river retries the whole job per its policy.
		return fmt.Errorf("bangumi_v3 subject %d (bgmId=%d): %w", anilistID, bgmID, err)
	}

	// 2. Decide titleChinese.  Subject.NameCN may be empty even on a
	//    successful fetch (Bangumi has no Chinese name for this
	//    subject), in which case we pass nil so UpdateBangumiV3
	//    writes NULL.  When subj itself is nil (ErrNotFound), we also
	//    pass nil.
	var titleChinese *string
	if subj != nil && subj.NameCN != "" {
		cn := subj.NameCN
		titleChinese = &cn
	}

	// 3. Persist.  UpdateBangumiV3 always bumps bangumi_version=3 —
	//    the column write itself is unconditional (V3 SQL doesn't use
	//    COALESCE), so a nil titleChinese here means the column ends
	//    up NULL.  Any DB error is transient; river retries.
	if err := w.db.UpdateBangumiV3(ctx, anilistID, titleChinese); err != nil {
		return fmt.Errorf("bangumi_v3 update %d (bgmId=%d): %w", anilistID, bgmID, err)
	}

	// 4. Logging.  Two distinct lines so dashboards can chart "v3 no
	//    subject" vs "v3 completed with/without CN" separately.
	if subj == nil {
		slog.InfoContext(ctx, "bangumi_v3 no_subject",
			"anilistId", anilistID,
			"bgmId", bgmID)
		return nil
	}
	slog.InfoContext(ctx, "bangumi_v3 done",
		"anilistId", anilistID,
		"bgmId", bgmID,
		"hasChinese", titleChinese != nil)
	return nil
}
