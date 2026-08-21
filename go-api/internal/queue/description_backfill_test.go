// description_backfill_test.go — unit tests for the P3 存量回填 sweep.
//
// Two workers under test, no real DB and no real Bangumi HTTP server:
//
//   - DescriptionBackfillScanWorker — reads the candidate list and turns
//     each row into one DescriptionBackfillArgs.  Tests cover the row →
//     args mapping, the batch ceiling handed to the query, the empty
//     (i.e. "sweep finished") steady state, reader failure, and the
//     NULL-bgm_id row that must be skipped rather than dereferenced.
//
//   - DescriptionBackfillWorker — fetches one Subject and writes at most
//     description_cn.  Tests cover the usable-Chinese happy path, the two
//     rejection paths (Japanese original, empty), 404 vs transient
//     upstream failure, and — the one that actually matters — the
//     assertion that NO other enrichment column is ever touched.
//
// Why that last one carries the most weight: this sweep runs over rows
// that are already at bangumi_version=3 and whose title_chinese may have
// come from dandanplay heal, which is more accurate than bgm's name_cn on
// some entries.  A worker that reused V3 (or bumped the version) would
// silently regress those titles across the whole back catalogue, and
// nothing else in the pipeline would notice.  fakeBackfillDB therefore
// exposes the FULL enrichment write surface — far wider than the worker's
// own dependency — precisely so a future widening of that dependency gets
// caught here instead of in production.
//
// In-package so the batch constant, the ptr[T] helper (bangumi_v1_test.go),
// the Chinese summary fixture (bangumi_v2_test.go) and fakeBangumiV3
// (bangumi_v3_test.go) are all reachable without widening the export
// surface.
package queue

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/riverqueue/river"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/bangumi"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// testSummaryMushokuJP is the real bgm.tv summary for 無職転生 (Mushoku
// Tensei) — the untranslated Japanese original, which is the shape ~37% of
// the rows this sweep visits will come back in.  Kept verbatim rather than
// synthesised so the language gate is exercised against text that actually
// exists upstream: it is long enough to clear the 40-rune floor, so the ONLY
// thing standing between it and the database is CleanSummary's kana ratio.
//
// A synthetic short Japanese string would have been rejected on length and
// the test would have passed while proving nothing.
const testSummaryMushokuJP = "「俺は、この異世界で本気だす！」34歳・童貞・無職の引きこもりニート男。" +
	"人生を全否定されて自殺しようとしたところ、トラックに轢かれて死んでしまう。" +
	"目覚めるとそこは、剣と魔法の異世界だった。赤ん坊のルーデウス・グレイラットとして" +
	"生まれ変わった彼は、前世の後悔を胸に「今度こそ本気で生きよう」と決意する。"

// ---------------------------------------------------------------------------
// Test doubles — scan side
// ---------------------------------------------------------------------------

// fakeCandidateReader is a programmable stand-in for the sqlc candidate
// query.  Every call's limit is recorded because the batch ceiling is a
// rate-safety property, not a detail: the sweep shares one token bucket
// with live enrichment, so a limit that quietly grows starves page loads.
type fakeCandidateReader struct {
	mu sync.Mutex

	listFn func(ctx context.Context, retryAfter pgtype.Interval, rowLimit int32) ([]dbgen.ListDescriptionCnCandidatesRow, error)

	limits      []int32
	retryAfters []pgtype.Interval
}

func (f *fakeCandidateReader) ListDescriptionCnCandidates(ctx context.Context, retryAfter pgtype.Interval, rowLimit int32) ([]dbgen.ListDescriptionCnCandidatesRow, error) {
	f.mu.Lock()
	f.limits = append(f.limits, rowLimit)
	f.retryAfters = append(f.retryAfters, retryAfter)
	fn := f.listFn
	f.mu.Unlock()
	if fn == nil {
		return []dbgen.ListDescriptionCnCandidatesRow{}, nil
	}
	return fn(ctx, retryAfter, rowLimit)
}

// snapshotRetryAfters returns the cooldown bounds the scan passed down. The
// sweep cannot finish without one — an unbounded candidate query lets rows the
// language gate rejected hold the front of every batch forever.
func (f *fakeCandidateReader) snapshotRetryAfters() []pgtype.Interval {
	f.mu.Lock()
	defer f.mu.Unlock()
	dup := make([]pgtype.Interval, len(f.retryAfters))
	copy(dup, f.retryAfters)
	return dup
}

func (f *fakeCandidateReader) snapshotLimits() []int32 {
	f.mu.Lock()
	defer f.mu.Unlock()
	dup := make([]int32, len(f.limits))
	copy(dup, f.limits)
	return dup
}

// fakeBackfillEnqueuer implements the whole Enqueuer surface but only
// records the backfill batches.  The V1/V2/V3/warm methods are counted too
// so a scan worker that reached for the wrong chain would be caught rather
// than silently no-op'ing.
type fakeBackfillEnqueuer struct {
	mu sync.Mutex

	enqueueFn func(ctx context.Context, jobs []DescriptionBackfillArgs) error

	batches    [][]DescriptionBackfillArgs
	otherCalls int
}

func (f *fakeBackfillEnqueuer) EnqueueDescriptionLlmBackfillMany(_ context.Context, _ []DescriptionLlmBackfillArgs) error {
	return nil
}

func (f *fakeBackfillEnqueuer) EnqueueDescriptionBackfillMany(ctx context.Context, jobs []DescriptionBackfillArgs) error {
	dup := make([]DescriptionBackfillArgs, len(jobs))
	copy(dup, jobs)
	f.mu.Lock()
	f.batches = append(f.batches, dup)
	fn := f.enqueueFn
	f.mu.Unlock()
	if fn == nil {
		return nil
	}
	return fn(ctx, jobs)
}

func (f *fakeBackfillEnqueuer) EnqueueV1Many(_ context.Context, _ []int32) error {
	f.bumpOther()
	return nil
}

func (f *fakeBackfillEnqueuer) EnqueueV2Many(_ context.Context, _ []BangumiV2Args) error {
	f.bumpOther()
	return nil
}

func (f *fakeBackfillEnqueuer) EnqueueV3Many(_ context.Context, _ []BangumiV3Args) error {
	f.bumpOther()
	return nil
}

func (f *fakeBackfillEnqueuer) EnqueueWarmSeasonNow(_ context.Context, _ WarmSeasonArgs) error {
	f.bumpOther()
	return nil
}

// EnqueueHantBackfillNow is a no-op stub: nothing in this test
// touches the zh-Hant sweep, and reporting "inserted" would be a lie
// no assertion here is watching for.
func (f *fakeBackfillEnqueuer) EnqueueHantBackfillNow(_ context.Context) (bool, error) {
	return false, nil
}

func (f *fakeBackfillEnqueuer) bumpOther() {
	f.mu.Lock()
	f.otherCalls++
	f.mu.Unlock()
}

