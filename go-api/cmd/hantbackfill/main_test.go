package main

// main.go is the part of this tool that decides whether to write, and
// then writes.  Every test below pins a defect that a review found in it
// after the fact -- the code is correct now, and these exist so it stays
// that way.
//
// The ladder, the gate and the batch-write core moved to internal/hant
// when the river worker started sharing them, and their tests moved with
// them.  What is left here is what only the CLI has: the read-only
// assertion, the report path, and the pre-apply backup file.
//
// Nothing here touches Postgres.  The two batch statements reach the
// database through a two-method interface, so the apply path is exercised
// with a fake that records what it was handed; the assertions that need a
// real server (that the UPDATE's manual guard actually holds, that unnest
// pads rather than raises) live in test/integration.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/lawrenceli0228/animego/go-api/internal/hant"
)

// ─── fakes ───────────────────────────────────────────────────────────────────

// batchArgs is one call into one of the two generated statements.
type batchArgs struct {
	ids                     []int32
	values, sources, hashes []string
}

// fakeStatements stands in for *dbgen.Queries.
type fakeStatements struct {
	titleBatches []batchArgs
	descBatches  []batchArgs

	// rowsFor models :execrows: what the database says it changed, which
	// the manual guard can make smaller than the batch it was offered.
	rowsFor func(offered int) int64
	err     error

	// onCall runs at the top of every statement so a test can assert what
	// was already true by the time the first UPDATE ran.
	onCall func()
}

func (f *fakeStatements) ApplyHantTitleBatch(_ context.Context, ids []int32, values, sources, hashes []string) (int64, error) {
	return f.record(&f.titleBatches, ids, values, sources, hashes)
}

func (f *fakeStatements) ApplyHantDescriptionBatch(_ context.Context, ids []int32, values, sources, hashes []string) (int64, error) {
	return f.record(&f.descBatches, ids, values, sources, hashes)
}

func (f *fakeStatements) record(into *[]batchArgs, ids []int32, values, sources, hashes []string) (int64, error) {
	if f.onCall != nil {
		f.onCall()
	}
	*into = append(*into, batchArgs{ids: ids, values: values, sources: sources, hashes: hashes})
	if f.err != nil {
		return 0, f.err
	}
	if f.rowsFor != nil {
		return f.rowsFor(len(ids)), nil
	}
	return int64(len(ids)), nil
}

func (f *fakeStatements) calls() int { return len(f.titleBatches) + len(f.descBatches) }

// changedTitleRow is a row the ladder wants to write a title onto.
func changedTitleRow(id int32, value string) hant.RowResult {
	return hant.RowResult{
		Row:          hant.Row{AnilistID: id, TitleChinese: ptr(value)},
		Title:        hant.Decision{Source: hant.SrcAnilist, Value: value, Input: value, Hash: hant.SourceHash(value)},
		TitleChanged: true,
	}
}

// changedDescRow is the description column's equivalent.
func changedDescRow(id int32, value string) hant.RowResult {
	return hant.RowResult{
		Row:         hant.Row{AnilistID: id, DescriptionCN: ptr(value)},
		Desc:        hant.Decision{Source: hant.SrcOpenCC, Value: value, Input: value, Hash: hant.SourceHash(value)},
		DescChanged: true,
	}
}

// applyInTempDir runs runApply with the working directory somewhere
// disposable, because the backup lands on a relative path.
func applyInTempDir(t *testing.T, ctx context.Context, q hant.Writer, results []hant.RowResult, restaleOnly bool) (string, error) {
	t.Helper()
	t.Chdir(t.TempDir())
	var out bytes.Buffer
	err := runApply(ctx, &out, q, results, restaleOnly)
	return out.String(), err
}

// ─── 2. --report / --apply mutual exclusion ──────────────────────────────────

