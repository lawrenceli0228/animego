package main

import (
	"sort"
	"strconv"
)

// FribbEntry represents one entry from Fribb/anime-lists.
// Fields are integers; absent fields decode to zero.
type FribbEntry struct {
	AnilistID int `json:"anilist_id"`
	MalID     int `json:"mal_id"`
	AnidbID   int `json:"anidb_id"`
}

// BelEntry represents one entry from Rhilip/BangumiExtLinker.
// bgm_id, mal_id, anidb_id are strings in the source JSON.
type BelEntry struct {
	BgmID   string `json:"bgm_id"`
	MalID   string `json:"mal_id"`
	AnidbID string `json:"anidb_id"`
}

// MapEntry is one row in the output map.
type MapEntry struct {
	AnilistID int    `json:"anilist_id"`
	BgmID     int    `json:"bgm_id"`
	MalID     int    `json:"mal_id,omitempty"`
	AnidbID   int    `json:"anidb_id,omitempty"` // Fribb's anidb_id; 0 when absent. Enables anilist_id -> anidb_id -> AnimeTosho aid.
	Source    string `json:"source"`             // "mal" or "anidb"
}

// Stats carries summary counters returned alongside the built map.
type Stats struct {
	FribbCount int
	BelCount   int
	Mapped     int
	Conflicts  int // same anilist_id resolved to two different bgm_ids; mal-source wins
}

// mustInt parses a decimal string to int; returns 0 on blank or error.
func mustInt(s string) int {
	if s == "" {
		return 0
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		return 0
	}
	return n
}

// BuildMap joins the two datasets and returns a deduplicated, sorted slice.
// It is a pure function with no I/O; all network/file loading happens in main.
func BuildMap(fribb []FribbEntry, bel []BelEntry) ([]MapEntry, Stats) {
	stats := Stats{
		FribbCount: len(fribb),
		BelCount:   len(bel),
	}

	// Index BangumiExtLinker: mal_id → bgm_id, anidb_id → bgm_id.
	// If multiple BEL entries share the same external id, last-writer wins
	// (rare in practice; both source maps are deduplicated upstream).
	malToBgm := make(map[int]int, len(bel))
	anidbToBgm := make(map[int]int, len(bel))

	for _, e := range bel {
		bgm := mustInt(e.BgmID)
		if bgm == 0 {
			continue
		}
		if mal := mustInt(e.MalID); mal != 0 {
			malToBgm[mal] = bgm
		}
		if anidb := mustInt(e.AnidbID); anidb != 0 {
			anidbToBgm[anidb] = bgm
		}
	}

	// Walk Fribb entries and resolve each to a bgm_id.
	// anilist_id → best MapEntry found so far.
	seen := make(map[int]MapEntry, len(fribb)/2)

	for _, f := range fribb {
		if f.AnilistID == 0 {
			continue
		}

		// Try MAL join first.
		bgmViaMal := 0
		if f.MalID != 0 {
			bgmViaMal = malToBgm[f.MalID]
		}

		// Try AniDB fallback.
		bgmViaAnidb := 0
		if f.AnidbID != 0 {
			bgmViaAnidb = anidbToBgm[f.AnidbID]
		}

		// Pick the best candidate for this entry. AnidbID carries Fribb's
		// anidb_id whichever join resolved the bgm_id — a MAL-sourced binding
		// still has a usable AniDB id when Fribb lists one.
		var candidate MapEntry
		switch {
		case bgmViaMal != 0:
			candidate = MapEntry{
				AnilistID: f.AnilistID,
				BgmID:     bgmViaMal,
				MalID:     f.MalID,
				AnidbID:   f.AnidbID,
				Source:    "mal",
			}
		case bgmViaAnidb != 0:
			candidate = MapEntry{
				AnilistID: f.AnilistID,
				BgmID:     bgmViaAnidb,
				AnidbID:   f.AnidbID,
				Source:    "anidb",
			}
		default:
			continue // no BGM match
		}

		existing, conflict := seen[f.AnilistID]
		if !conflict {
			// First time we see this anilist_id.
			seen[f.AnilistID] = candidate
			continue
		}

		// Conflict: same anilist_id resolves to different bgm_ids.
		if existing.BgmID == candidate.BgmID {
			// Same resolution — not really a conflict; keep existing.
			continue
		}

		stats.Conflicts++

		// Prefer the MAL-sourced one; break ties by smaller bgm_id.
		if candidate.Source == "mal" && existing.Source != "mal" {
			seen[f.AnilistID] = candidate
		}
		// else keep existing (already MAL or we already have the better one)
	}

	// Flatten map → slice and sort by anilist_id.
	out := make([]MapEntry, 0, len(seen))
	for _, e := range seen {
		out = append(out, e)
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].AnilistID < out[j].AnilistID
	})

	stats.Mapped = len(out)
	return out, stats
}
