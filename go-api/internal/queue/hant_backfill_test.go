package queue

// Unit coverage for the zh-Hant sweep.  The ladder itself is tested in
// internal/hant; what is pinned here is the wiring that decides whether
// the ladder ever runs, on which queue, how often, and what it does with
// what it produces.
//
// The vendored datasets are real (there is no small version of s2twp that
// still converts) but the database is a fake, so nothing here needs
// Postgres.  The assertion that the manual guard in the UPDATE actually
// holds lives in test/integration.

import (
	"context"
	"errors"
	"path/filepath"
	"reflect"
	"runtime"
	"slices"
	"testing"
	"time"

	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/hant"
)

// hantDataDir resolves go-api/data/hant from this source file's location,
// so the tests do not care what directory `go test` was invoked from.
func hantDataDir(t *testing.T) string {
	t.Helper()
	_, self, _, ok := runtime.Caller(0)
	require.True(t, ok, "runtime.Caller failed")
	// internal/queue/hant_backfill_test.go -> internal/queue -> internal -> go-api
	return filepath.Join(filepath.Dir(filepath.Dir(filepath.Dir(self))), "data", "hant")
}

// hantWrite is one row as one of the batch statements received it.
type hantWrite struct {
	id                  int32
	value, source, hash string
}

// fakeHantDB records what the sweep read and wrote.
type fakeHantDB struct {
	rows    []dbgen.ListAnimeForHantBackfillRow
	listErr error

	titleBatches [][]hantWrite
	descBatches  [][]hantWrite
	writeErr     error
}

func (f *fakeHantDB) ListAnimeForHantBackfill(context.Context) ([]dbgen.ListAnimeForHantBackfillRow, error) {
	if f.listErr != nil {
		return nil, f.listErr
	}
	return f.rows, nil
}

func (f *fakeHantDB) ApplyHantTitleBatch(_ context.Context, ids []int32, values, sources, hashes []string) (int64, error) {
	f.titleBatches = append(f.titleBatches, zipHantWrites(ids, values, sources, hashes))
	if f.writeErr != nil {
		return 0, f.writeErr
	}
	return int64(len(ids)), nil
}

func (f *fakeHantDB) ApplyHantDescriptionBatch(_ context.Context, ids []int32, values, sources, hashes []string) (int64, error) {
	f.descBatches = append(f.descBatches, zipHantWrites(ids, values, sources, hashes))
	if f.writeErr != nil {
		return 0, f.writeErr
	}
	return int64(len(ids)), nil
}

func zipHantWrites(ids []int32, values, sources, hashes []string) []hantWrite {
	out := make([]hantWrite, len(ids))
	for i := range ids {
		out[i] = hantWrite{id: ids[i], value: values[i], source: sources[i], hash: hashes[i]}
	}
	return out
}

func (f *fakeHantDB) titles() []hantWrite { return slices.Concat(f.titleBatches...) }
func (f *fakeHantDB) descs() []hantWrite  { return slices.Concat(f.descBatches...) }

func hantWriteIDs(ws []hantWrite) []int32 {
	var out []int32
	for _, w := range ws {
		out = append(out, w.id)
	}
	return out
}

func (f *fakeHantDB) titleIDs() []int32 { return hantWriteIDs(f.titles()) }
func (f *fakeHantDB) descIDs() []int32  { return hantWriteIDs(f.descs()) }

func hantPtr(s string) *string { return &s }

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

// The kind string is duplicated into internal/db/queries/admin.sql, which
// sqlc cannot cross-check.  Pinning the literal here means a rename shows
// up as a failing test with the SQL named in the message, rather than as
// an admin panel that silently reports "never run" forever.
func TestHantBackfillArgsKind(t *testing.T) {
	t.Parallel()

	assert.Equal(t, "hant_backfill", HantBackfillArgs{}.Kind(),
		"renaming the kind also requires editing the 'hant_backfill' literal in GetHantBackfillJobStatus (internal/db/queries/admin.sql)")
}

// The sweep must not ride the default queue: one pass reads all ~17.5k
// rows and issues two dozen 500-row UPDATEs, and on the default queue
// that sits in front of the V1/V2 enrichment a page load is waiting on.
func TestHantBackfillArgsRidesItsOwnQueue(t *testing.T) {
	t.Parallel()

	opts := HantBackfillArgs{}.InsertOpts()
	assert.Equal(t, HantBackfillQueueName, opts.Queue)
	assert.NotEqual(t, river.QueueDefault, opts.Queue,
		"a whole-table sweep on the default queue starves live enrichment")

	// Every queue name has to be distinct or two workloads share a pause
	// switch and a worker budget.
	names := []string{
		river.QueueDefault,
		BangumiV3QueueName,
		DescriptionBackfillQueueName,
		DescriptionLlmQueueName,
		HantBackfillQueueName,
	}
	slices.Sort(names)
	assert.Equal(t, len(names), len(slices.Compact(names)), "two queues share a name")
}