// Prevents: --report going back to being dead.
//
// It used to be read exactly once, to set itself, and was never consulted
// again — so --report, --apply and no flag at all produced identical
// behaviour while the package comment described three modes.  It is now
// an assertion of read-only, and the two things that have to stay true
// are that pairing it with --apply exits 2, and that such a run cannot
// write no matter what a caller does with the exit code.
func TestResolveMode(t *testing.T) {
	cases := []struct {
		name           string
		report, apply  bool
		wantWrites     bool
		wantExit       int
		wantStderrHas  string
		wantStderrNone bool
	}{
		{
			name: "no flags reports and does not write",
			// The report is written on every run, so a bare invocation is
			// already the read-only mode; it just says nothing about it.
			wantStderrNone: true,
		},
		{
			name:           "--report alone is read-only and coherent",
			report:         true,
			wantStderrNone: true,
		},
		{
			name:          "--apply writes, loudly",
			apply:         true,
			wantWrites:    true,
			wantStderrHas: "WRITE",
		},
		{
			name:          "--report --apply is refused",
			report:        true,
			apply:         true,
			wantExit:      2,
			wantStderrHas: "cannot be combined",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := resolveMode(tc.report, tc.apply)

			if got.Writes != tc.wantWrites {
				t.Errorf("Writes = %v, want %v", got.Writes, tc.wantWrites)
			}
			if got.ExitCode != tc.wantExit {
				t.Errorf("ExitCode = %d, want %d", got.ExitCode, tc.wantExit)
			}
			if tc.wantStderrNone && got.Stderr != "" {
				t.Errorf("Stderr = %q, want nothing said", got.Stderr)
			}
			if tc.wantStderrHas != "" && !strings.Contains(got.Stderr, tc.wantStderrHas) {
				t.Errorf("Stderr = %q, want it to mention %q", got.Stderr, tc.wantStderrHas)
			}
		})
	}
}

// Prevents: resolving the conflict by precedence instead of refusing it.
//
// Writes is the only thing that gates runApply, so the contradiction has
// to come out of resolveMode with Writes false — a caller that logged the
// message and carried on must still not touch the table.  And the code
// has to be 2, not 1: 1 is a run that started and broke, 2 is a run that
// was never coherent, and a wrapper script tells them apart by number.
func TestReportAndApplyTogetherCannotWrite(t *testing.T) {
	got := resolveMode(true, true)
	if got.Writes {
		t.Fatal("--report --apply resolved to a writing run; --report is an assertion the tool must hold you to, not a preference to be overridden")
	}
	if modeExitConflict != 2 {
		t.Fatalf("modeExitConflict = %d; the documented contract is 2", modeExitConflict)
	}
	if got.ExitCode != modeExitConflict {
		t.Fatalf("ExitCode = %d, want %d", got.ExitCode, modeExitConflict)
	}
	if got.Stderr == "" {
		t.Fatal("exiting 2 with nothing on stderr leaves the operator guessing")
	}
}

// ─── 3. offered vs written ───────────────────────────────────────────────────

// Prevents: reporting the number of rows offered as though it were the
// number written.
//
// The statements are :execrows, and the manual guard in their WHERE
// clause means the database can legitimately change fewer rows than the
// batch carried — a row hand-promoted to source='manual' between the
// report and the apply is skipped.  That is the guard working, but it has
// to be visible: printing "500 rows written" for a batch of 500 that only
// changed 498 hides the one fact the operator needed.
func TestPrintWrittenSurfacesTheGap(t *testing.T) {
	cases := []struct {
		name     string
		written  int64
		offered  int
		wantIn   []string
		wantNoIn []string
	}{
		{
			name:     "everything offered was written",
			written:  5,
			offered:  5,
			wantIn:   []string{"title_hant", "5 rows written"},
			wantNoIn: []string{"offered", "skipped"},
		},
		{
			name:    "the manual guard skipped some",
			written: 3,
			offered: 5,
			wantIn:  []string{"3 rows written", "5 offered", "2 skipped"},
		},
		{
			name:    "the guard skipped all of them",
			written: 0,
			offered: 4,
			wantIn:  []string{"0 rows written", "4 offered", "4 skipped"},
		},
		{
			name:     "nothing offered, nothing written",
			written:  0,
			offered:  0,
			wantIn:   []string{"0 rows written"},
			wantNoIn: []string{"offered"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var buf bytes.Buffer
			printWritten(&buf, "title_hant", tc.written, tc.offered)
			got := buf.String()

			for _, want := range tc.wantIn {
				if !strings.Contains(got, want) {
					t.Errorf("output %q is missing %q", got, want)
				}
			}
			for _, unwanted := range tc.wantNoIn {
				if strings.Contains(got, unwanted) {
					t.Errorf("output %q mentions %q on a run with no gap", got, unwanted)
				}
			}
			if !strings.HasSuffix(got, "\n") {
				t.Errorf("output %q is not a line", got)
			}
		})
	}
}

