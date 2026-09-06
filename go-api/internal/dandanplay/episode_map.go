// Package dandanplay — buildEpisodeMap mirrors server/utils/episodeMap.js
// verbatim.  3-level fallback (numeric / OVA-special / 1-based index on
// pure-numeric pool) with first-match wins.
//
// CRITICAL: off-by-one risk lives at level 3.  pool is 0-indexed,
// requested episode numbers are 1-indexed.  pool[epNum - 1].  Tests
// must cover every boundary (epNum=1 → pool[0]; epNum > len(pool) →
// no entry).
//
// # Why the relation is built as an edge set and flattened afterwards
//
// The correspondence between a local episode number and an upstream episode is
// not one-to-one, in either direction, and a map[int]EpisodeMapEntry cannot say
// so.  Both directions are real:
//
//   - one-to-many: two upstream entries carry the same episode number — a
//     broadcast cut and a director's cut, a subject whose numbering restarts.
//     The old code took the first and `break`ed, and the second became
//     unreachable with no signal that it had ever existed.  Every consumer
//     downstream — the danmaku track, the episode title, the "N mapped"
//     counter, the picker's pre-selection — read the first and looked right.
//   - many-to-one: two requested episodes land on the same upstream entry.
//     This one is usually TRUE rather than broken: a folder holding the same
//     episode twice under two numberings (say 1 from this season and 29 from
//     the franchise's count) genuinely has two files for one upstream episode.
//     Removing the second would take a file's chip away in the ad-hoc player
//     path, which reads its episode strip from this map.
//
// So the fix is not to de-duplicate the matching; it is to stop the type from
// lying about it.  BuildEpisodeLinks holds every candidate, BuildEpisodeMap
// flattens it to the one-per-episode shape the wire and the player still want,
// and the flattening is now a named, tested step rather than a `break`.
//
// This matters before a per-episode mapping layer exists rather than after:
// such a layer's whole purpose is to carry relations single integers cannot,
// and feeding it through a function that silently keeps the first would
// re-flatten them on the way in.

package dandanplay

import "regexp"

// DandanEpisode is one entry from the dandanplay episodes payload.
// Mirrors the JS object shape produced by service.js fetchDandanEpisodes.
type DandanEpisode struct {
	DandanEpisodeID  int64  `json:"dandanEpisodeId"`
	Title            string `json:"title"`
	RawEpisodeNumber string `json:"rawEpisodeNumber"`
	Number           *int   `json:"number"` // nil when the title carries no parseable number
}

// EpisodeMapEntry is one value in the {episode → {dandanEpisodeId, title}}
// map returned to the frontend.  JSON tags are lowerCamel — match
// Express.
type EpisodeMapEntry struct {
	DandanEpisodeID int64  `json:"dandanEpisodeId"`
	Title           string `json:"title"`
}

// ovaPrefixRe matches "^[OS]\d+$" — case-insensitive Special / OVA
// rawEpisodeNumber form (e.g. "O1", "S2", "o03").  Used at level 2.
var ovaPrefixRe = regexp.MustCompile(`(?i)^[OS](\d+)$`)

