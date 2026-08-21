package hant

// apply.go is the write path both entry points share: the CLI's --apply
// and the river worker's periodic sweep.  Every test below pins a defect
// a review found in it after the fact -- the code is correct now, and
// these exist so it stays that way.
//
// Nothing here touches Postgres.  The two batch statements reach the
// database through a two-method interface, so the path is exercised with
// fakes; the assertions that need a real server (that the UPDATE's manual
// guard actually holds, that unnest pads rather than raises) live in
// test/integration.

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

// batchArgs is one call into one of the two generated statements.
type batchArgs struct {
	ids                     []int32
	values, sources, hashes []string
}

// ─── batch array alignment ───────────────────────────────────────────────────

// Prevents: a ragged batch reaching Postgres.
//
// Several unnest()s in one SELECT list are evaluated in lockstep and the
// short ones are padded with NULL rather than raising, so four ids and
// three hashes writes a NULL hash onto the fourth row and comes back
// reporting four rows updated.  The run looks clean and the column is
// corrupt.  checkAligned only helps if it runs first, so what is asserted
// here is the ordering: the statement must not be reached at all.
func TestWriteBatchRefusesRaggedArraysBeforeTheStatementRuns(t *testing.T) {
	ids := []int32{1, 2, 3, 4}
	four := []string{"a", "b", "c", "d"}
	three := []string{"a", "b", "c"}
	five := []string{"a", "b", "c", "d", "e"}

	cases := []struct {
		name                    string
		values, sources, hashes []string
		wantIn                  []string
	}{
		// The case the guard was written for, verbatim from its comment.
		{"three hashes for four ids", four, four, three, []string{"ids=4", "hashes=3"}},
		{"short values", three, four, four, []string{"ids=4", "values=3"}},
		{"short sources", four, three, four, []string{"ids=4", "sources=3"}},
		// Over-long is just as bad: the extra element is dropped silently.
		{"long values", five, four, four, []string{"ids=4", "values=5"}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			reached := false
			written, err := writeBatch(context.Background(), ids, tc.values, tc.sources, tc.hashes,
				func(context.Context, []int32, []string, []string, []string) (int64, error) {
					reached = true
					return int64(len(ids)), nil
				})

			if reached {
				t.Fatal("the statement ran on a ragged batch — Postgres pads with NULL and reports success, so the guard has to stop it before the call, not after")
			}
			if err == nil {
				t.Fatal("a ragged batch must be refused")
			}
			if written != 0 {
				t.Fatalf("written = %d on a refusal, want 0 — a refused batch changed nothing", written)
			}
			// The operator has to be able to see which array was short.
			for _, want := range tc.wantIn {
				if !strings.Contains(err.Error(), want) {
					t.Errorf("error %q does not name %q; the message is the only clue to which array was wrong", err, want)
				}
			}
		})
	}
}

// Prevents: a guard that refuses everything, or that quietly reshapes the
// arrays on the way past.  An aligned batch must arrive at the statement
// byte-for-byte as it was built.
func TestWriteBatchForwardsAlignedArraysUntouched(t *testing.T) {
	ids := []int32{16498, 1}
	values := []string{"進擊的巨人", "星際牛仔"}
	sources := []string{SrcWikipedia, SrcAnilist}
	hashes := []string{SourceHash("進擊的巨人"), SourceHash("星際牛仔")}

	var got batchArgs
	written, err := writeBatch(context.Background(), ids, values, sources, hashes,
		func(_ context.Context, i []int32, v, s, h []string) (int64, error) {
			got = batchArgs{ids: i, values: v, sources: s, hashes: h}
			return 2, nil
		})
	if err != nil {
		t.Fatalf("aligned batch refused: %v", err)
	}
	if written != 2 {
		t.Fatalf("written = %d, want the statement's own count (2)", written)
	}
	want := batchArgs{ids: ids, values: values, sources: sources, hashes: hashes}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("statement received %+v, want %+v", got, want)
	}
}

// An empty batch is aligned.  applyBatches never produces one, but a
// guard that treated len 0 as a mismatch would turn "nothing to write"
// into a failed run.
func TestWriteBatchAcceptsAnEmptyBatch(t *testing.T) {
	if err := checkAligned(nil, nil, nil, nil); err != nil {
		t.Fatalf("empty batch refused: %v", err)
	}
}

// ─── cancellation ────────────────────────────────────────────────────────────

// Prevents: the cancellation check drifting to the bottom of the loop.
//
// resolve_test.go already covers cancelling partway through a run.  What
// it cannot see is the position of the check: a check at the end of the
// body also stops "after one batch", and would still let the first batch
// run against a context that was already dead.  A sweep against
// production rewrites up to ~12k rows, and a caller that cancels before
// it starts means none of them.
func TestApplyBatchesStartsNothingOnAnAlreadyCancelledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	calls := 0
	written, err := applyBatches(ctx, ApplyBatchSize*3, func(start, end int) (int64, error) {
		calls++
		return int64(end - start), nil
	})

	if calls != 0 {
		t.Fatalf("ran %d batches on a cancelled context, want 0 — the check has to be at the top of the loop", calls)
	}
	if written != 0 {
		t.Fatalf("written = %d, want 0", written)
	}
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want it to wrap context.Canceled so a caller can tell a cancellation from a failure", err)
	}
}