// flatten returns every enqueued arg across all batches, so assertions stay
// valid whether the worker sends one InsertMany or one call per row.
func (f *fakeBackfillEnqueuer) flatten() []DescriptionBackfillArgs {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []DescriptionBackfillArgs
	for _, b := range f.batches {
		out = append(out, b...)
	}
	return out
}

func (f *fakeBackfillEnqueuer) batchCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.batches)
}

func (f *fakeBackfillEnqueuer) otherChainCalls() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.otherCalls
}

// ---------------------------------------------------------------------------
// Test doubles — write side
// ---------------------------------------------------------------------------

// backfillDescCall snapshots one UpdateDescriptionCn invocation.
type backfillDescCall struct {
	anilistID     int32
	descriptionCn *string
	bgmID         *int32
}

// fakeBackfillDB records the description write AND every OTHER enrichment
// write, so "the sweep touched nothing else" is an assertion rather than an
// assumption.  It deliberately implements a wider surface than the worker
// depends on: if somebody later widens that dependency to reuse a V2/V3
// helper, these counters make the regression visible immediately.
type fakeBackfillDB struct {
	mu sync.Mutex

	updateDescCnFn func(ctx context.Context, c backfillDescCall) error

	descCalls []backfillDescCall

	// attemptStamps records MarkDescriptionCnAttempted calls. Stamping is what
	// lets the sweep move past rows the language gate rejects, so "was it
	// stamped" is a behaviour worth asserting, not just plumbing.
	attemptStamps  []int32
	markAttemptErr error

	// Forbidden surface — every one of these must stay at zero.
	v2Calls   int
	v3Calls   int
	charCalls int
	epCalls   int
}

func (f *fakeBackfillDB) MarkDescriptionCnAttempted(_ context.Context, anilistID int32) error {
	f.mu.Lock()
	f.attemptStamps = append(f.attemptStamps, anilistID)
	err := f.markAttemptErr
	f.mu.Unlock()
	return err
}

func (f *fakeBackfillDB) snapshotAttemptStamps() []int32 {
	f.mu.Lock()
	defer f.mu.Unlock()
	dup := make([]int32, len(f.attemptStamps))
	copy(dup, f.attemptStamps)
	return dup
}

func (f *fakeBackfillDB) UpdateDescriptionCn(ctx context.Context, descriptionCn *string, anilistID int32, bgmID *int32) error {
	call := backfillDescCall{anilistID: anilistID, descriptionCn: descriptionCn, bgmID: bgmID}
	f.mu.Lock()
	f.descCalls = append(f.descCalls, call)
	fn := f.updateDescCnFn
	f.mu.Unlock()
	if fn == nil {
		return nil
	}
	return fn(ctx, call)
}

func (f *fakeBackfillDB) UpdateBangumiV2(_ context.Context, _ int32, _ *float64, _ *int32, _ *string) error {
	f.mu.Lock()
	f.v2Calls++
	f.mu.Unlock()
	return nil
}

func (f *fakeBackfillDB) UpdateBangumiV3(_ context.Context, _ int32, _ *string) error {
	f.mu.Lock()
	f.v3Calls++
	f.mu.Unlock()
	return nil
}

func (f *fakeBackfillDB) UpdateAnimeCharacterCN(_ context.Context, _ int32, _ *string, _ *string, _ *string, _ *string) error {
	f.mu.Lock()
	f.charCalls++
	f.mu.Unlock()
	return nil
}

func (f *fakeBackfillDB) UpsertEpisodeTitle(_ context.Context, _ int32, _ int32, _ *string, _ *string) error {
	f.mu.Lock()
	f.epCalls++
	f.mu.Unlock()
	return nil
}

func (f *fakeBackfillDB) snapshotDescCalls() []backfillDescCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	dup := make([]backfillDescCall, len(f.descCalls))
	copy(dup, f.descCalls)
	return dup
}