// BuildEpisodeLinks returns EVERY upstream candidate for each requested
// episode number.  Three passes:
//
//	1. Exact numeric: dandanEp.Number == requestedEp.
//	2. OVA/Special: rawEpisodeNumber matches "^[OS]\d+$" and the digit
//	   tail equals the requested episode number.
//	3. Index fallback: pool[epNum-1] where pool is the subset of
//	   dandanEpisodes with pure-numeric rawEpisodeNumber.  When no such
//	   subset exists, pool defaults to the full list so we don't lose
//	   matches for malformed feeds.
//
// The passes are a priority order, not a merge: an episode that matched at
// level 1 is not also given level 2's or level 3's answer, because an exact
// numeric match and an index guess are not two opinions of equal standing.
// WITHIN a level, though, every match is kept — that is the whole difference
// from the previous version, which stopped at the first.
//
// Returns an empty map when dandanEpisodes is empty.
func BuildEpisodeLinks(dandanEpisodes []DandanEpisode, requestedEpisodes []int) map[int][]EpisodeMapEntry {
	out := make(map[int][]EpisodeMapEntry, len(requestedEpisodes))
	if len(dandanEpisodes) == 0 {
		return out
	}

	// Pass 1: exact numeric (Number pointer matches requested int).
	for _, ep := range requestedEpisodes {
		if _, done := out[ep]; done {
			continue
		}
		for _, de := range dandanEpisodes {
			if de.Number != nil && *de.Number == ep {
				out[ep] = append(out[ep], entryOf(de))
			}
		}
	}

	// Pass 2: OVA / Special prefix — "O1" or "S2" with the digit
	// matching the requested episode.
	for _, ep := range requestedEpisodes {
		if _, done := out[ep]; done {
			continue
		}
		for _, de := range dandanEpisodes {
			m := ovaPrefixRe.FindStringSubmatch(de.RawEpisodeNumber)
			if len(m) >= 2 {
				if parseDigits(m[1]) == ep {
					out[ep] = append(out[ep], entryOf(de))
				}
			}
		}
	}

	// Pass 3: index fallback on pure-numeric pool.  Filter for entries
	// whose rawEpisodeNumber is pure digits (level 1 candidates) so
	// specials/openings/endings (C1/C2/...) are excluded from index
	// math.  When the filtered pool is empty, fall through to the full
	// list so we don't drop matches for feeds that have only OVAs.
	pool := dandanEpisodes[:0:0]
	for _, de := range dandanEpisodes {
		if pureDigitsRe.MatchString(de.RawEpisodeNumber) {
			pool = append(pool, de)
		}
	}
	if len(pool) == 0 {
		pool = dandanEpisodes
	}

	for _, ep := range requestedEpisodes {
		if _, done := out[ep]; done {
			continue
		}
		idx := ep - 1 // 1-indexed request, 0-indexed slice
		if idx >= 0 && idx < len(pool) {
			out[ep] = append(out[ep], entryOf(pool[idx]))
		}
	}

	return out
}

// entryOf is the one place a DandanEpisode becomes a map entry, so the three
// passes cannot drift in what they carry across.
func entryOf(de DandanEpisode) EpisodeMapEntry {
	return EpisodeMapEntry{DandanEpisodeID: de.DandanEpisodeID, Title: de.Title}
}

// BuildEpisodeMap is BuildEpisodeLinks flattened to one entry per episode: the
// shape the wire, the player and the title labels have always taken.
//
// The first candidate of the winning level wins, which is exactly what the
// `break` used to produce — this function is behaviour-for-behaviour identical
// to the version before the split, and the tests that pinned that version are
// what says so.  What changed is that the discarding is now a step with a name
// and a caller who could choose otherwise, instead of a control-flow keyword.
//
// Callers detect "nothing matched" via len(map) == 0 and fall through to the
// next phase; note that this counts EPISODES matched, not upstream entries
// used, so two episodes sharing one entry count as two.
func BuildEpisodeMap(dandanEpisodes []DandanEpisode, requestedEpisodes []int) map[int]EpisodeMapEntry {
	links := BuildEpisodeLinks(dandanEpisodes, requestedEpisodes)
	out := make(map[int]EpisodeMapEntry, len(links))
	for ep, candidates := range links {
		if len(candidates) == 0 {
			continue
		}
		out[ep] = candidates[0]
	}
	return out
}

// parseDigits is a tiny helper for the OVA prefix match — the regex
// already guaranteed the captured group is pure digits, so we can skip
// the strconv error branch by deferring to the package-level helper.
func parseDigits(s string) int {
	n := 0
	for _, r := range s {
		n = n*10 + int(r-'0')
	}
	return n
}
