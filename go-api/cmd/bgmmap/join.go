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
// bgm_id, mal_id, anidb_id are strings in the source JSON.  Name, NameCN and
// Date only feed the review report — the join itself never reads them.
type BelEntry struct {
	BgmID   string `json:"bgm_id"`
	MalID   string `json:"mal_id"`
	AnidbID string `json:"anidb_id"`
	Name    string `json:"name"`
	NameCN  string `json:"name_cn"`
	Date    string `json:"date"`
}

// MapEntry is one row in the output map.
type MapEntry struct {
	AnilistID int    `json:"anilist_id"`
	BgmID     int    `json:"bgm_id"`
	MalID     int    `json:"mal_id,omitempty"`
	AnidbID   int    `json:"anidb_id,omitempty"` // Fribb's anidb_id; 0 when absent.
	Source    string `json:"source"`             // "mal", "anidb" or "override"
}

// SkipReason says why the join refused to map an AniList id.
type SkipReason string

const (
	// SkipMalAnidbDisagree: the MAL id reaches one subject and the AniDB id
	// reaches others.  At least one upstream link is wrong; nothing here can
	// say which.
	SkipMalAnidbDisagree SkipReason = "mal_anidb_disagree"
	// SkipAmbiguousMal: several subjects claim the MAL id, and the AniDB id
	// does not single one out.
	SkipAmbiguousMal SkipReason = "ambiguous_mal"
	// SkipAmbiguousAnidb: several subjects claim the AniDB id and there is no
	// MAL answer to choose between them.
	SkipAmbiguousAnidb SkipReason = "ambiguous_anidb"
	// SkipFribbRowsDisagree: Fribb lists the AniList id more than once and
	// the rows reach different subjects.
	SkipFribbRowsDisagree SkipReason = "fribb_rows_disagree"
)

// Skip records an AniList id the join refused to map.  ViaMal and ViaAnidb
// are the Bangumi subjects each path reached, sorted, so a reviewer can see
// the disagreement without re-running the join.
type Skip struct {
	AnilistID int
	Reason    SkipReason
	ViaMal    []int
	ViaAnidb  []int
}

// Stats carries summary counters returned alongside the built map.
type Stats struct {
	FribbCount int
	BelCount   int
	Mapped     int
	Skipped    int
}

// Result is everything one join produces.
type Result struct {
	Entries []MapEntry
	Skips   []Skip
	Stats   Stats
}