// assertEnrichmentStateUntouched is the guard the whole P3 design rests on:
// the sweep may fill description_cn and nothing else.  Bumping
// bangumi_version would re-open rows the pipeline has already finished with,
// and writing title_chinese would overwrite dandanplay-healed titles that
// are known to beat bgm's name_cn.
func (f *fakeBackfillDB) assertEnrichmentStateUntouched(t *testing.T) {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	assert.Zero(t, f.v2Calls, "backfill must never call UpdateBangumiV2 (would rewrite score/votes/title)")
	assert.Zero(t, f.v3Calls, "backfill must never call UpdateBangumiV3 (would overwrite dandanplay title_chinese and bump bangumi_version)")
	assert.Zero(t, f.charCalls, "backfill must never rewrite character rows")
	assert.Zero(t, f.epCalls, "backfill must never rewrite episode titles")
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// candidateRow builds one candidate as the sqlc query returns it.
func candidateRow(anilistID int32, bgmID *int32) dbgen.ListDescriptionCnCandidatesRow {
	return dbgen.ListDescriptionCnCandidatesRow{AnilistID: anilistID, BgmID: bgmID}
}

// runBackfillScan dispatches the periodic scan through Work().
func runBackfillScan(t *testing.T, db *fakeCandidateReader, enq DescriptionBackfillEnqueuer) error {
	t.Helper()
	w := NewDescriptionBackfillScanWorker(db, enq)
	return w.Work(t.Context(), &river.Job[DescriptionBackfillScanArgs]{
		Args: DescriptionBackfillScanArgs{},
	})
}

// runBackfill dispatches one per-row backfill job through Work().
func runBackfill(t *testing.T, b BangumiSubjector, db *fakeBackfillDB, anilistID, bgmID int) error {
	t.Helper()
	w := NewDescriptionBackfillWorker(b, db)
	return w.Work(t.Context(), &river.Job[DescriptionBackfillArgs]{
		Args: DescriptionBackfillArgs{AnilistID: anilistID, BgmID: bgmID},
	})
}

// subjectWithSummary returns a Subject double whose Summary is fixed.  NameCN
// is populated on purpose: the sweep must ignore it, and a fake that left it
// empty could not tell "ignored it" from "there was nothing to write".
func subjectWithSummary(summary string) *fakeBangumiV3 {
	return &fakeBangumiV3{
		subjectFn: func(_ context.Context, bgmID int) (*bangumi.Subject, error) {
			return &bangumi.Subject{ID: bgmID, Name: "無職転生", NameCN: "无职转生", Summary: summary}, nil
		},
	}
}

// ---------------------------------------------------------------------------
// Batch ceiling
// ---------------------------------------------------------------------------

// TestDescriptionBackfillBatchSize_Is300 pins the per-pass ceiling.
//
// This is a rate-limit guard wearing a constant's clothes.  Every candidate
// becomes one Bangumi request drawn from the same process-wide token bucket
// that live V1/V2/V3 enrichment uses; 300 per pass is the figure the sweep
// was sized against.  Raising it does not make the backfill finish sooner —
// the bucket is the bottleneck, not the queue — it just pushes page-driven
// enrichment behind a longer backlog and leans harder on a UA whitelist
// that is not worth gambling.
func TestDescriptionBackfillBatchSize_Is300(t *testing.T) {
	t.Parallel()

	assert.Equal(t, int32(300), descriptionBackfillScanBatchSize,
		"the sweep's per-pass ceiling must stay at 300 — see the rate-safety note above")
}

// TestDescriptionBackfillScanInterval_IsHourly pins the cadence, which is the
// other half of the same rate decision: 300 rows an hour is what makes the
// sweep a background tenant of the shared token bucket rather than its main
// consumer.  Batch size and interval only mean anything as a pair.
func TestDescriptionBackfillScanInterval_IsHourly(t *testing.T) {
	t.Parallel()

	assert.Equal(t, time.Hour, descriptionBackfillScanInterval,
		"the sweep fires hourly; changing this changes the upstream request rate")
}

// ---------------------------------------------------------------------------
// Scan worker
// ---------------------------------------------------------------------------

// TestDescriptionBackfillScan_EnqueuesCandidates — the row → args mapping.
// Each candidate must arrive as its own job carrying BOTH ids, because the
// write is pinned to (anilist_id, bgm_id): losing the binding would let a
// rebind file one show's synopsis against another.
func TestDescriptionBackfillScan_EnqueuesCandidates(t *testing.T) {
	t.Parallel()

	db := &fakeCandidateReader{
		listFn: func(_ context.Context, _ pgtype.Interval, _ int32) ([]dbgen.ListDescriptionCnCandidatesRow, error) {
			return []dbgen.ListDescriptionCnCandidatesRow{
				candidateRow(101, ptr(int32(9001))),
				candidateRow(102, ptr(int32(9002))),
				candidateRow(103, ptr(int32(9003))),
			}, nil
		},
	}
	enq := &fakeBackfillEnqueuer{}

	require.NoError(t, runBackfillScan(t, db, enq))

	got := enq.flatten()
	require.Len(t, got, 3, "one job per candidate row")
	assert.Equal(t, []DescriptionBackfillArgs{
		{AnilistID: 101, BgmID: 9001},
		{AnilistID: 102, BgmID: 9002},
		{AnilistID: 103, BgmID: 9003},
	}, got, "anilistId/bgmId must pair up exactly as the query returned them")

	assert.Equal(t, 1, enq.batchCount(),
		"one InsertMany per pass — 300 individual inserts an hour would be 300 round-trips for no benefit")

	assert.Zero(t, enq.otherChainCalls(),
		"the sweep must not touch the V1/V2/V3 chain")
}

// TestDescriptionBackfillScan_UsesBatchLimit — the query is called with the
// batch ceiling and nothing else.  Asserted against a literal 300 (not the
// constant) so that renaming or re-deriving the constant cannot make this
// test agree with a changed value.
func TestDescriptionBackfillScan_UsesBatchLimit(t *testing.T) {
	t.Parallel()

	db := &fakeCandidateReader{}
	enq := &fakeBackfillEnqueuer{}

	require.NoError(t, runBackfillScan(t, db, enq))

	limits := db.snapshotLimits()
	require.NotEmpty(t, limits, "the scan must actually query for candidates")
	for i, l := range limits {
		assert.Equal(t, int32(300), l,
			"call %d asked for %d rows — the sweep's ceiling is 300 per pass", i, l)
	}
}

// TestDescriptionBackfillScan_NoCandidates_IsNoop — the終点 state.  Once the
// backlog is drained every pass returns zero rows forever, so "empty" has to
// be an ordinary success: no error (which would show up as a permanently
// failing periodic job) and no enqueue.
func TestDescriptionBackfillScan_NoCandidates_IsNoop(t *testing.T) {
	t.Parallel()

	db := &fakeCandidateReader{
		listFn: func(_ context.Context, _ pgtype.Interval, _ int32) ([]dbgen.ListDescriptionCnCandidatesRow, error) {
			return []dbgen.ListDescriptionCnCandidatesRow{}, nil
		},
	}
	enq := &fakeBackfillEnqueuer{}

	require.NoError(t, runBackfillScan(t, db, enq),
		"an exhausted backlog is the steady state, not a failure")
	assert.Zero(t, enq.batchCount(), "nothing to enqueue → no enqueue call at all")
}

// TestDescriptionBackfillScan_ReaderError_Retries — a DB failure must surface
// so river retries the pass.  Swallowing it would leave the sweep looking
// healthy while making no progress.
func TestDescriptionBackfillScan_ReaderError_Retries(t *testing.T) {
	t.Parallel()

	dbErr := errors.New("simulated postgres failure")
	db := &fakeCandidateReader{
		listFn: func(_ context.Context, _ pgtype.Interval, _ int32) ([]dbgen.ListDescriptionCnCandidatesRow, error) {
			return nil, dbErr
		},
	}
	enq := &fakeBackfillEnqueuer{}

	err := runBackfillScan(t, db, enq)
	require.Error(t, err, "reader error must surface for river retry")
	assert.ErrorIs(t, err, dbErr, "the root cause must stay unwrappable")
	assert.Zero(t, enq.batchCount(), "failed read → nothing enqueued")
}

// TestDescriptionBackfillScan_NilBgmID_Skipped — bgm_id is a nullable column
// and the row type carries *int32.  The query filters NULLs out today, but
// the worker still owns the dereference: a schema or query change that let
// one through must degrade to "skip that row", never to a nil-pointer panic
// that kills the whole pass (and with it the other 299 rows).
func TestDescriptionBackfillScan_NilBgmID_Skipped(t *testing.T) {
	t.Parallel()

	db := &fakeCandidateReader{
		listFn: func(_ context.Context, _ pgtype.Interval, _ int32) ([]dbgen.ListDescriptionCnCandidatesRow, error) {
			return []dbgen.ListDescriptionCnCandidatesRow{
				candidateRow(201, ptr(int32(7001))),
				candidateRow(202, nil), // must not panic, must not enqueue
				candidateRow(203, ptr(int32(7003))),
			}, nil
		},
	}
	enq := &fakeBackfillEnqueuer{}

	var err error
	require.NotPanics(t, func() { err = runBackfillScan(t, db, enq) },
		"a NULL bgm_id must never panic the sweep")
	require.NoError(t, err)

	got := enq.flatten()
	require.Len(t, got, 2, "the NULL-bgm_id row is skipped, its neighbours are not")
	assert.Equal(t, []DescriptionBackfillArgs{
		{AnilistID: 201, BgmID: 7001},
		{AnilistID: 203, BgmID: 7003},
	}, got, "a skipped row must not shift or drop the rows around it")
}

// TestDescriptionBackfillScan_AllNilBgmID_WarnsAndSkipsEnqueue covers the
// branch where EVERY row in a batch was unusable — a different code path
// from "some rows were", and the one that actually indicates the query and
// the worker have drifted apart.
//
// Two properties matter.  It must not call the enqueuer with an empty slice
// (a pointless round-trip that river would have to reject), and unlike the
// ordinary empty-backlog case it MUST warn: zero candidates means the sweep
// finished, but 300 candidates that all turn into zero jobs means something
// is broken and needs to look different in the log.
//
// NOT t.Parallel — asserts on slog.Default, which is process-global.
func TestDescriptionBackfillScan_AllNilBgmID_WarnsAndSkipsEnqueue(t *testing.T) {
	original := slog.Default()
	t.Cleanup(func() { slog.SetDefault(original) })

	buf := &bytes.Buffer{}
	slog.SetDefault(slog.New(slog.NewTextHandler(buf, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	})))

	db := &fakeCandidateReader{
		listFn: func(_ context.Context, _ pgtype.Interval, _ int32) ([]dbgen.ListDescriptionCnCandidatesRow, error) {
			return []dbgen.ListDescriptionCnCandidatesRow{
				candidateRow(501, nil),
				candidateRow(502, nil),
			}, nil
		},
	}
	enq := &fakeBackfillEnqueuer{}

	require.NoError(t, runBackfillScan(t, db, enq),
		"a batch of unusable rows is a data problem, not a job failure — erroring would just retry it")
	assert.Zero(t, enq.batchCount(),
		"nothing usable → the enqueuer must not be called at all, not called with an empty slice")

	out := buf.String()
	assert.Contains(t, out, "level=WARN",
		"candidates that all fail the nil check mean the query and the worker have drifted — that must be loud")
	assert.Contains(t, out, "skippedNoBgmId=2",
		"the warn line must report how many rows were dropped, or the drift is invisible")
}