// The same gap, through the real apply path: the count in the summary has
// to be the database's, not len(batch).
func TestRunApplyReportsTheDatabasesCountNotTheBatchSize(t *testing.T) {
	q := &fakeStatements{
		// Two of the five titles were promoted to 'manual' after the
		// report was taken, so the UPDATE's guard skipped them.
		rowsFor: func(offered int) int64 { return int64(offered) - 2 },
	}
	results := []hant.RowResult{
		changedTitleRow(1, "星際牛仔"),
		changedTitleRow(2, "進擊的巨人"),
		changedTitleRow(3, "鬼滅之刃"),
		changedTitleRow(4, "夢幻街少女"),
		changedTitleRow(5, "心之谷"),
	}

	out, err := applyInTempDir(t, context.Background(), q, results, false)
	if err != nil {
		t.Fatalf("runApply: %v", err)
	}
	for _, want := range []string{"3 rows written", "5 offered", "2 skipped"} {
		if !strings.Contains(out, want) {
			t.Errorf("summary is missing %q; a shortfall the operator cannot see is a shortfall nobody investigates\n%s", want, out)
		}
	}
}

// ─── 4. writeJSON durability ─────────────────────────────────────────────────

// errWriter fails every write, standing in for a full disk.
type errWriter struct{ err error }

func (w errWriter) Write([]byte) (int, error) { return 0, w.err }

// flakyFile is an *os.File whose Sync or Close fails on demand.  Forcing
// a real close(2) to fail is not portable; the branch still has to be
// covered, because that branch is the defect.
type flakyFile struct {
	io.Writer
	syncErr  error
	closeErr error
	synced   bool
	closed   bool
}

func (f *flakyFile) Sync() error {
	f.synced = true
	return f.syncErr
}

func (f *flakyFile) Close() error {
	f.closed = true
	return f.closeErr
}

// Prevents: `defer f.Close()` coming back.
//
// writeJSON writes the pre-apply backup, and runApply treats a nil return
// as "the backup is safe" and proceeds to the UPDATEs.  A deferred Close
// discards its error, so a failure that only surfaces at close time — a
// full disk, an NFS write-back error — would let ~12k rows be rewritten
// against a truncated or absent undo file.  Every one of these has to
// come back as an error, and the file has to be closed either way.
func TestEncodeSyncCloseReportsEveryFailure(t *testing.T) {
	boom := errors.New("no space left on device")

	cases := []struct {
		name     string
		w        io.Writer
		syncErr  error
		closeErr error
		wantIn   string
	}{
		{
			name:   "the encoder could not write",
			w:      errWriter{err: boom},
			wantIn: "encode JSON",
		},
		{
			name:    "the bytes never reached the disk",
			w:       &bytes.Buffer{},
			syncErr: boom,
			wantIn:  "sync",
		},
		{
			name:     "the failure only surfaced at close",
			w:        &bytes.Buffer{},
			closeErr: boom,
			wantIn:   "close",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := &flakyFile{Writer: tc.w, syncErr: tc.syncErr, closeErr: tc.closeErr}

			err := encodeSyncClose("backup-test.json", f, []backupRow{{AnilistID: 1}})
			if err == nil {
				t.Fatal("returned nil; runApply reads that as 'the backup is safe' and starts writing to production")
			}
			if !strings.Contains(err.Error(), tc.wantIn) {
				t.Errorf("error %q does not say %q, so the operator cannot tell what failed", err, tc.wantIn)
			}
			if !errors.Is(err, boom) {
				t.Errorf("error %q does not wrap the underlying cause", err)
			}
			if !f.closed {
				t.Error("the file was left open")
			}
		})
	}
}

// A close error must not overwrite the real cause.  When the encode
// already failed, that is the error worth reporting; the close failure
// that follows is a symptom.
func TestCloseErrorDoesNotMaskTheEarlierFailure(t *testing.T) {
	encodeErr := errors.New("disk went away mid-write")
	closeErr := errors.New("close also failed")
	f := &flakyFile{Writer: errWriter{err: encodeErr}, closeErr: closeErr}

	err := encodeSyncClose("backup-test.json", f, []backupRow{{AnilistID: 1}})
	if !errors.Is(err, encodeErr) {
		t.Fatalf("error = %v, want the encode failure — it is the cause, the close failure is a consequence", err)
	}
	if errors.Is(err, closeErr) {
		t.Fatalf("error = %v, want the first failure only", err)
	}
}

