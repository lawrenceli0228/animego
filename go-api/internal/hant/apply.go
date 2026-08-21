package hant

// The write path: pivoting resolved rows into the two batch statements,
// and the guard that stops a ragged batch reaching Postgres.
//
// Everything here is shared by the CLI (cmd/hantbackfill --apply) and the
// river worker (internal/queue/hant_backfill.go).  Neither owns it,
// because a second copy of the alignment guard is a copy that can be
// dropped from one of them.

import (
	"context"
	"fmt"
	"log/slog"
)

// ApplyBatchSize is how many rows go into one UPDATE.
const ApplyBatchSize = 500

// Writer is the slice of *dbgen.Queries the apply path uses.  Narrow on
// purpose: the generated Querier carries a hundred-odd methods, and an
// interface that wide cannot be faked in a test without a pool, which
// would leave the whole apply path -- the alignment guard, the
// offered-vs-written gap, the batch boundaries -- provable only by
// reading it.
type Writer interface {
	ApplyHantTitleBatch(ctx context.Context, anilistIds []int32, titles []string, sources []string, hashes []string) (int64, error)
	ApplyHantDescriptionBatch(ctx context.Context, anilistIds []int32, descriptions []string, sources []string, hashes []string) (int64, error)
}

// ApplyTitles writes the title_hant column for every row given, in
// ApplyBatchSize chunks, and returns the rows the database says it
// actually changed.
//
// That count can legitimately be lower than len(rows): the UPDATE's
// manual guard skips a row hand-promoted to source='manual' between the
// classification and the write.  Reporting len(rows) as the write count
// would hide exactly that.
func ApplyTitles(ctx context.Context, w Writer, rows []RowResult) (int64, error) {
	return applyBatches(ctx, len(rows), func(start, end int) (int64, error) {
		ids, vals, srcs, hashes := columns(rows[start:end], func(r RowResult) Decision { return r.Title })
		return writeBatch(ctx, ids, vals, srcs, hashes, w.ApplyHantTitleBatch)
	})
}

// ApplyDescriptions is the description_hant equivalent of ApplyTitles.
func ApplyDescriptions(ctx context.Context, w Writer, rows []RowResult) (int64, error) {
	return applyBatches(ctx, len(rows), func(start, end int) (int64, error) {
		ids, vals, srcs, hashes := columns(rows[start:end], func(r RowResult) Decision { return r.Desc })
		return writeBatch(ctx, ids, vals, srcs, hashes, w.ApplyHantDescriptionBatch)
	})
}

// columns pivots a slice of RowResult into the four parallel arrays the
// batch statements take.
func columns(rows []RowResult, pick func(RowResult) Decision) (ids []int32, values, sources, hashes []string) {
	ids = make([]int32, 0, len(rows))
	values = make([]string, 0, len(rows))
	sources = make([]string, 0, len(rows))
	hashes = make([]string, 0, len(rows))
	for _, r := range rows {
		d := pick(r)
		ids = append(ids, r.Row.AnilistID)
		values = append(values, d.Value)
		sources = append(sources, d.Source)
		hashes = append(hashes, d.Hash)
	}
	return ids, values, sources, hashes
}

// checkAligned refuses to send arrays of unequal length to an unnest join.
//
// Postgres evaluates several set-returning functions in one SELECT list
// in lockstep and pads the shorter ones with NULL instead of raising, so
// four ids and three hashes writes a NULL hash onto the last row and
// reports success.  columns() builds all four in a single pass and cannot
// produce a mismatch, which is exactly why the check is here rather than
// trusted to stay true -- it costs four comparisons per batch and turns a
// silent corruption into a refusal.
func checkAligned(ids []int32, values, sources, hashes []string) error {
	n := len(ids)
	if len(values) == n && len(sources) == n && len(hashes) == n {
		return nil
	}
	return fmt.Errorf(
		"refusing to write: unnest arrays are not the same length (ids=%d values=%d sources=%d hashes=%d); "+
			"Postgres would pad the short ones with NULL rather than fail",
		n, len(values), len(sources), len(hashes))
}

// batchWriter is the shape of both generated :execrows statements.
type batchWriter func(ctx context.Context, ids []int32, values, sources, hashes []string) (int64, error)

// writeBatch is checkAligned and the statement, in that order.
//
// The order is the whole point, so it lives in one named function rather
// than being spelled out at each of the two call sites: a guard that runs
// after the UPDATE, or that a later edit drops from one of the two
// closures, protects nothing.  Written this way the ordering is a thing a
// test can hold, with a fake statement that records whether it was
// reached.
func writeBatch(ctx context.Context, ids []int32, values, sources, hashes []string, write batchWriter) (int64, error) {
	if err := checkAligned(ids, values, sources, hashes); err != nil {
		return 0, err
	}
	return write(ctx, ids, values, sources, hashes)
}

// applyBatches runs fn over [0,n) in ApplyBatchSize chunks and sums the
// rows each one actually updated.
func applyBatches(ctx context.Context, n int, fn func(start, end int) (int64, error)) (int64, error) {
	var written int64
	for start := 0; start < n; start += ApplyBatchSize {
		// Checked before the batch, not after: cancellation should stop
		// the next write, and a check that only runs after the last one
		// can never prevent anything.
		if err := ctx.Err(); err != nil {
			return written, fmt.Errorf("interrupted after %d rows: %w", written, err)
		}
		end := min(start+ApplyBatchSize, n)
		rows, err := fn(start, end)
		if err != nil {
			return written, fmt.Errorf("batch [%d:%d]: %w", start, end, err)
		}
		written += rows
		slog.Info("batch written", "start", start, "end", end, "rows_updated", rows)
	}
	return written, nil
}