// TestDescriptionBackfillScan_ReoffersUnwritableRowsEveryPass documents the
// sweep's one genuinely uncomfortable property, stated as behaviour rather
// than as a comment: the worker keeps no memory of what it has already tried.
//
// A row whose summary fails the language gate keeps description_cn NULL, so
// it stays a candidate; the query orders by anilist_id, so that residue sits
// at the FRONT of every later pass and is handed back first.  At the measured
// ~37% rejection rate the residue converges on the whole 300-row batch and
// the sweep stops reaching new rows — a hard ceiling of roughly p*B/(1-p)
// rows written EVER, not a slow drain.  See the file header of
// description_backfill.go for the closed form.
//
// What that stall does NOT do is burn the upstream budget, and it is worth
// being precise about why, because the intuitive reading is wrong.  The scan
// re-offers the residue every hour, but DescriptionBackfillArgs carries
// UniqueOpts{ByArgs} and river's DEFAULT unique state set includes
// `completed` — so a residue row whose job completed less than
// CompletedJobRetentionPeriod ago (24h by default, not overridden in Boot)
// is skipped at insert time and never reaches Bangumi.  The waste is one
// deduplicated InsertMany per hour, and ~B re-fetches per DAY once the
// cleaner starts dropping completed rows.  Cheap — which is exactly what
// makes the stall dangerous, because nothing will ever page anyone about it.
//
// This test asserts the WORKER's contract (identical input → identical
// output, no in-process skip list) rather than river's dedupe, because an
// in-memory skip list would be the WRONG fix — it dies with every deploy and
// diverges per replica.  The durable fix is in the schema: an attempted
// marker the candidate query excludes on.  Until that lands, this test and
// TestDescriptionBackfillArgs_UniqueStateIncludesCompleted are where the
// cost is written down.
func TestDescriptionBackfillScan_ReoffersUnwritableRowsEveryPass(t *testing.T) {
	t.Parallel()

	residue := []dbgen.ListDescriptionCnCandidatesRow{
		candidateRow(401, ptr(int32(5001))),
		candidateRow(402, ptr(int32(5002))),
	}
	db := &fakeCandidateReader{
		listFn: func(_ context.Context, _ pgtype.Interval, _ int32) ([]dbgen.ListDescriptionCnCandidatesRow, error) {
			return residue, nil
		},
	}
	enq := &fakeBackfillEnqueuer{}

	require.NoError(t, runBackfillScan(t, db, enq))
	require.NoError(t, runBackfillScan(t, db, enq))

	assert.Len(t, enq.flatten(), 4,
		"the sweep re-offers rows it could not write; progress depends on the query, not on worker memory")
}

// TestDescriptionBackfillScan_EnqueueError_Retries — river insert failures
// surface the same way DB read failures do.
func TestDescriptionBackfillScan_EnqueueError_Retries(t *testing.T) {
	t.Parallel()

	enqErr := errors.New("simulated river failure")
	db := &fakeCandidateReader{
		listFn: func(_ context.Context, _ pgtype.Interval, _ int32) ([]dbgen.ListDescriptionCnCandidatesRow, error) {
			return []dbgen.ListDescriptionCnCandidatesRow{candidateRow(301, ptr(int32(6001)))}, nil
		},
	}
	enq := &fakeBackfillEnqueuer{
		enqueueFn: func(_ context.Context, _ []DescriptionBackfillArgs) error { return enqErr },
	}

	err := runBackfillScan(t, db, enq)
	require.Error(t, err, "enqueue error must surface for river retry")
	assert.ErrorIs(t, err, enqErr)
}

// TestNewDescriptionBackfillScanWorker_NilEnqueuer_FailsLoudly pins a
// deliberate divergence from NewOrphanScanWorker, which swaps a nil enqueuer
// for NoopEnqueuer{}.
//
// This worker does not, because the two failure modes are not comparable: a
// silently no-op'ing sweep produces exactly the log line a FINISHED backfill
// produces, so a mis-wired enqueuer could go unnoticed indefinitely while
// coverage sat still.  Crashing the job is recoverable (river catches worker
// panics, marks the job errored and retries) and, unlike silence, it is
// visible.  Construction itself must stay safe so boot-order bugs surface at
// dispatch rather than at wiring time.
func TestNewDescriptionBackfillScanWorker_NilEnqueuer_FailsLoudly(t *testing.T) {
	t.Parallel()

	db := &fakeCandidateReader{
		listFn: func(_ context.Context, _ pgtype.Interval, _ int32) ([]dbgen.ListDescriptionCnCandidatesRow, error) {
			return []dbgen.ListDescriptionCnCandidatesRow{candidateRow(1, ptr(int32(2)))}, nil
		},
	}

	var w *DescriptionBackfillScanWorker
	require.NotPanics(t, func() { w = NewDescriptionBackfillScanWorker(db, nil) },
		"construction must not panic — main.go builds workers before river is bound")
	require.NotNil(t, w)

	assert.Panics(t, func() {
		_ = w.Work(t.Context(), &river.Job[DescriptionBackfillScanArgs]{
			Args: DescriptionBackfillScanArgs{},
		})
	}, "a nil enqueuer must fail loudly rather than mimic a completed backfill")
}

// ---------------------------------------------------------------------------
// Backfill worker — the write path
// ---------------------------------------------------------------------------