// Prevents: river's default unique states coming back.
//
// The default set INCLUDES `completed`, and river keeps completed rows for
// 24h.  With the default, an operator who watched a sweep finish and then
// pressed the admin button again — because they had just fixed a dataset,
// or because the report showed rows the run could not take — would get a
// cheerful "enqueued" and no job, for a full day, with nothing anywhere
// saying why.
func TestHantBackfillArgsDedupesOnlyWhileInFlight(t *testing.T) {
	t.Parallel()

	opts := HantBackfillArgs{}.InsertOpts()
	require.True(t, opts.UniqueOpts.ByArgs,
		"without ByArgs a second enqueue stacks a duplicate whole-table pass behind the first")
	require.NotEmpty(t, opts.UniqueOpts.ByState,
		"an empty ByState means river's default, which includes `completed` and would mute the admin button for 24h after every successful sweep")

	cases := []struct {
		state rivertype.JobState
		want  bool
		why   string
	}{
		{rivertype.JobStateAvailable, true, "queued and waiting for a worker"},
		{rivertype.JobStatePending, true, "required by river's UniqueOpts validation"},
		{rivertype.JobStateRunning, true, "a pass is mid-flight"},
		{rivertype.JobStateRetryable, true, "in backoff after a failed attempt; still this sweep"},
		{rivertype.JobStateScheduled, true, "required by river's UniqueOpts validation"},
		{rivertype.JobStateCompleted, false, "finished; pressing the button again must schedule a new pass"},
		{rivertype.JobStateCancelled, false, "terminal"},
		{rivertype.JobStateDiscarded, false, "terminal: finished badly, not in flight"},
	}

	for _, tc := range cases {
		t.Run(string(tc.state), func(t *testing.T) {
			got := slices.Contains(opts.UniqueOpts.ByState, tc.state)
			assert.Equal(t, tc.want, got, "%s — %s", tc.state, tc.why)
		})
	}
}

// The state list is mirrored by hand into GetHantBackfillJobStatus, which
// is what makes the endpoint's `running` flag mean "a second press would
// be folded into this one".  They have to describe the same set.
func TestHantBackfillUniqueStatesMatchTheEndpointsRunningSet(t *testing.T) {
	t.Parallel()

	// Verbatim from the IN (...) list in GetHantBackfillJobStatus.
	sqlStates := []rivertype.JobState{
		rivertype.JobState("available"),
		rivertype.JobState("pending"),
		rivertype.JobState("running"),
		rivertype.JobState("retryable"),
		rivertype.JobState("scheduled"),
	}

	got := slices.Clone(hantBackfillUniqueStates)
	slices.Sort(got)
	slices.Sort(sqlStates)
	assert.Equal(t, sqlStates, got,
		"internal/db/queries/admin.sql's state list and hantBackfillUniqueStates have drifted; the admin page would report `running` for jobs the dedupe does not actually suppress, or the reverse")
}

// ---------------------------------------------------------------------------
// Periodic job
// ---------------------------------------------------------------------------

// A nil return would drop the schedule with no runtime error at all,
// leaving the sweep dead while everything looks wired.
func TestPeriodicHantBackfillJobNonNil(t *testing.T) {
	t.Parallel()

	require.NotNil(t, PeriodicHantBackfillJob())
}

