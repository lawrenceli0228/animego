package main

import (
	"maps"
	"slices"
	"strconv"
)

// bangumi-data's site keys for the three links the map is built from.  The
// AniList key is camel case in the data ("aniList"), unlike the others.
const (
	siteMikan   = "mikan"
	siteBangumi = "bangumi"
	siteAniList = "aniList"
)

// Data is the part of bangumi-data's dist/data.json this tool reads.
type Data struct {
	Items []Item `json:"items"`
}

// Item is one bangumi-data entry: a single season, film or OVA, the same
// granularity as an AniList id, a Bangumi subject and a Mikan bangumi page.
// Title, TitleTranslate and Begin only feed the review report.
type Item struct {
	Title          string              `json:"title"`
	TitleTranslate map[string][]string `json:"titleTranslate"`
	Begin          string              `json:"begin"`
	Sites          []Site              `json:"sites"`
}

// Site is one of an item's links to another site.  Ids are strings in the
// data; the three this tool reads are numeric.
type Site struct {
	Site string `json:"site"`
	ID   string `json:"id"`
}

// Key names the id space a map entry or a conflict is keyed by.
type Key string

const (
	KeyAnilist Key = "anilist"
	KeyBgm     Key = "bgm"
)

// Conflict is an id that bangumi-data links to more than one Mikan page.
// It is left out of the map: no one page lists all of that show's
// releases, and a lookup by that id could not say which page is meant.
// Mikan lists the candidates, sorted.
type Conflict struct {
	Key   Key
	ID    int
	Mikan []int
}

// Stats counts what one build read.
type Stats struct {
	Items     int // every bangumi-data item
	WithMikan int // items that link a Mikan page
	NoAnilist int // of those, items with no AniList link: reachable by Bangumi id only
	BadIDs    int // read ids that are not positive 32-bit integers, skipped
}

// Result is everything one build produces.
type Result struct {
	Anilist   map[int]int // AniList id -> Mikan bangumi id
	Bgm       map[int]int // Bangumi subject id -> Mikan bangumi id
	Conflicts []Conflict  // sorted by key, then id
	Stats     Stats
}

// AnilistConflicts returns the conflicted AniList ids with their pages.
// They go into the generated file because the lookup has to know them: a
// conflicted show stays on Mikan's keyword search, and its pages are not
// up for grabs by another show's Bangumi id.  A conflicted Bangumi id
// needs nothing at lookup time; it is simply absent.
func (r Result) AnilistConflicts() map[int][]int {
	out := map[int][]int{}
	for _, c := range r.Conflicts {
		if c.Key == KeyAnilist {
			out[c.ID] = c.Mikan
		}
	}
	return out
}

// BuildMap indexes every item that links a Mikan page by its AniList ids and
// its Bangumi subject ids.  An id that reaches more than one Mikan page,
// whether through several items or one item with several Mikan links, is a
// conflict: it goes into Conflicts instead of the map.  Pure; all I/O is in
// main.
func BuildMap(items []Item) Result {
	anilist := map[int]map[int]struct{}{}
	bgm := map[int]map[int]struct{}{}
	var stats Stats
	stats.Items = len(items)

	for _, it := range items {
		mikan := siteIDs(it, siteMikan, &stats.BadIDs)
		if len(mikan) == 0 {
			continue
		}
		stats.WithMikan++
		anilistIDs := siteIDs(it, siteAniList, &stats.BadIDs)
		if len(anilistIDs) == 0 {
			stats.NoAnilist++
		}
		link(anilist, anilistIDs, mikan)
		link(bgm, siteIDs(it, siteBangumi, &stats.BadIDs), mikan)
	}

	res := Result{Stats: stats}
	res.Anilist, res.Conflicts = resolve(KeyAnilist, anilist, res.Conflicts)
	res.Bgm, res.Conflicts = resolve(KeyBgm, bgm, res.Conflicts)
	return res
}

// siteIDs returns the distinct positive ids an item gives for site, in the
// order they appear.  A blank, non-numeric or non-positive id, or one past
// the 32-bit range the server reads ids in, is counted in *bad and skipped,
// so it cannot make the whole file unreadable.
func siteIDs(it Item, site string, bad *int) []int {
	var out []int
	for _, s := range it.Sites {
		if s.Site != site {
			continue
		}
		id, err := strconv.ParseInt(s.ID, 10, 32)
		if err != nil || id <= 0 {
			*bad++
			continue
		}
		if !slices.Contains(out, int(id)) {
			out = append(out, int(id))
		}
	}
	return out
}

// link records that each key reaches every Mikan id in mikan.
func link(index map[int]map[int]struct{}, keys, mikan []int) {
	for _, k := range keys {
		if index[k] == nil {
			index[k] = map[int]struct{}{}
		}
		for _, m := range mikan {
			index[k][m] = struct{}{}
		}
	}
}

// resolve keeps the keys that reach exactly one Mikan id and appends the
// rest to conflicts, sorted by id so the output does not depend on the
// order bangumi-data lists its items in.
func resolve(key Key, index map[int]map[int]struct{}, conflicts []Conflict) (map[int]int, []Conflict) {
	out := make(map[int]int, len(index))
	for _, id := range slices.Sorted(maps.Keys(index)) {
		pages := slices.Sorted(maps.Keys(index[id]))
		if len(pages) == 1 {
			out[id] = pages[0]
			continue
		}
		conflicts = append(conflicts, Conflict{Key: key, ID: id, Mikan: pages})
	}
	return out, conflicts
}

// Page is the little of a Mikan page a reviewer needs to recognise it.
type Page struct {
	Title   string
	TitleCN string
	Begin   string // YYYY-MM-DD
}

// PageIndex names every Mikan page after the bangumi-data item that links
// it, for the report.  The first item listing a page wins.
func PageIndex(items []Item) map[int]Page {
	out := map[int]Page{}
	var ignored int
	for _, it := range items {
		for _, m := range siteIDs(it, siteMikan, &ignored) {
			if _, seen := out[m]; seen {
				continue
			}
			p := Page{Title: it.Title, Begin: dateOf(it.Begin)}
			if cn := it.TitleTranslate["zh-Hans"]; len(cn) > 0 {
				p.TitleCN = cn[0]
			}
			out[m] = p
		}
	}
	return out
}

// dateOf keeps the YYYY-MM-DD part of an ISO timestamp.
func dateOf(ts string) string {
	if len(ts) >= len("2006-01-02") {
		return ts[:len("2006-01-02")]
	}
	return ts
}