// TestDescriptionBackfill_ChineseSummary_WritesOnce — the happy path: one
// Subject fetch, one description write, the cleaned text, and the binding
// pinned by bgm_id.
func TestDescriptionBackfill_ChineseSummary_WritesOnce(t *testing.T) {
	t.Parallel()

	b := subjectWithSummary(testSummaryChinese)
	db := &fakeBackfillDB{}

	require.NoError(t, runBackfill(t, b, db, 1234, 9999))

	calls := db.snapshotDescCalls()
	require.Len(t, calls, 1, "exactly one UpdateDescriptionCn — never a retry loop within one job")
	assert.Equal(t, int32(1234), calls[0].anilistID)
	require.NotNil(t, calls[0].descriptionCn)
	assert.Equal(t, testSummaryChinese, *calls[0].descriptionCn,
		"the CLEANED text is what gets stored")
	require.NotNil(t, calls[0].bgmID, "bgmId must be sent so the SQL can pin the binding")
	assert.Equal(t, int32(9999), *calls[0].bgmID)

	assert.Equal(t, 1, b.subjectCalls, "one row costs exactly one upstream request")
	db.assertEnrichmentStateUntouched(t)
}

// TestDescriptionBackfill_DividerSummary_StoresOnlyChinese — shape 2 from
// bangumi/summary.go: Chinese prose with the Japanese original appended after
// a [简介原文] divider.  Storing the raw text would render a Chinese paragraph
// trailed by an untranslated Japanese one.
func TestDescriptionBackfill_DividerSummary_StoresOnlyChinese(t *testing.T) {
	t.Parallel()

	b := subjectWithSummary(testSummaryChinese + "\n\n[简介原文]\n" + testSummaryMushokuJP)
	db := &fakeBackfillDB{}

	require.NoError(t, runBackfill(t, b, db, 1234, 9999))

	calls := db.snapshotDescCalls()
	require.Len(t, calls, 1)
	require.NotNil(t, calls[0].descriptionCn)
	assert.Equal(t, testSummaryChinese, *calls[0].descriptionCn,
		"everything from the divider on must be dropped before storing")
}

// TestDescriptionBackfill_JapaneseSummary_NeverWrites — the single most
// important rejection.  Roughly 37% of the rows this sweep visits come back
// as the untranslated original; storing those would swap an English
// description the reader cannot read for a Japanese one they equally cannot
// read, across thousands of rows, with no signal that anything went wrong.
//
// The fixture is asserted against CleanSummary directly first, so that a
// future fixture edit cannot accidentally turn this into a length-rejection
// test that passes for the wrong reason.
func TestDescriptionBackfill_JapaneseSummary_NeverWrites(t *testing.T) {
	t.Parallel()

	// Fixture self-check: rejected for being Japanese, not for being short.
	require.GreaterOrEqual(t, len([]rune(testSummaryMushokuJP)), 40,
		"fixture must clear the 40-rune floor so the LANGUAGE gate is what rejects it")
	_, ok := bangumi.CleanSummary(testSummaryMushokuJP)
	require.False(t, ok, "fixture must be rejected by the language gate")

	b := subjectWithSummary(testSummaryMushokuJP)
	db := &fakeBackfillDB{}

	require.NoError(t, runBackfill(t, b, db, 1234, 9999),
		"an unusable summary is a normal outcome, never a job failure")
	assert.Empty(t, db.snapshotDescCalls(),
		"the Japanese original must never reach the database, not even once")
	db.assertEnrichmentStateUntouched(t)
}

// TestDescriptionBackfill_UnusableSummary_NoWrite — the remaining rejection
// shapes from the prod sample, table-driven.  All of them must leave the row
// exactly as it was and still complete the job.
func TestDescriptionBackfill_UnusableSummary_NoWrite(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name    string
		summary string
	}{
		{"empty", ""},
		{"whitespace only", "   \n\t  "},
		{"too short placeholder", "待补充"},
		{"japanese original", testSummaryMushokuJP},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			b := subjectWithSummary(tc.summary)
			db := &fakeBackfillDB{}

			require.NoError(t, runBackfill(t, b, db, 1, 100))
			assert.Empty(t, db.snapshotDescCalls(),
				"unusable summary → zero writes, the row keeps its English fallback")
			db.assertEnrichmentStateUntouched(t)
		})
	}
}

// TestDescriptionBackfill_SubjectNotFound_IsPermanentSkip — a 404 means
// Bangumi has no such subject.  Retrying cannot change that, so the job must
// end successfully rather than burn its retry budget (and three more
// requests from the shared bucket) on a certainty.
func TestDescriptionBackfill_SubjectNotFound_IsPermanentSkip(t *testing.T) {
	t.Parallel()

	b := &fakeBangumiV3{
		subjectFn: func(_ context.Context, _ int) (*bangumi.Subject, error) {
			return nil, bangumi.ErrNotFound
		},
	}
	db := &fakeBackfillDB{}

	require.NoError(t, runBackfill(t, b, db, 1234, 9999),
		"404 is permanent — returning an error would retry a guaranteed failure")
	assert.Empty(t, db.snapshotDescCalls(), "no subject → nothing to write")
	db.assertEnrichmentStateUntouched(t)
}

// TestDescriptionBackfill_TransientUpstreamError_Retries — a 5xx / transport
// failure is temporary, so it must surface and let river retry.
//
// Unlike the swallowed-write case above, the recovery story here really does
// hold: a job that exhausts its retries ends in `discarded`, and `discarded`
// is NOT one of river's default unique states, so the next scan can re-insert
// the row immediately.  Erroring out is therefore strictly better than
// swallowing — it gets river's backoff now AND leaves the hourly sweep as a
// backstop.
func TestDescriptionBackfill_TransientUpstreamError_Retries(t *testing.T) {
	t.Parallel()

	upstream := &bangumi.ErrUpstream{Status: 503, Message: "Bangumi API error"}
	b := &fakeBangumiV3{
		subjectFn: func(_ context.Context, _ int) (*bangumi.Subject, error) {
			return nil, upstream
		},
	}
	db := &fakeBackfillDB{}

	err := runBackfill(t, b, db, 1234, 9999)
	require.Error(t, err, "503 must surface for river retry")
	assert.ErrorIs(t, err, upstream, "the upstream error must stay unwrappable")
	assert.Empty(t, db.snapshotDescCalls(), "failed fetch → no write")
	db.assertEnrichmentStateUntouched(t)
}

