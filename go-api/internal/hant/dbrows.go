package hant

// The one place anime_cache columns are mapped onto Row.
//
// Kept in its own file so the ladder, the gate and the OpenCC port stay
// free of the generated code — but kept in this package rather than at
// each call site, because there are two call sites now (the CLI and the
// river worker) and the mapping is silently wrong-able: title_hant_source
// and title_hant_source_hash differ by one word, and swapping them
// produces a run that compiles, reports plausible numbers, and declares
// every row stale.

import dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"

// RowsFromDB converts the whole-table read into ladder input.
//
// limit > 0 stops after that many rows.  It does NOT reduce the read —
// ListAnimeForHantBackfill is a whole-table statement and the rows are
// already in memory — so it buys a shorter classification pass and
// nothing else.  0 or negative means all of them.
func RowsFromDB(dbRows []dbgen.ListAnimeForHantBackfillRow, limit int) []Row {
	rows := make([]Row, 0, len(dbRows))
	for _, r := range dbRows {
		if limit > 0 && len(rows) >= limit {
			break
		}
		rows = append(rows, Row{
			AnilistID:       r.AnilistID,
			TitleNative:     r.TitleNative,
			TitleChinese:    r.TitleChinese,
			DescriptionCN:   r.DescriptionCn,
			TitleHant:       r.TitleHant,
			TitleHantSource: r.TitleHantSource,
			TitleHantHash:   r.TitleHantSourceHash,
			DescHant:        r.DescriptionHant,
			DescHantSource:  r.DescriptionHantSource,
			DescHantHash:    r.DescriptionHantSourceHash,
		})
	}
	return rows
}