// The error has to carry both the cause and how far the run got, because
// the answer to "what state is the table in now?" is that number.
func TestApplyBatchesReportsHowFarItGotWhenCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	calls := 0
	written, err := applyBatches(ctx, ApplyBatchSize*4, func(start, end int) (int64, error) {
		calls++
		if calls == 2 {
			cancel() // Ctrl-C during the second batch
		}
		return int64(end - start), nil
	})

	if calls != 2 {
		t.Fatalf("ran %d batches, want the two that had already started", calls)
	}
	if want := int64(ApplyBatchSize * 2); written != want {
		t.Fatalf("written = %d, want %d — the completed batches still happened", written, want)
	}
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled wrapped", err)
	}
	if !strings.Contains(err.Error(), fmt.Sprint(ApplyBatchSize*2)) {
		t.Errorf("error %q does not say how many rows were already written", err)
	}
}

// ─── failures mid-apply ──────────────────────────────────────────────────────

// A statement that fails has to stop the run and say which batch and how
// many rows were already committed, because that number is the answer to
// "what state is the table in now?".  Swallowing it would leave a
// half-written column reported as a success.
func TestApplyBatchesStopsAndLocatesAFailedStatement(t *testing.T) {
	boom := errors.New("deadlock detected")

	calls := 0
	written, err := applyBatches(context.Background(), ApplyBatchSize*4, func(start, end int) (int64, error) {
		calls++
		if calls == 3 {
			return 0, boom
		}
		return int64(end - start), nil
	})

	if calls != 3 {
		t.Fatalf("ran %d batches, want 3 — the run must stop at the failure, not carry on", calls)
	}
	if want := int64(ApplyBatchSize * 2); written != want {
		t.Fatalf("written = %d, want %d — the two committed batches are still committed", written, want)
	}
	if !errors.Is(err, boom) {
		t.Fatalf("err = %v, want the statement's own error wrapped", err)
	}
	// The range is what tells an operator which ids to look at.
	if !strings.Contains(err.Error(), fmt.Sprintf("[%d:%d]", ApplyBatchSize*2, ApplyBatchSize*3)) {
		t.Errorf("error %q does not locate the failed batch", err)
	}
}

// ─── the two column entry points ─────────────────────────────────────────────

// ApplyTitles and ApplyDescriptions are the only things that decide which
// Decision off a RowResult reaches which column.  Crossing them would
// write synopses into title_hant and pass every other test in this file,
// because both statements take the same four array shapes.
func TestApplyRoutesEachColumnToItsOwnStatement(t *testing.T) {
	rows := []RowResult{
		{
			Row:   Row{AnilistID: 7},
			Title: Decision{Source: SrcAnilist, Value: "心之谷", Hash: SourceHash("心之谷")},
			Desc:  Decision{Source: SrcOpenCC, Value: "簡介", Hash: SourceHash("简介")},
		},
	}

	q := &recordingWriter{}
	if _, err := ApplyTitles(context.Background(), q, rows); err != nil {
		t.Fatalf("ApplyTitles: %v", err)
	}
	if _, err := ApplyDescriptions(context.Background(), q, rows); err != nil {
		t.Fatalf("ApplyDescriptions: %v", err)
	}

	if len(q.titles) != 1 || len(q.descs) != 1 {
		t.Fatalf("statements ran %d title / %d description batches, want one each", len(q.titles), len(q.descs))
	}
	if got := q.titles[0].values[0]; got != "心之谷" {
		t.Errorf("title_hant batch carried %q, want the Title Decision", got)
	}
	if got := q.titles[0].sources[0]; got != SrcAnilist {
		t.Errorf("title_hant batch carried source %q, want the Title Decision's", got)
	}
	if got := q.descs[0].values[0]; got != "簡介" {
		t.Errorf("description_hant batch carried %q, want the Desc Decision", got)
	}
	if got := q.descs[0].sources[0]; got != SrcOpenCC {
		t.Errorf("description_hant batch carried source %q, want the Desc Decision's", got)
	}
}

// Nothing to write must not issue a statement.  An UPDATE against four
// empty arrays is a round-trip that changes nothing, and the steady state
// of the periodic sweep is exactly this case.
func TestApplyWithNoRowsIssuesNoStatement(t *testing.T) {
	q := &recordingWriter{}
	titles, err := ApplyTitles(context.Background(), q, nil)
	if err != nil || titles != 0 {
		t.Fatalf("ApplyTitles(nil) = %d, %v, want 0, nil", titles, err)
	}
	descs, err := ApplyDescriptions(context.Background(), q, nil)
	if err != nil || descs != 0 {
		t.Fatalf("ApplyDescriptions(nil) = %d, %v, want 0, nil", descs, err)
	}
	if len(q.titles)+len(q.descs) != 0 {
		t.Fatalf("issued %d statements for no rows", len(q.titles)+len(q.descs))
	}
}

// recordingWriter stands in for *dbgen.Queries and remembers what each
// statement was handed.
type recordingWriter struct {
	titles, descs []batchArgs
}

func (w *recordingWriter) ApplyHantTitleBatch(_ context.Context, ids []int32, values, sources, hashes []string) (int64, error) {
	w.titles = append(w.titles, batchArgs{ids: ids, values: values, sources: sources, hashes: hashes})
	return int64(len(ids)), nil
}

func (w *recordingWriter) ApplyHantDescriptionBatch(_ context.Context, ids []int32, values, sources, hashes []string) (int64, error) {
	w.descs = append(w.descs, batchArgs{ids: ids, values: values, sources: sources, hashes: hashes})
	return int64(len(ids)), nil
}

var _ Writer = (*recordingWriter)(nil)