// TestDescriptionBackfill_ContextCanceled_NoWrite — shutdown mid-job must not
// half-write.
func TestDescriptionBackfill_ContextCanceled_NoWrite(t *testing.T) {
	t.Parallel()

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	b := &fakeBangumiV3{
		subjectFn: func(c context.Context, _ int) (*bangumi.Subject, error) {
			return nil, c.Err()
		},
	}
	db := &fakeBackfillDB{}

	w := NewDescriptionBackfillWorker(b, db)
	err := w.Work(ctx, &river.Job[DescriptionBackfillArgs]{
		Args: DescriptionBackfillArgs{AnilistID: 1, BgmID: 2},
	})
	require.Error(t, err, "canceled ctx must surface")
	assert.ErrorIs(t, err, context.Canceled)
	assert.Empty(t, db.snapshotDescCalls(), "canceled ctx → no write")
	db.assertEnrichmentStateUntouched(t)
}

// TestDescriptionBackfill_NeverTouchesEnrichmentState — the guard the whole
// design rests on, stated once on its own rather than only as a rider on the
// other tests.
//
// Every row this sweep visits is already at bangumi_version=3 and finished.
// Some of them carry a title_chinese healed from dandanplay, which is more
// accurate than bgm's name_cn.  A worker that reused BangumiV3Worker would
// overwrite exactly those titles — unconditionally, that being V3's whole
// purpose — and re-open thousands of settled rows.  The dependency is narrow
// by design; this asserts the behaviour so a future widening has to defeat a
// failing test rather than a comment.
func TestDescriptionBackfill_NeverTouchesEnrichmentState(t *testing.T) {
	t.Parallel()

	// Subject carries a Chinese title AND score data — everything a V2/V3
	// worker would jump at writing.  The sweep must want none of it.
	b := &fakeBangumiV3{
		subjectFn: func(_ context.Context, bgmID int) (*bangumi.Subject, error) {
			s := makeSubject(bgmID, "无职转生（bgm 版，绝不能覆盖 dandanplay 的标题）", 8.4, 12345)
			s.Summary = testSummaryChinese
			return s, nil
		},
	}
	db := &fakeBackfillDB{}

	require.NoError(t, runBackfill(t, b, db, 1234, 9999))

	require.Len(t, db.snapshotDescCalls(), 1, "description_cn is the ONLY column this sweep may write")
	db.assertEnrichmentStateUntouched(t)
}

// TestDescriptionBackfill_WriteError_DoesNotFailJob — persistDescriptionCn
// warns and swallows a failed write, so the job still completes.
//
// The usual justification for swallowing ("the row is still NULL, the next
// scan picks it up") is NOT quite true here and the difference is worth
// writing down.  The job completes, and river's default unique state set
// includes `completed`, so the next hourly scan will re-offer this row and
// river will skip the insert as a duplicate.  Recovery therefore waits for
// the job cleaner to drop the completed row — up to CompletedJobRetentionPeriod,
// 24h by default — rather than arriving an hour later.
//
// That is still the right trade (a description is optional, and returning an
// error would re-spend an upstream request on a database that just failed),
// but it means a Postgres blip during the sweep costs a day of progress on
// the affected rows, not an hour.  Asserted here so the next person to read
// "does not fail job" does not infer a faster recovery than exists.
func TestDescriptionBackfill_WriteError_DoesNotFailJob(t *testing.T) {
	t.Parallel()

	b := subjectWithSummary(testSummaryChinese)
	db := &fakeBackfillDB{
		updateDescCnFn: func(_ context.Context, _ backfillDescCall) error {
			return errors.New("description_cn write blew up")
		},
	}

	var err error
	require.NotPanics(t, func() { err = runBackfill(t, b, db, 1234, 9999) })
	require.NoError(t, err,
		"a failed write is recovered by the next scan — retrying costs an upstream request for nothing")
	assert.Len(t, db.snapshotDescCalls(), 1, "the write was attempted exactly once")
}

// TestDescriptionBackfill_ZeroRowsWritten_IsNotAnError — UpdateDescriptionCn
// carries the trust gate in its WHERE clause, so a row that has since been
// rebound (or manually described) updates nothing and returns nil.  That is
// the designed outcome, not a failure to detect.
func TestDescriptionBackfill_ZeroRowsWritten_IsNotAnError(t *testing.T) {
	t.Parallel()

	b := subjectWithSummary(testSummaryChinese)
	db := &fakeBackfillDB{
		updateDescCnFn: func(_ context.Context, _ backfillDescCall) error {
			return nil // sqlc :exec — zero rows affected is indistinguishable and fine
		},
	}

	require.NoError(t, runBackfill(t, b, db, 1234, 9999))
}

// ---------------------------------------------------------------------------
// Logging volume
// ---------------------------------------------------------------------------

// TestDescriptionBackfill_UnusableSummary_DoesNotLogAtWarn — roughly four in
// ten rows hit the rejection path, so at warn level the sweep alone would
// produce thousands of alarming-looking lines describing an entirely normal
// outcome, and drown the real warnings around them.
//
// NOT t.Parallel — slog.Default is process-global state.
func TestDescriptionBackfill_UnusableSummary_DoesNotLogAtWarn(t *testing.T) {
	original := slog.Default()
	t.Cleanup(func() { slog.SetDefault(original) })

	buf := &bytes.Buffer{}
	slog.SetDefault(slog.New(slog.NewTextHandler(buf, &slog.HandlerOptions{
		Level: slog.LevelInfo, // debug suppressed, exactly as in production
	})))

	b := subjectWithSummary(testSummaryMushokuJP)
	db := &fakeBackfillDB{}

	require.NoError(t, runBackfill(t, b, db, 1234, 9999))

	out := buf.String()
	assert.NotContains(t, out, "level=WARN",
		"a rejected summary is a non-event; warn-level logging here would flood the log")
	assert.NotContains(t, out, "level=ERROR",
		"a rejected summary must not surface as an error either")
}

// TestDescriptionBackfill_UnusableSummary_LogsAtDebug — the flip side: the
// skip must still be observable when debug is on, or diagnosing "why is
// coverage stuck at 60%" means reading the database instead of the log.
//
// NOT t.Parallel — slog.Default is process-global state.
func TestDescriptionBackfill_UnusableSummary_LogsAtDebug(t *testing.T) {
	original := slog.Default()
	t.Cleanup(func() { slog.SetDefault(original) })

	buf := &bytes.Buffer{}
	slog.SetDefault(slog.New(slog.NewTextHandler(buf, &slog.HandlerOptions{
		Level: slog.LevelDebug,
	})))

	b := subjectWithSummary(testSummaryMushokuJP)
	db := &fakeBackfillDB{}

	require.NoError(t, runBackfill(t, b, db, 1234, 9999))

	// Assert the SKIP line specifically, not merely "some debug line
	// mentioning this row".  The worker emits its own
	// "description_backfill done" line at debug carrying the same
	// anilistId, so a looser assertion would still pass if
	// persistDescriptionCn's skip line disappeared entirely — which is
	// exactly the line that answers "why is coverage stuck".
	out := buf.String()
	assert.Contains(t, out, `msg="description_backfill description_cn skipped"`,
		"the language-gate rejection must be logged in its own right, not inferred from the done line")
	assert.Contains(t, out, `reason="summary not usable Chinese"`,
		"the skip line must say WHY, or it cannot be told apart from a 404 or an empty summary")
	assert.Contains(t, out, "anilistId=1234",
		"the skip line must name the row so coverage gaps are traceable")

	// The done line must report the outcome honestly: nothing was sent.
	assert.Contains(t, out, "descriptionCnSent=false",
		"a skipped row must not be summarised as a successful write")
}

