// Package torrents — rank.go
//
// The normalise → dedup → rank pipeline the aggregator runs over the
// merged, multi-source result before caching it.  Three pure functions,
// each returning a fresh slice (the inputs are never mutated, per the
// package's immutability convention):
//
//   - sourceRanks   : pre-computes a Source→score map from the registry
//     so dedup and rank can break ties by source without re-reading
//     Capabilities per comparison.  Higher score = preferred source.
//   - dedupByInfohash : collapses rows that share a non-empty infohash,
//     keeping the "best" copy (more seeders wins; nil seeders is the
//     weakest; ties break on source score).  Rows with an empty hash are
//     not deduplicable and pass through untouched.
//   - rankItems      : stable-sorts the deduped rows by seeders desc
//     (nil sinks to the bottom), then date desc, then source score.
//
// Why dedup needs source scores even though it has no Fetcher in hand:
// at this stage we hold TorrentItems, not Sources, so the per-source
// Priority (an aggregator concept) can't be read off the item.  We bridge
// that by pre-baking the registry's source ordering into a map keyed by
// the item's Source field.
package torrents

import (
	"sort"
	"time"
)

// sourceRanks builds a Source→score map from the registry's fan-out
// order.  Score is a "higher is better" priority used as the final
// tie-break in both dedup and rank.
//
// The ordering combines two signals, in this precedence:
//  1. The source's advertised Capabilities.Priority (higher wins) — the
//     forward-looking knob a richer source can set to outrank the RSS
//     scrapes.
//  2. Registration order as the tie-break within equal Priority (earlier
//     registered = preferred), preserving the canonical garden → acg →
//     nyaa order the package already documents.
//
// Sources that don't implement Capable advertise Priority 0 (via
// CapabilitiesOf), so today — when none of garden/acg/nyaa set it — the
// map degenerates to pure registration order, which is exactly the legacy
// behaviour.
//
// The returned map gives the first-ranked source the highest score and
// decreases by one per rank, so callers compare scores with a plain `>`.
// A Source absent from the map (shouldn't happen for merged items, but
// defensively) reads as 0 from a map lookup, i.e. lowest.
func sourceRanks(reg *Registry) map[Source]int {
	sources := reg.Sources()

	// order records each source's registration index so we can use it as a
	// stable secondary key when Priorities tie.
	type ranked struct {
		name     Source
		priority int
		regIndex int
	}
	ordered := make([]ranked, 0, len(sources))
	for i, s := range sources {
		ordered = append(ordered, ranked{
			name:     s.Name(),
			priority: CapabilitiesOf(s).Priority,
			regIndex: i,
		})
	}

	// Sort best-first: higher Priority wins; equal Priority keeps
	// registration order (lower index first).
	sort.SliceStable(ordered, func(a, b int) bool {
		if ordered[a].priority != ordered[b].priority {
			return ordered[a].priority > ordered[b].priority
		}
		return ordered[a].regIndex < ordered[b].regIndex
	})

	// Assign descending scores so the best source has the largest value.
	ranks := make(map[Source]int, len(ordered))
	for i, r := range ordered {
		ranks[r.name] = len(ordered) - i
	}
	return ranks
}

// dedupByInfohash collapses items that share the same non-empty infohash,
// keeping a single "best" representative per hash.  It also stamps each
// kept item's Infohash field with the value parsed from its magnet (so
// downstream/consumers see the normalised hash).
//
// Rules:
//   - The hash is parsed fresh from each item's Magnet via parseInfohash
//     — source-agnostic, independent of any pre-set Infohash field.
//   - An item whose parsed hash is "" is NOT deduplicable: it passes
//     through verbatim (its Infohash is left empty), in original order.
//   - Among items sharing a hash, "better" is: more seeders wins (a known
//     count beats nil; higher count beats lower); on a seeders tie the
//     higher source score (from ranks) wins; if still tied the first-seen
//     copy is kept (stable).
//
// Order of the survivors mirrors first-appearance order of each hash /
// each empty-hash row, so a caller that does not rank afterwards still
// gets a deterministic, merge-order-respecting slice.  (rankItems
// re-sorts anyway; preserving order here keeps dedup independently
// testable and side-effect-free.)
//
// Returns a new slice; the input is not mutated.
func dedupByInfohash(items []TorrentItem, ranks map[Source]int) []TorrentItem {
	out := make([]TorrentItem, 0, len(items))
	// indexByHash maps a hash to the position of its current best copy in
	// out, so we can replace in place when a better duplicate arrives
	// without disturbing the relative order of the survivors.
	indexByHash := make(map[string]int, len(items))

	for _, it := range items {
		hash := parseInfohash(it.Magnet)
		if hash == "" {
			// Not deduplicable — emit as-is, leaving Infohash empty.
			out = append(out, it)
			continue
		}

		// Stamp the normalised hash onto the kept copy.
		candidate := it
		candidate.Infohash = hash

		pos, seen := indexByHash[hash]
		if !seen {
			indexByHash[hash] = len(out)
			out = append(out, candidate)
			continue
		}

		// A duplicate: keep whichever copy is better, in the SAME slot so
		// survivor order is unchanged.
		if betterItem(candidate, out[pos], ranks) {
			out[pos] = candidate
		}
	}

	return out
}

