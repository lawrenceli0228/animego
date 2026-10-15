// Package mikanidmap embeds the vendored map from AniList ids and Bangumi
// subject ids to Mikan Project bangumi ids, and answers which Mikan bangumi
// page an anime has.  The magnet search uses the answer to read Mikan's
// per-bangumi RSS feed for the show instead of searching Mikan by title.
//
// The map is generated weekly by cmd/mikanmap from bangumi-data
// (https://github.com/bangumi-data/bangumi-data), which is licensed under
// CC BY 4.0; the embedded file carries that attribution and the bangumi-data
// release it was built from.  Embedding means the binary carries the map: no
// runtime file, table or network dependency.
package mikanidmap

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"strconv"
	"sync"
)

//go:embed mikan_map.json
var rawMap []byte

// Map answers Mikan bangumi ids for AniList ids and Bangumi subject ids.
// It is read-only once parsed, so it is safe for concurrent use.
type Map struct {
	version   string
	byAnilist map[int32]int32
	byBgm     map[int32]int32
	// conflicted holds the AniList ids bangumi-data links to more than one
	// Mikan page.
	conflicted map[int32]struct{}
	// anilistOf lists, for each Mikan id, the AniList ids bangumi-data ties
	// to it: the mapped ones and the conflicted ones.
	anilistOf map[int32][]int32
}

// file is the JSON shape cmd/mikanmap writes.
type file struct {
	Version          string             `json:"bangumiDataVersion"`
	Anilist          map[string]int32   `json:"anilist"`
	Bgm              map[string]int32   `json:"bgm"`
	AnilistConflicts map[string][]int32 `json:"anilistConflicts"`
}

// Parse reads a map in the shape cmd/mikanmap writes.  Every key and value
// must be a positive id, a conflict must name at least two pages, and no
// AniList id may be both mapped and conflicted.
func Parse(data []byte) (*Map, error) {
	var f file
	if err := json.Unmarshal(data, &f); err != nil {
		return nil, fmt.Errorf("mikanidmap: decode: %w", err)
	}
	byAnilist, err := positiveIDs("anilist", f.Anilist)
	if err != nil {
		return nil, err
	}
	byBgm, err := positiveIDs("bgm", f.Bgm)
	if err != nil {
		return nil, err
	}
	conflicts, err := conflictPages(f.AnilistConflicts)
	if err != nil {
		return nil, err
	}

	m := &Map{
		version:    f.Version,
		byAnilist:  byAnilist,
		byBgm:      byBgm,
		conflicted: make(map[int32]struct{}, len(conflicts)),
		anilistOf:  make(map[int32][]int32, len(byAnilist)),
	}
	for anilistID, mikanID := range byAnilist {
		m.anilistOf[mikanID] = append(m.anilistOf[mikanID], anilistID)
	}
	for anilistID, pages := range conflicts {
		if _, mapped := byAnilist[anilistID]; mapped {
			return nil, fmt.Errorf("mikanidmap: AniList %d is both mapped and conflicted", anilistID)
		}
		m.conflicted[anilistID] = struct{}{}
		for _, mikanID := range pages {
			m.anilistOf[mikanID] = append(m.anilistOf[mikanID], anilistID)
		}
	}
	return m, nil
}

func positiveIDs(name string, in map[string]int32) (map[int32]int32, error) {
	out := make(map[int32]int32, len(in))
	for k, v := range in {
		id, err := parseID(k)
		if err != nil || v <= 0 {
			return nil, fmt.Errorf("mikanidmap: %s entry %q: %d is not a pair of positive ids", name, k, v)
		}
		out[id] = v
	}
	return out, nil
}

func conflictPages(in map[string][]int32) (map[int32][]int32, error) {
	out := make(map[int32][]int32, len(in))
	for k, pages := range in {
		id, err := parseID(k)
		if err != nil || len(pages) < 2 {
			return nil, fmt.Errorf("mikanidmap: anilistConflicts entry %q: %v is not an id with several pages", k, pages)
		}
		for _, p := range pages {
			if p <= 0 {
				return nil, fmt.Errorf("mikanidmap: anilistConflicts entry %q: page %d is not a positive id", k, p)
			}
		}
		out[id] = pages
	}
	return out, nil
}

// parseID reads a positive 32-bit id from a JSON object key.
func parseID(k string) (int32, error) {
	id, err := strconv.ParseInt(k, 10, 32)
	if err != nil {
		return 0, err
	}
	if id <= 0 {
		return 0, fmt.Errorf("id %d is not positive", id)
	}
	return int32(id), nil
}

// Version is the bangumi-data release the map was built from.
func (m *Map) Version() string { return m.version }

// Len reports how many AniList ids and Bangumi subject ids the map holds.
func (m *Map) Len() (anilist, bgm int) { return len(m.byAnilist), len(m.byBgm) }

// Lookup returns the Mikan bangumi id for an anime, trying its AniList id
// first and then its Bangumi subject id, when it has one.  A page is only
// returned when its feed can stand in for searching Mikan by title, so:
//
//   - An AniList id that bangumi-data links to several pages gets none.
//     No one page lists all of the show's releases, and its Bangumi id
//     would pick one of them.
//   - A Bangumi hit is refused when bangumi-data ties that page to a
//     different AniList id, conflicted ones included.  The anime's bgm id
//     is a binding made elsewhere, and in that case it and bangumi-data
//     disagree about which show the subject is.  Using the page anyway
//     could list another show's releases while switching off Mikan's
//     keyword search, which would still find the right ones.
func (m *Map) Lookup(anilistID int32, bgmID *int32) (int32, bool) {
	if mikanID, ok := m.byAnilist[anilistID]; ok {
		return mikanID, true
	}
	if _, ok := m.conflicted[anilistID]; ok || bgmID == nil {
		return 0, false
	}
	mikanID, ok := m.byBgm[*bgmID]
	if !ok || len(m.anilistOf[mikanID]) > 0 {
		// The AniList checks above already missed, so any AniList id the
		// page has is not this anime's.
		return 0, false
	}
	return mikanID, true
}

var embedded = sync.OnceValues(func() (*Map, error) { return Parse(rawMap) })

// Embedded returns the vendored map, parsed once.
func Embedded() (*Map, error) { return embedded() }

// Lookup answers from the vendored map; see Map.Lookup.  A vendored map that
// does not parse answers nothing, which leaves every anime on Mikan's keyword
// search; the server logs that at boot (Embedded) and the package tests fail
// on it first.
func Lookup(anilistID int32, bgmID *int32) (int32, bool) {
	m, err := embedded()
	if err != nil {
		return 0, false
	}
	return m.Lookup(anilistID, bgmID)
}
