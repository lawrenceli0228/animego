package hant

// Running the ladder over a whole table, and deciding which of its
// answers are worth writing.

import "log/slog"

// RowResult is one row's full outcome: what the ladder proposes, what is
// stored, and whether the two differ.
type RowResult struct {
	Row Row

	TitleManual bool
	DescManual  bool

	Title Decision
	Desc  Decision

	TitleChanged bool
	DescChanged  bool

	TitleStale StaleKind
	DescStale  StaleKind
}

// ClassifyAll runs the ladder over every row.  Pure: it reads the
// resolver and the rows and writes nothing, so the caller decides
// separately whether any of it reaches the table.
func ClassifyAll(r *Resolver, rows []Row) []RowResult {
	out := make([]RowResult, 0, len(rows))
	for i, row := range rows {
		if i > 0 && i%2000 == 0 {
			slog.Info("classification progress", "processed", i, "total", len(rows))
		}

		res := RowResult{
			Row:         row,
			TitleManual: isManual(row.TitleHantSource),
			DescManual:  isManual(row.DescHantSource),
			TitleStale:  r.checkStale(row, row.TitleHant, row.TitleHantSource, row.TitleHantHash),
			DescStale:   r.checkDescriptionStale(row),
		}

		if !res.TitleManual {
			res.Title = r.resolveTitle(row)
			res.TitleChanged = differs(res.Title, row.TitleHant, row.TitleHantSource, row.TitleHantHash)
		}
		if !res.DescManual {
			res.Desc = r.resolveDescription(row)
			res.DescChanged = differs(res.Desc, row.DescHant, row.DescHantSource, row.DescHantHash)
		}
		out = append(out, res)
	}
	slog.Info("classification complete", "total", len(rows))
	return out
}

// differs reports whether a proposed Decision would change the stored
// triple.  A Decision with no source proposes nothing and therefore never
// changes anything — the ladder reaching none of its tiers is not a
// reason to blank a column someone else filled.
func differs(d Decision, value, source, hash *string) bool {
	if d.Source == "" {
		return false
	}
	return !eq(value, d.Value) || !eq(source, d.Source) || !eq(hash, d.Hash)
}

func eq(stored *string, want string) bool {
	return stored != nil && *stored == want
}

// Writable returns the rows a run would actually write, per column.
//
// restaleOnly narrows to rows whose stored hash no longer matches the
// input its source claims to derive from, which is how an operator
// repairs drift without also promoting tiers.
func Writable(results []RowResult, restaleOnly bool) (titles, descs []RowResult) {
	for _, r := range results {
		if !r.TitleManual && r.TitleChanged && (!restaleOnly || r.TitleStale != StaleNone) {
			titles = append(titles, r)
		}
		if !r.DescManual && r.DescChanged && (!restaleOnly || r.DescStale != StaleNone) {
			descs = append(descs, r)
		}
	}
	return titles, descs
}