// betterItem reports whether a should replace b when both carry the same
// infohash.  The ordering is: more seeders first (nil = unknown = worst),
// then higher source score.  It is strict — equal-on-all-keys returns
// false so the incumbent (first-seen) copy is retained.
func betterItem(a, b TorrentItem, ranks map[Source]int) bool {
	if c := compareSeeders(a.Seeders, b.Seeders); c != 0 {
		return c > 0
	}
	return ranks[a.Source] > ranks[b.Source]
}

// compareSeeders orders two optional seeder counts: a known count is
// always greater than nil ("unknown" sinks below any real number,
// including 0), and between two known counts the larger is greater.
// Returns >0 when a ranks above b, <0 when below, 0 when equal-rank
// (both nil, or equal counts).
func compareSeeders(a, b *int) int {
	switch {
	case a == nil && b == nil:
		return 0
	case a == nil:
		return -1
	case b == nil:
		return 1
	case *a != *b:
		if *a > *b {
			return 1
		}
		return -1
	default:
		return 0
	}
}

// rankItems returns a new slice sorted for presentation:
//  1. Seeders descending — a higher known count first; nil (unknown)
//     sinks to the bottom regardless of the other keys.
//  2. Date descending — newer first.  Dates are parsed leniently (see
//     parseItemDate); an unparseable / missing date sorts as the zero
//     time, i.e. oldest, so well-formed dates float above it.
//  3. Source score descending — the registry's preferred source wins the
//     final tie.
//
// The sort is stable, so items equal on all three keys keep their input
// (post-dedup, merge) order.  When every item has nil Seeders (the common
// case today, since only garden can report seeders and only sometimes),
// key 1 is inert and the result degrades cleanly to date-then-source
// order.
//
// Returns a new slice; the input is not mutated.
func rankItems(items []TorrentItem, ranks map[Source]int) []TorrentItem {
	out := make([]TorrentItem, len(items))
	copy(out, items)

	sort.SliceStable(out, func(i, j int) bool {
		if c := compareSeeders(out[i].Seeders, out[j].Seeders); c != 0 {
			return c > 0
		}
		di, dj := parseItemDate(out[i].Date), parseItemDate(out[j].Date)
		if !di.Equal(dj) {
			return di.After(dj)
		}
		return ranks[out[i].Source] > ranks[out[j].Source]
	})

	return out
}

// itemDateLayouts are the timestamp formats the upstream sources emit.
// RSS feeds (acg / nyaa) use RFC1123-style pubDate; garden's JSON uses
// RFC3339.  Parsed in order; the first that matches wins.
var itemDateLayouts = []string{
	time.RFC1123Z, // "Mon, 02 Jan 2006 15:04:05 -0700"
	time.RFC1123,  // "Mon, 02 Jan 2006 15:04:05 MST"
	time.RFC3339,  // "2006-01-02T15:04:05Z07:00"
}

// parseItemDate leniently parses an item's Date pointer into a time.Time
// for ordering.  A nil pointer, empty string, or unrecognised format
// yields the zero time (sorts oldest) — never an error, since a bad date
// must not break ranking of the rest.
func parseItemDate(d *string) time.Time {
	if d == nil || *d == "" {
		return time.Time{}
	}
	for _, layout := range itemDateLayouts {
		if t, err := time.Parse(layout, *d); err == nil {
			return t
		}
	}
	return time.Time{}
}