// Prevents: RunOnStart being added "for symmetry" with the two
// description sweeps.
//
// Those fire hourly, so RunOnStart=false meant a service deploying several
// times a day never swept at all.  This one fires quarterly, so the same
// flag reads the other way round: RunOnStart=true would not be "quarterly
// plus a nudge at boot", it would be "every deploy" — a whole-table read
// plus s2twp over ~16k synopses in front of the request path on the
// coldest container, several times a week.
//
// Read via reflection because river keeps PeriodicJob's fields unexported
// and exposes no accessor.  That couples this test to river's internals on
// purpose: river is version-pinned, so an upgrade that reshapes
// PeriodicJob should stop and make somebody re-confirm this rather than
// silently carry an unverified assumption forward.
func TestPeriodicHantBackfillJobDoesNotRunOnStart(t *testing.T) {
	t.Parallel()

	job := PeriodicHantBackfillJob()
	require.NotNil(t, job)

	optsField := reflect.ValueOf(job).Elem().FieldByName("opts")
	require.True(t, optsField.IsValid(),
		"river.PeriodicJob no longer has an `opts` field — re-verify RunOnStart is still unset on the sweep")
	if optsField.IsNil() {
		return // nil opts is RunOnStart=false, which is what this pins
	}
	runOnStart := optsField.Elem().FieldByName("RunOnStart")
	require.True(t, runOnStart.IsValid(),
		"river.PeriodicJobOpts no longer has RunOnStart — re-verify what the sweep does at boot")
	assert.False(t, runOnStart.Bool(),
		"RunOnStart=true turns a 90-day sweep into an every-deploy sweep; the admin button is the on-demand trigger")
}

// The interval is the one number that decides how much drift accumulates
// before the sweep catches it on its own.  Pinned so a units mistake
// (90*time.Hour, 90*time.Second) cannot pass review as "90".
func TestHantBackfillIntervalIsNinetyDays(t *testing.T) {
	t.Parallel()

	assert.Equal(t, 90*24*time.Hour, hantBackfillInterval)
	assert.Greater(t, hantBackfillInterval, descriptionBackfillScanInterval,
		"the zh-Hant sweep reads the whole table; it must be rarer than the hourly description scan, not more frequent")
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

func TestHantBackfillWorkerWork(t *testing.T) {
	dir := hantDataDir(t)

	cases := []struct {
		name       string
		db         *fakeHantDB
		dataDir    string
		wantErrIn  string
		wantTitles []int32
		wantDescs  []int32
	}{
		{
			name: "fills a row that has a Chinese title and no Traditional one",
			db: &fakeHantDB{rows: []dbgen.ListAnimeForHantBackfillRow{
				// 16498 is Attack on Titan in the vendored anilist dataset,
				// so the ladder resolves a human-written Traditional title
				// rather than a machine conversion.
				{AnilistID: 16498, TitleChinese: hantPtr("进击的巨人"), DescriptionCn: hantPtr("人类与巨人的战斗。")},
			}},
			wantTitles: []int32{16498},
			wantDescs:  []int32{16498},
		},
		{
			name: "leaves a row no tier can reach",
			db: &fakeHantDB{rows: []dbgen.ListAnimeForHantBackfillRow{
				// No title_chinese and no description_cn, and an id the
				// datasets do not carry: every tier declines, and
				// declining must not be read as "blank the column".
				{AnilistID: 99999999, TitleHant: hantPtr("已經有的標題"), TitleHantSource: hantPtr("opencc")},
			}},
			wantTitles: nil,
			wantDescs:  nil,
		},
		{
			name: "never touches a row a human decided",
			db: &fakeHantDB{rows: []dbgen.ListAnimeForHantBackfillRow{
				{
					AnilistID:             16498,
					TitleChinese:          hantPtr("进击的巨人"),
					DescriptionCn:         hantPtr("人类与巨人的战斗。"),
					TitleHant:             hantPtr("一個人手打的標題"),
					TitleHantSource:       hantPtr("manual"),
					DescriptionHant:       hantPtr("一段人手打的簡介。"),
					DescriptionHantSource: hantPtr("manual"),
				},
			}},
			wantTitles: nil,
			wantDescs:  nil,
		},
		{
			name:      "a failed read is returned so river retries",
			db:        &fakeHantDB{listErr: errors.New("connection reset by peer")},
			wantErrIn: "connection reset by peer",
		},
		{
			name: "a failed write names the column",
			db: &fakeHantDB{
				rows:     []dbgen.ListAnimeForHantBackfillRow{{AnilistID: 16498, TitleChinese: hantPtr("进击的巨人")}},
				writeErr: errors.New("deadlock detected"),
			},
			wantErrIn: "title_hant",
		},
		{
			name:      "a missing dataset directory names the file it wanted",
			db:        &fakeHantDB{},
			dataDir:   filepath.Join(t.TempDir(), "not-here"),
			wantErrIn: "opencc-s2twp.txt",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d := tc.dataDir
			if d == "" {
				d = dir
			}
			w := NewHantBackfillWorker(tc.db, d)

			err := w.Work(context.Background(), &river.Job[HantBackfillArgs]{})

			if tc.wantErrIn != "" {
				require.Error(t, err)
				assert.Contains(t, err.Error(), tc.wantErrIn)
				return
			}
			require.NoError(t, err)
			assert.Equal(t, tc.wantTitles, tc.db.titleIDs(), "title_hant writes")
			assert.Equal(t, tc.wantDescs, tc.db.descIDs(), "description_hant writes")
		})
	}
}

