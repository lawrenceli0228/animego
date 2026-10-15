package main

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

// loadFixture decodes testdata/data.json, a few bangumi-data items in the
// real file's shape (siteMeta, camel-case "aniList", string ids, sites the
// tool does not read).
func loadFixture(t *testing.T) []Item {
	t.Helper()
	raw, err := os.ReadFile("testdata/data.json")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var d Data
	if err := json.Unmarshal(raw, &d); err != nil {
		t.Fatalf("decode fixture: %v", err)
	}
	return d.Items
}

func TestBuildMap_KeysByAnilistAndBgm(t *testing.T) {
	res := BuildMap(loadFixture(t))

	wantAnilist := map[int]int{154587: 3141, 182255: 3821, 9001: 501, 9002: 502}
	if !reflect.DeepEqual(res.Anilist, wantAnilist) {
		t.Errorf("anilist map:\n want %v\n got  %v", wantAnilist, res.Anilist)
	}
	// 999001 has no AniList link: the Bangumi key is the only way to reach it.
	wantBgm := map[int]int{400602: 3141, 515759: 3821, 999001: 4001, 975: 228, 602059: 3977}
	if !reflect.DeepEqual(res.Bgm, wantBgm) {
		t.Errorf("bgm map:\n want %v\n got  %v", wantBgm, res.Bgm)
	}
	want := Stats{Items: 9, WithMikan: 8, NoAnilist: 2, BadIDs: 2}
	if res.Stats != want {
		t.Errorf("stats: want %+v, got %+v", want, res.Stats)
	}
}

// AniList 21 names two Mikan pages through two items, Bangumi 777 names two
// through two others: both are left out of the map and listed instead, while
// the other keys of those same items still map.
func TestBuildMap_ConflictsAreLeftOutAndListed(t *testing.T) {
	res := BuildMap(loadFixture(t))

	want := []Conflict{
		{Key: KeyAnilist, ID: 21, Mikan: []int{228, 3977}},
		{Key: KeyBgm, ID: 777, Mikan: []int{501, 502}},
	}
	if !reflect.DeepEqual(res.Conflicts, want) {
		t.Errorf("conflicts:\n want %+v\n got  %+v", want, res.Conflicts)
	}
	if _, ok := res.Anilist[21]; ok {
		t.Error("a conflicted AniList id must not be in the map")
	}
	if _, ok := res.Bgm[777]; ok {
		t.Error("a conflicted Bangumi id must not be in the map")
	}
	if res.Bgm[975] != 228 || res.Bgm[602059] != 3977 {
		t.Errorf("the conflicting items' own Bangumi ids still map: got 975→%d, 602059→%d", res.Bgm[975], res.Bgm[602059])
	}
}

// Ids past the 32-bit range the server reads are skipped like any other
// unreadable id, rather than written into a file the server cannot load.
func TestBuildMap_SkipsIDsPastInt32(t *testing.T) {
	items := []Item{{Sites: []Site{
		{Site: siteAniList, ID: "4294967296"}, {Site: siteBangumi, ID: "20"}, {Site: siteMikan, ID: "30"},
	}}}
	res := BuildMap(items)
	if len(res.Anilist) != 0 || res.Bgm[20] != 30 || res.Stats.BadIDs != 1 {
		t.Errorf("want only bgm 20→30 and one bad id, got anilist %v bgm %v stats %+v", res.Anilist, res.Bgm, res.Stats)
	}
}

// One item that links two Mikan pages makes every one of its ids a conflict.
func TestBuildMap_OneItemWithTwoMikanLinksConflicts(t *testing.T) {
	items := []Item{{Sites: []Site{
		{Site: siteAniList, ID: "10"}, {Site: siteBangumi, ID: "20"},
		{Site: siteMikan, ID: "31"}, {Site: siteMikan, ID: "30"},
	}}}
	res := BuildMap(items)

	if len(res.Anilist) != 0 || len(res.Bgm) != 0 {
		t.Fatalf("want empty maps, got anilist %v bgm %v", res.Anilist, res.Bgm)
	}
	want := []Conflict{
		{Key: KeyAnilist, ID: 10, Mikan: []int{30, 31}},
		{Key: KeyBgm, ID: 20, Mikan: []int{30, 31}},
	}
	if !reflect.DeepEqual(res.Conflicts, want) {
		t.Errorf("conflicts:\n want %+v\n got  %+v", want, res.Conflicts)
	}
}

// The same pair listed twice (one item repeating a link, or two items
// agreeing) is not a conflict.
func TestBuildMap_RepeatedAgreeingLinksAreNotAConflict(t *testing.T) {
	items := []Item{
		{Sites: []Site{{Site: siteAniList, ID: "10"}, {Site: siteMikan, ID: "30"}, {Site: siteMikan, ID: "30"}}},
		{Sites: []Site{{Site: siteAniList, ID: "10"}, {Site: siteMikan, ID: "30"}}},
	}
	res := BuildMap(items)
	if len(res.Conflicts) != 0 || res.Anilist[10] != 30 {
		t.Errorf("want 10→30 and no conflict, got map %v conflicts %+v", res.Anilist, res.Conflicts)
	}
}

func TestBuildMap_DoesNotDependOnItemOrder(t *testing.T) {
	items := loadFixture(t)
	reversed := make([]Item, len(items))
	for i, it := range items {
		reversed[len(items)-1-i] = it
	}
	if a, b := BuildMap(items), BuildMap(reversed); !reflect.DeepEqual(a, b) {
		t.Errorf("result depends on item order:\n %+v\n %+v", a, b)
	}
}

func TestPageIndex_NamesPagesForTheReport(t *testing.T) {
	pages := PageIndex(loadFixture(t))

	want := Page{Title: "葬送のフリーレン", TitleCN: "葬送的芙莉莲", Begin: "2023-09-29"}
	if pages[3141] != want {
		t.Errorf("page 3141: want %+v, got %+v", want, pages[3141])
	}
	if pages[4001].Title != "Bangumi-only show" || pages[4001].TitleCN != "" {
		t.Errorf("page 4001: got %+v", pages[4001])
	}
}
