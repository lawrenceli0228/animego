// Package dandanplay — season/part-aware ranking of anime_cache rows.
//
// Why this exists: the /match siteAnime fallback searches anime_cache by
// title with a tokenised ILIKE, then has to choose among the hits.  It
// used to take rows[0] — an arbitrary heap-order row — which for any
// multi-season franchise silently attached the WRONG season's score,
// year, episode count and anilistId to a correctly-matched anime.  The
// live symptom: dropping 無職転生Ⅲ files rendered 無職転生Ⅱ's badges and a
// "view details" link to season 2.
//
// The string logic that fixes it lives in internal/titlematch, which knows
// nothing about database rows and is therefore usable by any caller that has
// two titles to compare.  This file is the row-typed adapter layer: it pulls
// the title columns off a cache row and delegates.
//
// The invariant titlematch enforces, restated here because this is where it
// gets consumed: similarity and season marker are two INDEPENDENT signals.
// bangumi.NormalizeTitle deliberately STRIPS season markers, so every season
// of a franchise normalises to the same string and scores ~identically; the
// marker is therefore a hard gate, not a weight.  A season-3 query must never
// resolve to a season-2 row no matter how similar the titles read.

package dandanplay

import (
	"sort"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/titlematch"
)

// cacheRowTitles lists the four title columns of a cache row, skipping
// the nil/empty ones.
func cacheRowTitles(row *dbgen.SearchAnimeCacheForDandanplayRow) []string {
	out := make([]string, 0, 4)
	for _, p := range []*string{row.TitleChinese, row.TitleNative, row.TitleRomaji, row.TitleEnglish} {
		if p != nil && *p != "" {
			out = append(out, *p)
		}
	}
	return out
}

// rowMarker folds every title of a row into a single marker.
func rowMarker(row *dbgen.SearchAnimeCacheForDandanplayRow) titlematch.Marker {
	return titlematch.MarkerFor(cacheRowTitles(row)...)
}

// rowMatchesQuery reports whether a row that already cleared the
// season/part gate is a plausible answer for query, plus its similarity
// for ranking.  See titlematch.MatchesQuery for the floor-or-containment
// rule and why it needs both.
func rowMatchesQuery(row *dbgen.SearchAnimeCacheForDandanplayRow, query string) (bool, float64) {
	return titlematch.MatchesQuery(query, cacheRowTitles(row)...)
}

// rankCacheRows orders rows by descending confidence that they are the
// entry `query` names.  Rows whose season/part disagrees with the query
// are dropped entirely rather than ranked last — a wrong-season row is
// never an acceptable answer, so leaving it in the list would only give
// a caller that walks the slice (Phase 2) a chance to pick it.
//
// Ties break on ascending anilist_id so the result is deterministic.
// An empty query returns rows unchanged: with nothing to rank against,
// preserving the caller's order beats inventing one.
func rankCacheRows(rows []dbgen.SearchAnimeCacheForDandanplayRow, query string) []dbgen.SearchAnimeCacheForDandanplayRow {
	if query == "" || len(rows) < 2 {
		return rows
	}
	want := titlematch.ExtractMarker(query)

	type scored struct {
		row dbgen.SearchAnimeCacheForDandanplayRow
		sim float64
	}
	kept := make([]scored, 0, len(rows))
	for i := range rows {
		row := rows[i]
		if !rowMarker(&row).SameEntry(want) {
			continue
		}
		ok, sim := rowMatchesQuery(&row, query)
		if !ok {
			continue
		}
		kept = append(kept, scored{row: row, sim: sim})
	}
	sort.SliceStable(kept, func(i, j int) bool {
		if kept[i].sim != kept[j].sim {
			return kept[i].sim > kept[j].sim
		}
		return kept[i].row.AnilistID < kept[j].row.AnilistID
	})
	out := make([]dbgen.SearchAnimeCacheForDandanplayRow, 0, len(kept))
	for _, k := range kept {
		out = append(out, k.row)
	}
	return out
}

// pickCacheRow returns the single row that best answers `query`, or nil
// when nothing clears both the season/part gate and the similarity floor.
//
// Returning nil is a supported, common outcome: the caller renders an
// un-enriched result, which is strictly better than the confidently wrong
// enrichment this function replaced.
func pickCacheRow(rows []dbgen.SearchAnimeCacheForDandanplayRow, query string) *dbgen.SearchAnimeCacheForDandanplayRow {
	if len(rows) == 0 || query == "" {
		return nil
	}
	want := titlematch.ExtractMarker(query)

	var best *dbgen.SearchAnimeCacheForDandanplayRow
	bestSim := 0.0
	for i := range rows {
		row := rows[i]
		if !rowMarker(&row).SameEntry(want) {
			continue
		}
		ok, sim := rowMatchesQuery(&row, query)
		if !ok {
			continue
		}
		// Strict > keeps the lowest anilist_id on a tie, matching
		// rankCacheRows' ordering.
		if best == nil || sim > bestSim {
			picked := row
			best = &picked
			bestSim = sim
		}
	}
	return best
}