// A backup nobody can read back is not a backup.  The undo path is
// "restore these exact values", so the file has to round-trip pointers,
// NULLs and non-ASCII unchanged.
func TestWriteJSONRoundTripsTheBackup(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "backup-20260821T000000Z.json")

	want := []backupRow{
		{AnilistID: 1, TitleHant: ptr("星際牛仔"), TitleHantSource: ptr(hant.SrcAnilist), TitleHantSourceHash: ptr(hant.SourceHash("星際牛仔"))},
		// A row with nothing stored yet: the undo is "put the NULLs back".
		{AnilistID: 2},
		{AnilistID: 3, DescriptionHant: ptr("刀劍神域 & <朋友>"), DescriptionHantSource: ptr(hant.SrcOpenCC)},
	}
	if err := writeJSON(path, want); err != nil {
		t.Fatalf("writeJSON: %v", err)
	}

	blob, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	var got []backupRow
	if err := json.Unmarshal(blob, &got); err != nil {
		t.Fatalf("the backup is not valid JSON: %v", err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("round-trip changed the rows:\n got %+v\nwant %+v", got, want)
	}
	// SetEscapeHTML(false) is what keeps the file readable by the human
	// who has to decide whether to run it back.  Turn escaping on and
	// this substring cannot occur: & and < come out as numeric escapes
	// instead, valid JSON that no longer reads as the title it stores.
	if !strings.Contains(string(blob), "& <朋友>") {
		t.Error("HTML escaping is on; the backup is meant to be read by a person")
	}
}

// The create failure has to be reported too, and named — a report or
// backup path that does not exist is an operator typo, not a bug.
func TestWriteJSONReportsAnUnusableTarget(t *testing.T) {
	dir := t.TempDir()
	err := writeJSON(dir, []backupRow{{AnilistID: 1}})
	if err == nil {
		t.Fatal("writing to a directory returned nil")
	}
	if !strings.Contains(err.Error(), dir) {
		t.Errorf("error %q does not name the path it failed on", err)
	}
}