// ---------------------------------------------------------------------------
// Job contracts (args.go) — cheap guards against silent drift
// ---------------------------------------------------------------------------

// TestDescriptionBackfillArgs_Kind pins the river dispatch keys.
func TestDescriptionBackfillArgs_Kind(t *testing.T) {
	t.Parallel()

	assert.Equal(t, "description_backfill", DescriptionBackfillArgs{}.Kind())
	assert.Equal(t, "description_backfill_scan", DescriptionBackfillScanArgs{}.Kind())
}

// TestDescriptionBackfillArgs_InsertOpts — both job kinds ride the dedicated
// queue so pausing the sweep stops it being fed as well as stops it draining,
// and the per-row job dedupes by args so an interval that outruns the drain
// rate cannot compound duplicates every pass.
func TestDescriptionBackfillArgs_InsertOpts(t *testing.T) {
	t.Parallel()

	rowOpts := DescriptionBackfillArgs{}.InsertOpts()
	assert.Equal(t, DescriptionBackfillQueueName, rowOpts.Queue,
		"per-row jobs must not share a queue with live enrichment")
	assert.True(t, rowOpts.UniqueOpts.ByArgs,
		"without ByArgs a re-scan re-enqueues rows still draining from the last pass")

	scanOpts := DescriptionBackfillScanArgs{}.InsertOpts()
	assert.Equal(t, DescriptionBackfillQueueName, scanOpts.Queue,
		"the scan must be pausable together with the work it feeds")

	// The scan itself must NOT dedupe by args: DescriptionBackfillScanArgs is
	// an empty struct, so ByArgs would make every scan a duplicate of every
	// other scan and the sweep would fire exactly once in the lifetime of a
	// completed-job retention window.
	assert.False(t, scanOpts.UniqueOpts.ByArgs,
		"the scan args are empty — ByArgs here would collapse every future pass into the first one")
}

// TestDescriptionBackfillArgs_UniqueStateIncludesCompleted pins the single
// most surprising property of this sweep, and the one every operational
// question about it turns on.
//
// UniqueOpts.ByState is left unset, which is NOT the same as "no state
// filter": river fills in rivertype.UniqueOptsByStateDefault(), and that
// default INCLUDES JobStateCompleted.  So a per-row job that has already run
// blocks re-insertion of the same {anilistId, bgmId} until the job cleaner
// removes the completed row — CompletedJobRetentionPeriod, 24h by default and
// not overridden in queue.Boot.
//
// Three consequences follow, and all three are counter-intuitive:
//
//   - The hourly re-offer of rows that can never be written costs nothing
//     upstream; river drops them at insert.  The sweep's stall is silent and
//     cheap, not a rate-limit fire.
//   - A row whose write failed is NOT retried by the next scan an hour later.
//     It is retried a day later.
//   - A job that exhausted its river retries ends `discarded`, which is NOT in
//     the default set, so genuinely failed rows DO come back on the next pass.
//
// Asserting ByState == nil is the honest way to pin this: it is exactly the
// condition under which river's default applies.  Setting it explicitly would
// be a real behaviour change (dropping `completed` would turn the silent
// stall into a genuine 300-request-per-hour spin), so it must not happen by
// accident.
func TestDescriptionBackfillArgs_UniqueStateIncludesCompleted(t *testing.T) {
	t.Parallel()

	opts := DescriptionBackfillArgs{}.InsertOpts()

	require.True(t, opts.UniqueOpts.ByArgs,
		"dedupe must be on, or an interval that outruns the drain compounds duplicates")
	assert.Nil(t, opts.UniqueOpts.ByState,
		"ByState must stay unset so river's default (which includes `completed`) applies — "+
			"see this test's doc comment before changing it, the 24h dedupe window is load-bearing")

	// ByPeriod / ByQueue would each narrow the dedupe in ways nothing here
	// wants: a period would let the same row back in mid-window, and ByQueue
	// is meaningless when the kind only ever rides one queue.
	assert.Zero(t, opts.UniqueOpts.ByPeriod,
		"a unique period would re-admit residue rows inside the retention window")
	assert.False(t, opts.UniqueOpts.ByQueue,
		"this kind only ever runs on one queue; ByQueue would be noise")
}

// TestDescriptionBackfillQueueName_IsIsolated — the queue name is part of the
// admin pause contract; renaming it silently would leave the pause endpoint
// addressing a queue that no longer exists.
func TestDescriptionBackfillQueueName_IsIsolated(t *testing.T) {
	t.Parallel()

	assert.Equal(t, "description_backfill", DescriptionBackfillQueueName)
	assert.NotEqual(t, river.QueueDefault, DescriptionBackfillQueueName,
		"sharing the default queue would put a thousands-row backlog in front of page-driven enrichment")
	assert.NotEqual(t, BangumiV3QueueName, DescriptionBackfillQueueName)
}

// ---------------------------------------------------------------------------
// Periodic job
// ---------------------------------------------------------------------------

// TestPeriodicDescriptionBackfillScanJob_NonNil — a nil return would drop the
// schedule with no runtime error at all, leaving the entire backfill dead
// while everything looks wired.
func TestPeriodicDescriptionBackfillScanJob_NonNil(t *testing.T) {
	t.Parallel()

	require.NotNil(t, PeriodicDescriptionBackfillScanJob(),
		"PeriodicDescriptionBackfillScanJob must return a non-nil job")
}

// TestPeriodicDescriptionBackfillScanJob_RunsOnStart pins RunOnStart=true,
// which is a deliberate divergence from PeriodicOrphanScanJob and the only
// thing standing between this sweep and never running at all.
//
// River schedules a periodic job's first run one full interval AFTER Start.
// The orphan job can afford RunOnStart=false because main.go also calls
// ScanAndEnqueueOrphans directly at boot; this sweep has no such companion
// call, so with RunOnStart=false every deploy would push the next pass an
// hour out and a day with hourly deploys would produce zero passes — the
// exact silent-stall shape that stranded ~1,052 orphan rows before the
// orphan periodic job existed.
//
// The cost of RunOnStart=true is one extra pass per boot, and it is close to
// free: the per-row jobs dedupe by args against anything still queued or
// recently completed (see
// TestDescriptionBackfillArgs_UniqueStateIncludesCompleted), so a burst of
// deploys does not multiply upstream requests.
//
// Read via reflection because river keeps PeriodicJob's fields unexported and
// exposes no accessor.  That couples this test to river's internals on
// purpose: river is version-pinned, so an upgrade that reshapes PeriodicJob
// should stop and make somebody re-confirm this flag rather than silently
// carry an unverified assumption forward.
func TestPeriodicDescriptionBackfillScanJob_RunsOnStart(t *testing.T) {
	t.Parallel()

	job := PeriodicDescriptionBackfillScanJob()
	require.NotNil(t, job)

	optsField := reflect.ValueOf(job).Elem().FieldByName("opts")
	require.True(t, optsField.IsValid(),
		"river.PeriodicJob no longer has an `opts` field — re-verify RunOnStart is still set on the sweep")
	require.False(t, optsField.IsNil(),
		"PeriodicDescriptionBackfillScanJob passed nil opts, so RunOnStart defaulted to false — the sweep would skip its first hour after every deploy")

	runOnStart := optsField.Elem().FieldByName("RunOnStart")
	require.True(t, runOnStart.IsValid(),
		"river.PeriodicJobOpts no longer has RunOnStart — re-verify the sweep still fires at boot")
	assert.True(t, runOnStart.Bool(),
		"RunOnStart must stay true or a service that deploys more often than hourly never sweeps at all")
}