// AnidbEntry is one AniList -> AniDB pair, straight from Fribb.
type AnidbEntry struct {
	AnilistID int `json:"anilist_id"`
	AnidbID   int `json:"anidb_id"`
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

// idSet is a set of ids: the Bangumi subjects one external id reaches, or
// the AniDB ids Fribb gives one AniList id.
type idSet map[int]struct{}

func (s idSet) sorted() []int {
	out := make([]int, 0, len(s))
	for b := range s {
		out = append(out, b)
	}
	sort.Ints(out)
	return out
}

// only returns the single member of a one-element set.
func (s idSet) only() int {
	for b := range s {
		return b
	}
	return 0
}

func (s idSet) has(b int) bool {
	_, ok := s[b]
	return ok
}

// belIndex maps each external id to every subject that claims it.  Sets, not
// last-writer-wins: when two subjects claim one id the old join kept whichever
// came last in the file, which made the answer depend on upstream row order
// and silently bound sequels, films and OVAs to each other's ids.
type belIndex struct {
	byMal   map[int]idSet
	byAnidb map[int]idSet
}

func indexBel(bel []BelEntry) belIndex {
	idx := belIndex{byMal: map[int]idSet{}, byAnidb: map[int]idSet{}}
	add := func(m map[int]idSet, key, bgm int) {
		if key == 0 {
			return
		}
		if m[key] == nil {
			m[key] = idSet{}
		}
		m[key][bgm] = struct{}{}
	}
	for _, e := range bel {
		bgm := mustInt(e.BgmID)
		if bgm == 0 {
			continue
		}
		add(idx.byMal, mustInt(e.MalID), bgm)
		add(idx.byAnidb, mustInt(e.AnidbID), bgm)
	}
	return idx
}

// rowAnswer is what one Fribb row says about its AniList id.
type rowAnswer struct {
	entry  MapEntry   // valid when reason == "" and matched
	reason SkipReason // non-empty when the row is refused
	mal    idSet
	anidb  idSet
}

func (a rowAnswer) matched() bool { return a.entry.BgmID != 0 }

// resolveRow applies the join rule to one Fribb row:
//
//   - one subject via MAL, and the AniDB id either reaches nothing or also
//     reaches that subject           -> that subject
//   - several subjects via MAL       -> the one the AniDB id also reaches,
//     if exactly one; otherwise refused
//   - nothing via MAL                -> the AniDB subject if exactly one;
//     otherwise refused
//   - one subject via MAL that the AniDB id does not reach -> refused
func resolveRow(f FribbEntry, idx belIndex) rowAnswer {
	// Key 0 is never indexed, so a missing MAL or AniDB id reaches nothing.
	ans := rowAnswer{mal: idx.byMal[f.MalID], anidb: idx.byAnidb[f.AnidbID]}
	viaMal := func(bgm int) MapEntry {
		return MapEntry{AnilistID: f.AnilistID, BgmID: bgm, MalID: f.MalID, AnidbID: f.AnidbID, Source: "mal"}
	}
	switch {
	case len(ans.mal) == 1:
		bgm := ans.mal.only()
		if len(ans.anidb) > 0 && !ans.anidb.has(bgm) {
			ans.reason = SkipMalAnidbDisagree
			return ans
		}
		ans.entry = viaMal(bgm)
	case len(ans.mal) > 1:
		both := idSet{}
		for b := range ans.mal {
			if ans.anidb.has(b) {
				both[b] = struct{}{}
			}
		}
		if len(both) != 1 {
			ans.reason = SkipAmbiguousMal
			return ans
		}
		ans.entry = viaMal(both.only())
	case len(ans.anidb) == 1:
		ans.entry = MapEntry{AnilistID: f.AnilistID, BgmID: ans.anidb.only(), AnidbID: f.AnidbID, Source: "anidb"}
	case len(ans.anidb) > 1:
		ans.reason = SkipAmbiguousAnidb
	}
	return ans
}

// refusalOrder ranks reasons so an id refused by several of its Fribb rows
// reports the same reason whatever order Fribb lists the rows in.
var refusalOrder = []SkipReason{SkipMalAnidbDisagree, SkipAmbiguousMal, SkipAmbiguousAnidb}

// decideID combines the answers of every Fribb row for one AniList id.  The
// id is mapped only when every row that reaches Bangumi at all agrees on one
// subject; a clean row cannot vouch for a refused or contradicting one.
func decideID(anilistID int, answers []rowAnswer) (MapEntry, *Skip) {
	mal, anidb, subjects := idSet{}, idSet{}, idSet{}
	reasons := map[SkipReason]bool{}
	var best MapEntry
	for _, a := range answers {
		for b := range a.mal {
			mal[b] = struct{}{}
		}
		for b := range a.anidb {
			anidb[b] = struct{}{}
		}
		if a.reason != "" {
			reasons[a.reason] = true
			continue
		}
		if !a.matched() {
			continue
		}
		subjects[a.entry.BgmID] = struct{}{}
		if best.BgmID == 0 || (a.entry.Source == "mal" && best.Source != "mal") {
			best = a.entry
		}
	}
	skip := func(r SkipReason) *Skip {
		return &Skip{AnilistID: anilistID, Reason: r, ViaMal: mal.sorted(), ViaAnidb: anidb.sorted()}
	}
	if len(subjects) > 1 {
		return MapEntry{}, skip(SkipFribbRowsDisagree)
	}
	for _, r := range refusalOrder {
		if reasons[r] {
			return MapEntry{}, skip(r)
		}
	}
	return best, nil
}

// BuildMap joins the two datasets and returns the map, sorted by AniList id,
// together with every id it refused to map.  It is a pure function with no
// I/O; all network/file loading happens in main.
func BuildMap(fribb []FribbEntry, bel []BelEntry) Result {
	idx := indexBel(bel)

	answers := map[int][]rowAnswer{}
	order := []int{}
	for _, f := range fribb {
		if f.AnilistID == 0 {
			continue
		}
		if _, seen := answers[f.AnilistID]; !seen {
			order = append(order, f.AnilistID)
		}
		answers[f.AnilistID] = append(answers[f.AnilistID], resolveRow(f, idx))
	}

	res := Result{Entries: []MapEntry{}, Skips: []Skip{}}
	for _, id := range order {
		entry, skip := decideID(id, answers[id])
		switch {
		case skip != nil:
			res.Skips = append(res.Skips, *skip)
		case entry.BgmID != 0:
			res.Entries = append(res.Entries, entry)
		}
	}
	sort.Slice(res.Entries, func(i, j int) bool { return res.Entries[i].AnilistID < res.Entries[j].AnilistID })
	sort.Slice(res.Skips, func(i, j int) bool { return res.Skips[i].AnilistID < res.Skips[j].AnilistID })

	res.Stats = Stats{FribbCount: len(fribb), BelCount: len(bel), Mapped: len(res.Entries), Skipped: len(res.Skips)}
	return res
}

// BuildAnidbMap returns every AniList id Fribb links to exactly one AniDB id,
// sorted by AniList id.
//
// It is deliberately separate from BuildMap.  The AniDB id feeds the
// AnimeTosho magnet feed and comes from Fribb alone; whether Bangumi agrees
// about the same show is a different question.  When the two lived in one
// table, refusing a doubtful Bangumi link would also have taken the show's
// magnet feed away.
func BuildAnidbMap(fribb []FribbEntry) []AnidbEntry {
	seen := map[int]idSet{}
	for _, f := range fribb {
		if f.AnilistID == 0 || f.AnidbID == 0 {
			continue
		}
		if seen[f.AnilistID] == nil {
			seen[f.AnilistID] = idSet{}
		}
		seen[f.AnilistID][f.AnidbID] = struct{}{}
	}
	out := make([]AnidbEntry, 0, len(seen))
	for anilistID, anidb := range seen {
		if len(anidb) == 1 {
			out = append(out, AnidbEntry{AnilistID: anilistID, AnidbID: anidb.only()})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].AnilistID < out[j].AnilistID })
	return out
}