// Prevents: a sweep that rewrites the rows it just wrote.
//
// The steady state of a 90-day job is "nothing changed", and the way that
// is achieved is the stored (value, source, hash) triple matching what the
// ladder derives.  If any of the three were derived differently on the
// read path than on the write path — a hash over the output instead of the
// input, a source string that round-trips as something else — every pass
// would rewrite all ~12k rows forever, and the only visible symptom would
// be a job that takes a while.
//
// Written as feed-the-output-back rather than as hard-coded expected
// values on purpose: hard-coding them would pin today's dataset contents
// instead of the property, and would need editing every time upstream
// revises a title.
func TestHantBackfillWorkerIsIdempotent(t *testing.T) {
	dir := hantDataDir(t)
	row := dbgen.ListAnimeForHantBackfillRow{
		AnilistID:     16498,
		TitleNative:   hantPtr("進撃の巨人"),
		TitleChinese:  hantPtr("进击的巨人"),
		DescriptionCn: hantPtr("人类与巨人的战斗。"),
	}

	first := &fakeHantDB{rows: []dbgen.ListAnimeForHantBackfillRow{row}}
	require.NoError(t, NewHantBackfillWorker(first, dir).Work(context.Background(), &river.Job[HantBackfillArgs]{}))
	require.Len(t, first.titles(), 1, "the first pass should have filled title_hant")
	require.Len(t, first.descs(), 1, "the first pass should have filled description_hant")

	// Exactly what the UPDATE would have stored.
	tw, dw := first.titles()[0], first.descs()[0]
	row.TitleHant, row.TitleHantSource, row.TitleHantSourceHash = &tw.value, &tw.source, &tw.hash
	row.DescriptionHant, row.DescriptionHantSource, row.DescriptionHantSourceHash = &dw.value, &dw.source, &dw.hash

	second := &fakeHantDB{rows: []dbgen.ListAnimeForHantBackfillRow{row}}
	require.NoError(t, NewHantBackfillWorker(second, dir).Work(context.Background(), &river.Job[HantBackfillArgs]{}))

	assert.Empty(t, second.titles(), "the second pass rewrote title_hant it had just written")
	assert.Empty(t, second.descs(), "the second pass rewrote description_hant it had just written")
}

// Prevents: the sweep quietly processing a prefix of the table.
//
// hant.RowsFromDB takes a limit because the CLI has a --limit smoke flag.
// A worker that passed anything but 0 would leave the tail of the
// catalogue permanently behind while every log line and every counter
// looked healthy.
func TestHantBackfillWorkerTakesTheWholeTable(t *testing.T) {
	rows := make([]dbgen.ListAnimeForHantBackfillRow, hant.ApplyBatchSize+3)
	for i := range rows {
		rows[i] = dbgen.ListAnimeForHantBackfillRow{
			AnilistID:    int32(i + 1),
			TitleChinese: hantPtr("鬼灭之刃"),
		}
	}
	db := &fakeHantDB{rows: rows}

	w := NewHantBackfillWorker(db, hantDataDir(t))
	require.NoError(t, w.Work(context.Background(), &river.Job[HantBackfillArgs]{}))

	assert.Len(t, db.titleIDs(), len(rows), "every row with a Chinese title should have been offered")
	assert.Len(t, db.titleBatches, 2, "writes should be sliced into whole 500-row batches")
}

// An empty dataDir has to resolve through the env var rather than through
// the process's working directory, because main.go passes "" on purpose
// and the container's working directory holds no datasets at all.
func TestNewHantBackfillWorkerFallsBackToTheEnvVar(t *testing.T) {
	t.Setenv(hant.DataDirEnv, "/usr/local/share/animego/hant")

	assert.Equal(t, "/usr/local/share/animego/hant", NewHantBackfillWorker(&fakeHantDB{}, "").dataDir)
	assert.Equal(t, "/somewhere/else", NewHantBackfillWorker(&fakeHantDB{}, "/somewhere/else").dataDir,
		"an explicit directory must win over the environment")
}

// Compile-time guard: the fake has to keep satisfying the surface the
// worker holds, or these tests stop proving anything about production.
var _ HantBackfillDB = (*fakeHantDB)(nil)