// ---------------------------------------------------------------------------
// Compile-time guards
// ---------------------------------------------------------------------------

// The fakes must satisfy the production interfaces they stand in for; a
// signature drift should fail here rather than deep inside a test body.
var (
	_ Enqueuer         = (*fakeBackfillEnqueuer)(nil)
	_ BangumiSubjector = (*fakeBangumiV3)(nil)

	// These two are what keep assertEnrichmentStateUntouched honest, and
	// they are load-bearing rather than decorative.  That guard only
	// detects a widened worker dependency if fakeBackfillDB genuinely
	// implements the interfaces it is pretending to be trusted with: if
	// UpdateBangumiV3 ever gained a parameter, the fake's method would
	// quietly stop matching V3Writer, every counter would stay at zero
	// forever, and the strongest assertion in this file would pass
	// vacuously.  Pinning both writer interfaces turns that into a
	// compile error.
	_ V2Writer = (*fakeBackfillDB)(nil)
	_ V3Writer = (*fakeBackfillDB)(nil)

	// The narrow interfaces the sweep declares must stay reachable from
	// the real production types, or main.go stops compiling for reasons
	// that have nothing to do with the sweep.
	//
	// The enqueuer line is an interface-to-interface assignment on
	// purpose: it asserts DescriptionBackfillEnqueuer remains a SUBSET of
	// Enqueuer, so the one LateBoundEnqueuer main.go builds can always be
	// handed to the scan worker.
	_ DescriptionBackfillReader   = (dbgen.Querier)(nil)
	_ DescriptionBackfillEnqueuer = (Enqueuer)(nil)

	// What actually has to hold is that the sweep's writer can be handed to
	// persistDescriptionCn — that is what lets it reuse the clean-then-write
	// path instead of growing a second copy of it. It is NOT a subset of
	// V2Writer: MarkDescriptionCnAttempted belongs to the sweep alone, since
	// the online workers have no queue position to maintain.
	_ descriptionCnWriter = (DescriptionBackfillWriter)(nil)

	// And the real Querier has to satisfy the whole sweep surface, since that
	// is what main.go hands the workers.
	_ DescriptionBackfillWriter = (dbgen.Querier)(nil)
)

// The sweep's ability to finish rests entirely on rows leaving the candidate
// set after they are considered. Storing text does that on its own; a rejected
// summary does not, and that residue is what stalls the sweep — with batch B
// and success rate p, lifetime writes converge to p*B/(1-p), roughly 450 rows
// of the ~9,100 backlog. These tests pin the stamping that avoids it.
func TestDescriptionBackfill_StampsAttemptWhenSummaryStored(t *testing.T) {
	t.Parallel()

	b := &fakeBangumiV3{
		subjectFn: func(_ context.Context, id int) (*bangumi.Subject, error) {
			s := makeSubject(id, "药屋少女的呢喃", 8.2, 900)
			s.Summary = testSummaryChinese
			return s, nil
		},
	}
	db := &fakeBackfillDB{}

	require.NoError(t, runBackfill(t, b, db, 4242, 777))

	require.Len(t, db.snapshotDescCalls(), 1, "usable Chinese is stored")
	assert.Equal(t, []int32{4242}, db.snapshotAttemptStamps(),
		"a stored row is still stamped, so a later pass need not reconsider it")
}

func TestDescriptionBackfill_StampsAttemptWhenSummaryRejected(t *testing.T) {
	t.Parallel()

	// The load-bearing case: ~37% of subjects carry the untranslated Japanese
	// original. Without a stamp these rows stay description_cn IS NULL, stay
	// candidates, and hold the front of every later batch forever.
	b := &fakeBangumiV3{
		subjectFn: func(_ context.Context, id int) (*bangumi.Subject, error) {
			s := makeSubject(id, "無職転生Ⅲ", 7.9, 240)
			s.Summary = testSummaryMushokuJP
			return s, nil
		},
	}
	db := &fakeBackfillDB{}

	require.NoError(t, runBackfill(t, b, db, 178789, 501963))

	assert.Empty(t, db.snapshotDescCalls(), "Japanese prose must never be stored")
	assert.Equal(t, []int32{178789}, db.snapshotAttemptStamps(),
		"a rejected row MUST still be stamped or the sweep cannot get past it")
}

func TestDescriptionBackfill_DoesNotStampOnTransientFailure(t *testing.T) {
	t.Parallel()

	// A timeout says nothing about the row. Stamping here would sideline it for
	// the whole cooldown over a problem that belongs to the network, so the
	// worker returns an error and lets river retry instead.
	b := &fakeBangumiV3{
		subjectFn: func(_ context.Context, _ int) (*bangumi.Subject, error) {
			return nil, errors.New("upstream timeout")
		},
	}
	db := &fakeBackfillDB{}

	err := runBackfill(t, b, db, 4242, 777)

	require.Error(t, err, "transient upstream failure must be retryable")
	assert.Empty(t, db.snapshotAttemptStamps(),
		"a transient failure is not a decided outcome and must not consume the retry window")
}

func TestDescriptionBackfillScan_PassesCooldownBound(t *testing.T) {
	t.Parallel()

	// An unbounded candidate query is the stalling bug: without a cooldown the
	// rejected rows are always eligible and always sort to the front.
	reader := &fakeCandidateReader{
		listFn: func(_ context.Context, _ pgtype.Interval, _ int32) ([]dbgen.ListDescriptionCnCandidatesRow, error) {
			return []dbgen.ListDescriptionCnCandidatesRow{}, nil
		},
	}
	enq := &fakeBackfillEnqueuer{}

	require.NoError(t, runBackfillScan(t, reader, enq))

	bounds := reader.snapshotRetryAfters()
	require.Len(t, bounds, 1)
	assert.True(t, bounds[0].Valid, "the cooldown bound must actually be set")
	assert.Equal(t, int32(descriptionBackfillRetryDays), bounds[0].Days)
}