// Prevents: the UPDATEs running when the backup did not land.
//
// The backup is the only undo path for a bad --apply, so it is written
// first and a failure has to abort the whole run before a single row is
// touched.
func TestRunApplyStopsWhenTheBackupCannotBeWritten(t *testing.T) {
	// A working directory that no longer exists makes the relative
	// backup path unopenable, without depending on file modes or on
	// which uid the test runs as.
	gone := filepath.Join(t.TempDir(), "gone")
	if err := os.Mkdir(gone, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Chdir(gone)
	if err := os.Remove(gone); err != nil {
		t.Fatal(err)
	}

	q := &fakeStatements{}
	err := runApply(context.Background(), io.Discard, q, []hant.RowResult{changedTitleRow(1, "星際牛仔")}, false)

	if err == nil {
		t.Fatal("runApply reported success with no backup on disk")
	}
	if !strings.Contains(err.Error(), "backup") {
		t.Errorf("error %q does not say the backup was the thing that failed", err)
	}
	if q.calls() != 0 {
		t.Fatalf("%d statements ran after the backup failed; there is now no way to undo them", q.calls())
	}
}

// The other half of the same invariant: when the run does proceed, the
// backup is already complete on disk by the time the first UPDATE is
// issued — not merely scheduled, not half-flushed.
func TestRunApplyWritesTheBackupBeforeTheFirstUpdate(t *testing.T) {
	t.Chdir(t.TempDir())

	var q *fakeStatements
	q = &fakeStatements{onCall: func() {
		if q.calls() > 0 {
			return // only the first statement is interesting
		}
		matches, err := filepath.Glob("backup-*.json")
		if err != nil || len(matches) == 0 {
			t.Error("the first UPDATE ran before any backup file existed")
			return
		}
		blob, err := os.ReadFile(matches[0])
		if err != nil {
			t.Errorf("backup unreadable at the moment of the first UPDATE: %v", err)
			return
		}
		var rows []backupRow
		if err := json.Unmarshal(blob, &rows); err != nil {
			t.Errorf("backup was still partial when the first UPDATE ran: %v", err)
			return
		}
		if len(rows) != 2 {
			t.Errorf("backup held %d rows at the first UPDATE, want both affected rows", len(rows))
		}
	}}

	results := []hant.RowResult{changedTitleRow(2, "進擊的巨人"), changedTitleRow(1, "星際牛仔")}
	var out bytes.Buffer
	if err := runApply(context.Background(), &out, q, results, false); err != nil {
		t.Fatalf("runApply: %v", err)
	}
	if q.calls() == 0 {
		t.Fatal("no statement ran, so the assertion above never fired")
	}
}

// A row touched by both columns is backed up once, and the file is
// ordered by id so two runs of the same set diff cleanly.
func TestBackupIsDedupedAndOrdered(t *testing.T) {
	t.Chdir(t.TempDir())

	both := changedTitleRow(7, "心之谷")
	both.Desc = hant.Decision{Source: hant.SrcOpenCC, Value: "簡介", Hash: hant.SourceHash("简介")}
	both.DescChanged = true

	results := []hant.RowResult{changedTitleRow(9, "星際牛仔"), both, changedDescRow(3, "簡介二")}
	if err := runApply(context.Background(), io.Discard, &fakeStatements{}, results, false); err != nil {
		t.Fatalf("runApply: %v", err)
	}

	matches, _ := filepath.Glob("backup-*.json")
	if len(matches) != 1 {
		t.Fatalf("found %d backup files, want 1", len(matches))
	}
	blob, err := os.ReadFile(matches[0])
	if err != nil {
		t.Fatal(err)
	}
	var rows []backupRow
	if err := json.Unmarshal(blob, &rows); err != nil {
		t.Fatal(err)
	}

	var ids []int32
	for _, r := range rows {
		ids = append(ids, r.AnilistID)
	}
	// 7 appears in both the title and the description write set.
	if want := []int32{3, 7, 9}; !reflect.DeepEqual(ids, want) {
		t.Fatalf("backup ids = %v, want %v (deduped, ascending)", ids, want)
	}
}

// Nothing to write means nothing on disk: a --apply that finds no changes
// must not leave a backup file behind for an operator to wonder about.
func TestRunApplyWithNothingToWriteTouchesNothing(t *testing.T) {
	t.Chdir(t.TempDir())

	q := &fakeStatements{}
	var out bytes.Buffer
	// A manual row and an unchanged row: neither is writable.
	results := []hant.RowResult{
		{Row: hant.Row{AnilistID: 1}, TitleManual: true},
		{Row: hant.Row{AnilistID: 2}},
	}
	if err := runApply(context.Background(), &out, q, results, false); err != nil {
		t.Fatalf("runApply: %v", err)
	}
	if q.calls() != 0 {
		t.Fatalf("%d statements ran with nothing writable", q.calls())
	}
	if matches, _ := filepath.Glob("backup-*.json"); len(matches) != 0 {
		t.Fatalf("left %v behind on a run that wrote nothing", matches)
	}
	if !strings.Contains(out.String(), "nothing to write") {
		t.Errorf("summary = %q, want it to say so plainly", out.String())
	}
}

// ─── 4b. backup filename collisions ──────────────────────────────────────────

// Prevents: os.Create coming back for the backup.
//
// The backup name carries a timestamp with one-second resolution and
// os.Create truncates, so two --apply runs in the same second resolved to
// the same path and the second one emptied the first one's undo file —
// the one file this code Syncs, checks Close on, and refuses to proceed
// without.  backfill-out/ is shared with cmd/bgmbackfill, which writes a
// backup-<ts>.json on the same layout, so it does not even take two
// hantbackfill runs.  An existing file has to survive untouched.
func TestWriteBackupJSONNeverOverwritesAnExistingBackup(t *testing.T) {
	t.Chdir(t.TempDir())
	const stamp = "20260821T031500Z"

	// The first run's undo file, already on disk.
	first := []backupRow{{AnilistID: 1, TitleHant: ptr("星際牛仔"), TitleHantSource: ptr(hant.SrcAnilist)}}
	firstPath, err := writeBackupJSON(stamp, first)
	if err != nil {
		t.Fatalf("writeBackupJSON: %v", err)
	}
	if want := "backup-" + stamp + ".json"; firstPath != want {
		t.Fatalf("first backup landed on %q, want the documented %q", firstPath, want)
	}
	firstBytes, err := os.ReadFile(firstPath)
	if err != nil {
		t.Fatal(err)
	}

	// A second run in the same second.
	second := []backupRow{{AnilistID: 2, TitleHant: ptr("進擊的巨人")}}
	secondPath, err := writeBackupJSON(stamp, second)
	if err != nil {
		t.Fatalf("second writeBackupJSON: %v", err)
	}
	if secondPath == firstPath {
		t.Fatalf("both runs wrote %q; the first run's rows are now unrecoverable", firstPath)
	}

	after, err := os.ReadFile(firstPath)
	if err != nil {
		t.Fatalf("the first backup is gone: %v", err)
	}
	if !bytes.Equal(after, firstBytes) {
		t.Fatalf("the first backup was rewritten:\n got %s\nwant %s", after, firstBytes)
	}

	// And the second run has a readable undo file of its own — a run that
	// proceeds to the UPDATEs without one has no way back.
	var got []backupRow
	blob, err := os.ReadFile(secondPath)
	if err != nil {
		t.Fatalf("read %s: %v", secondPath, err)
	}
	if err := json.Unmarshal(blob, &got); err != nil {
		t.Fatalf("%s is not readable JSON: %v", secondPath, err)
	}
	if !reflect.DeepEqual(got, second) {
		t.Fatalf("%s holds %+v, want %+v", secondPath, got, second)
	}

	// A third collision keeps counting rather than reusing -2.
	thirdPath, err := writeBackupJSON(stamp, []backupRow{{AnilistID: 3}})
	if err != nil {
		t.Fatalf("third writeBackupJSON: %v", err)
	}
	names := []string{firstPath, secondPath, thirdPath}
	for i, a := range names {
		for _, b := range names[i+1:] {
			if a == b {
				t.Fatalf("two runs share the name %q", a)
			}
		}
	}
	// All three are still on disk, which is the whole point.
	matches, _ := filepath.Glob("backup-*.json")
	if len(matches) != 3 {
		t.Fatalf("found %v, want all three undo files", matches)
	}
}

// Prevents: a suffix search that spins instead of failing.
//
// Every name being taken is not a case a different filename fixes, and
// the caller reads a nil error as "the backup is safe".  It has to come
// back as an error, and no existing file may be touched on the way out.
func TestWriteBackupJSONGivesUpRatherThanOverwrite(t *testing.T) {
	t.Chdir(t.TempDir())
	const stamp = "20260821T031500Z"

	for i := range backupAttempts {
		if err := os.WriteFile(backupName(stamp, i), []byte("taken"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	path, err := writeBackupJSON(stamp, []backupRow{{AnilistID: 1}})
	if err == nil {
		t.Fatalf("returned %q with every name taken; runApply reads a nil error as 'the backup is safe'", path)
	}
	if path != "" {
		t.Errorf("returned path %q alongside an error", path)
	}
	for i := range backupAttempts {
		blob, readErr := os.ReadFile(backupName(stamp, i))
		if readErr != nil {
			t.Fatalf("%s: %v", backupName(stamp, i), readErr)
		}
		if string(blob) != "taken" {
			t.Fatalf("%s was overwritten on the way to giving up", backupName(stamp, i))
		}
	}
}

// A backup that could not be written has to come back as an error even
// though the file was created — O_EXCL only proves the name was free, and
// the caller reads a nil error as "the backup is safe".
//
// The encode is made to fail with a value the JSON encoder refuses, since
// the real trigger (a disk filling mid-write) is not reproducible; what
// encodeSyncClose does with a failing Sync or Close is covered above.
func TestWriteBackupJSONFailsWhenTheRowsCannotBeEncoded(t *testing.T) {
	t.Chdir(t.TempDir())
	const stamp = "20260821T031500Z"

	path, err := writeBackupJSON(stamp, map[string]any{"rows": make(chan int)})
	if err == nil {
		t.Fatal("returned nil for a backup that was never encoded")
	}
	if path != "" {
		t.Errorf("returned path %q alongside an error", path)
	}
	if !strings.Contains(err.Error(), backupName(stamp, 0)) {
		t.Errorf("error %q does not name the file it failed on", err)
	}
}

// A failure that is not "the name is taken" has to abort on the first
// attempt.  A read-only mount or a missing directory is not something a
// different filename fixes, and retrying it 100 times turns one clear
// error into a hundred.
func TestWriteBackupJSONDoesNotRetryARealFailure(t *testing.T) {
	gone := filepath.Join(t.TempDir(), "gone")
	if err := os.Mkdir(gone, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Chdir(gone)
	if err := os.Remove(gone); err != nil {
		t.Fatal(err)
	}

	const stamp = "20260821T031500Z"
	_, err := writeBackupJSON(stamp, []backupRow{{AnilistID: 1}})
	if err == nil {
		t.Fatal("writing into a deleted directory returned nil")
	}
	// Naming the first candidate is how we know it stopped there.
	if !strings.Contains(err.Error(), backupName(stamp, 0)) {
		t.Errorf("error %q does not name %q, so it did not fail on the first attempt", err, backupName(stamp, 0))
	}
	if strings.Contains(err.Error(), backupName(stamp, 1)) {
		t.Errorf("error %q names the second candidate; a missing directory is not a naming collision", err)
	}
}

// The same protection through runApply, which is the only caller that
// matters: a real apply must not be able to destroy the undo file of a
// run that already touched the table.
func TestRunApplyKeepsAnEarlierRunsUndoFile(t *testing.T) {
	t.Chdir(t.TempDir())

	// runApply stamps the name from time.Now(), so decoys are planted on
	// the second it will land in and the two after it.  Whichever it picks,
	// the file that was already there has to survive.
	const decoy = "an earlier run's only way back"
	now := time.Now().UTC()
	var decoys []string
	for i := range 3 {
		p := backupName(now.Add(time.Duration(i)*time.Second).Format(backupStamp), 0)
		if err := os.WriteFile(p, []byte(decoy), 0o644); err != nil {
			t.Fatal(err)
		}
		decoys = append(decoys, p)
	}

	var out bytes.Buffer
	if err := runApply(context.Background(), &out, &fakeStatements{}, []hant.RowResult{changedTitleRow(1, "星際牛仔")}, false); err != nil {
		t.Fatalf("runApply: %v", err)
	}

	for _, p := range decoys {
		blob, err := os.ReadFile(p)
		if err != nil {
			t.Fatalf("%s is gone: %v", p, err)
		}
		if string(blob) != decoy {
			t.Fatalf("runApply overwrote %s", p)
		}
	}
	matches, _ := filepath.Glob("backup-*-2.json")
	if len(matches) != 1 {
		t.Fatalf("found %v, want one suffixed backup for this run", matches)
	}
	var rows []backupRow
	blob, err := os.ReadFile(matches[0])
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(blob, &rows); err != nil {
		t.Fatalf("this run's backup is not readable: %v", err)
	}
	if len(rows) != 1 || rows[0].AnilistID != 1 {
		t.Fatalf("this run's backup holds %+v, want the row it was about to overwrite", rows)
	}
}

// Prevents: the backup path being visible only on the happy path.
//
// It used to be printed once, in the "Apply complete" block, and every
// error path returns before that — so an interrupted apply, which is
// exactly when an operator needs the undo file, printed rows written and
// no way to undo them.  It has to be on stdout before the first statement
// runs.
func TestRunApplyPrintsTheBackupPathOnAFailedRun(t *testing.T) {
	t.Chdir(t.TempDir())

	q := &fakeStatements{err: errors.New("deadlock detected")}
	var out bytes.Buffer
	if err := runApply(context.Background(), &out, q, []hant.RowResult{changedTitleRow(1, "星際牛仔")}, false); err == nil {
		t.Fatal("a failed statement reported success")
	}

	matches, _ := filepath.Glob("backup-*.json")
	if len(matches) != 1 {
		t.Fatalf("found %v, want the backup for the run that failed", matches)
	}
	if !strings.Contains(out.String(), matches[0]) {
		t.Errorf("output does not name %s, so the operator cannot undo what did land:\n%s", matches[0], out.String())
	}
}

// ─── 4c. --limit and the report path ─────────────────────────────────────────

// Prevents: a smoke run replacing the full report.
//
// The report is not a log.  Its simplified_rejections list is the queue
// an operator promotes titles to source='manual' from, so a 20-row report
// written over the whole-table one at the default path destroys a work
// queue while looking like a successful run.
func TestReportPathKeepsALimitedRunOffTheDefaultPath(t *testing.T) {
	cases := []struct {
		name        string
		out         string
		outExplicit bool
		limit       int
		want        string
	}{
		{
			name: "a whole-table run keeps the default",
			out:  defaultReportFile,
			want: defaultReportFile,
		},
		{
			name:  "a limited run gets its own file",
			out:   defaultReportFile,
			limit: 20,
			want:  "hant-report-limit-20.json",
		},
		{
			name:        "an operator who named the file gets the file they named",
			out:         "/out/smoke.json",
			outExplicit: true,
			limit:       20,
			want:        "/out/smoke.json",
		},
		{
			// --limit 0 is documented as "all rows", so it is not limited.
			name:  "--limit 0 is the whole table",
			out:   defaultReportFile,
			limit: 0,
			want:  defaultReportFile,
		},
		{
			name:  "a negative limit is not a limit either",
			out:   defaultReportFile,
			limit: -1,
			want:  defaultReportFile,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := reportPath(tc.out, tc.outExplicit, tc.limit); got != tc.want {
				t.Errorf("reportPath(%q, %v, %d) = %q, want %q", tc.out, tc.outExplicit, tc.limit, got, tc.want)
			}
		})
	}
}

// ─── 5. SIGINT ───────────────────────────────────────────────────────────────

// And through runApply: a cancelled apply must fail, must not print the
// completion summary, and must stop issuing statements.  A partial run
// that prints "Apply complete" is worse than one that crashes.
func TestRunApplyStopsAtABatchBoundaryOnCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	q := &fakeStatements{onCall: cancel}

	// Two full title batches plus a description batch: cancelling inside
	// the first must leave the rest unissued.
	var results []hant.RowResult
	for i := range hant.ApplyBatchSize + 1 {
		results = append(results, changedTitleRow(int32(i+1), "星際牛仔"))
	}
	results = append(results, changedDescRow(99999, "簡介"))

	out, err := applyInTempDir(t, ctx, q, results, false)

	if err == nil {
		t.Fatal("a cancelled apply returned nil")
	}
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled wrapped", err)
	}
	if len(q.titleBatches) != 1 {
		t.Fatalf("ran %d title batches after cancellation, want 1", len(q.titleBatches))
	}
	if len(q.descBatches) != 0 {
		t.Fatalf("ran %d description batches after the title column was cancelled, want 0", len(q.descBatches))
	}
	if strings.Contains(out, "Apply complete") {
		t.Errorf("an interrupted run printed a completion summary:\n%s", out)
	}
	// The backup still has to be on disk — it is what the operator needs
	// to undo the batches that did land.
	if matches, _ := filepath.Glob("backup-*.json"); len(matches) != 1 {
		t.Errorf("found %v, want the backup for the batches that did run", matches)
	}
}

// ─── batch boundaries ────────────────────────────────────────────────────────

// A batch is a whole statement, so a partial run is always a whole number
// of batches.  This pins the slicing that makes that true: no row written
// twice, none skipped, and the last short batch carrying the remainder.
func TestRunApplySlicesRowsIntoWholeBatches(t *testing.T) {
	const n = hant.ApplyBatchSize + 3

	var results []hant.RowResult
	for i := range n {
		results = append(results, changedTitleRow(int32(i+1), fmt.Sprintf("標題%d", i)))
	}

	q := &fakeStatements{}
	if _, err := applyInTempDir(t, context.Background(), q, results, false); err != nil {
		t.Fatalf("runApply: %v", err)
	}

	if len(q.titleBatches) != 2 {
		t.Fatalf("issued %d batches for %d rows, want 2", len(q.titleBatches), n)
	}
	var seen []int32
	for _, b := range q.titleBatches {
		if len(b.ids) != len(b.values) || len(b.ids) != len(b.sources) || len(b.ids) != len(b.hashes) {
			t.Fatalf("batch arrays are ragged: %d/%d/%d/%d", len(b.ids), len(b.values), len(b.sources), len(b.hashes))
		}
		seen = append(seen, b.ids...)
	}
	if len(seen) != n {
		t.Fatalf("statements carried %d ids in total, want %d", len(seen), n)
	}
	for i, id := range seen {
		if id != int32(i+1) {
			t.Fatalf("id at position %d = %d, want %d — a batch was repeated or skipped", i, id, i+1)
		}
	}
}

// ─── failures mid-apply ──────────────────────────────────────────────────────

// The two columns are written by two separate statements, so a failure
// has to name which one.  "apply failed: deadlock" sends an operator to
// the wrong column.
func TestRunApplyNamesTheColumnThatFailed(t *testing.T) {
	boom := errors.New("deadlock detected")

	cases := []struct {
		name     string
		results  []hant.RowResult
		wantIn   string
		wantNoIn string
	}{
		{
			name:     "the title statement failed",
			results:  []hant.RowResult{changedTitleRow(1, "星際牛仔")},
			wantIn:   "title_hant",
			wantNoIn: "description_hant",
		},
		{
			// Only a description write, so the title loop runs zero
			// batches and the failure can only come from the second.
			name:    "the description statement failed",
			results: []hant.RowResult{changedDescRow(1, "簡介")},
			wantIn:  "description_hant",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			q := &fakeStatements{err: boom}
			_, err := applyInTempDir(t, context.Background(), q, tc.results, false)

			if err == nil {
				t.Fatal("a failed statement reported success")
			}
			if !errors.Is(err, boom) {
				t.Fatalf("err = %v, want the statement's error wrapped", err)
			}
			if !strings.Contains(err.Error(), tc.wantIn) {
				t.Errorf("error %q does not name the %s column", err, tc.wantIn)
			}
			if tc.wantNoIn != "" && strings.Contains(err.Error(), tc.wantNoIn) {
				t.Errorf("error %q blames %s as well; only one statement ran", err, tc.wantNoIn)
			}
		})
	}
}
