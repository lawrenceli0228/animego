// Package dandanplay — buildEpisodeMap mirrors server/utils/episodeMap.js
// verbatim.  3-level fallback (numeric / OVA-special / 1-based index on
// pure-numeric pool) with first-match wins.
//
// CRITICAL: off-by-one risk lives at level 3.  pool is 0-indexed,
// requested episode numbers are 1-indexed.  pool[epNum - 1].  Tests
// must cover every boundary (epNum=1 → pool[0]; epNum > len(pool) →
// no entry).

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

// BuildEpisodeMap returns a map[int]EpisodeMapEntry keyed on the
// requested episode numbers.  Three passes:
//
//	1. Exact numeric: dandanEp.Number == requestedEp.
//	2. OVA/Special: rawEpisodeNumber matches "^[OS]\d+$" and the digit
//	   tail equals the requested episode number.
//	3. Index fallback: pool[epNum-1] where pool is the subset of
//	   dandanEpisodes with pure-numeric rawEpisodeNumber.  When no such
//	   subset exists, pool defaults to the full list so we don't lose
//	   matches for malformed feeds.
//
// First-match wins — once a requested episode has been mapped, later
// passes skip it.
//
// Returns an empty map when dandanEpisodes is empty.  The caller can
// detect "nothing matched" via len(map) == 0 and fall through to the
// next phase.
func BuildEpisodeMap(dandanEpisodes []DandanEpisode, requestedEpisodes []int) map[int]EpisodeMapEntry {
	out := make(map[int]EpisodeMapEntry, len(requestedEpisodes))
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
				out[ep] = EpisodeMapEntry{DandanEpisodeID: de.DandanEpisodeID, Title: de.Title}
				break
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
					out[ep] = EpisodeMapEntry{DandanEpisodeID: de.DandanEpisodeID, Title: de.Title}
					break
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
			de := pool[idx]
			out[ep] = EpisodeMapEntry{DandanEpisodeID: de.DandanEpisodeID, Title: de.Title}
		}
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
