package main

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

// loadTestFixture is a helper that reads a JSON fixture and decodes it.
func loadFribbFixture(t *testing.T, path string) []FribbEntry {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read fribb fixture %s: %v", path, err)
	}
	var out []FribbEntry
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("decode fribb fixture %s: %v", path, err)
	}
	return out
}

func loadBelFixture(t *testing.T, path string) []BelEntry {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read bel fixture %s: %v", path, err)
	}
	var out []BelEntry
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("decode bel fixture %s: %v", path, err)
	}
	return out
}

// onlyEntry asserts the result holds exactly one map entry and returns it.
func onlyEntry(t *testing.T, res Result) MapEntry {
	t.Helper()
	if len(res.Entries) != 1 {
		t.Fatalf("want exactly 1 entry, got %d: %+v (skips %+v)", len(res.Entries), res.Entries, res.Skips)
	}
	return res.Entries[0]
}

// onlySkip asserts the result mapped nothing and refused exactly one id.
func onlySkip(t *testing.T, res Result) Skip {
	t.Helper()
	if len(res.Entries) != 0 {
		t.Fatalf("want no entries, got %+v", res.Entries)
	}
	if len(res.Skips) != 1 {
		t.Fatalf("want exactly 1 skip, got %+v", res.Skips)
	}
	return res.Skips[0]
}

// ---- unit-level table tests (in-memory fixtures, no network) ----

func TestBuildMap_MalJoinHit(t *testing.T) {
	fribb := []FribbEntry{
		{AnilistID: 10, MalID: 100, AnidbID: 200},
	}
	bel := []BelEntry{
		{BgmID: "999", MalID: "100", AnidbID: "200"},
	}
	res := BuildMap(fribb, bel)

	if res.Stats.Mapped != 1 {
		t.Fatalf("expected 1 mapped entry, got %d", res.Stats.Mapped)
	}
	e := onlyEntry(t, res)
	if e.AnilistID != 10 {
		t.Errorf("anilist_id: want 10, got %d", e.AnilistID)
	}
	if e.BgmID != 999 {
		t.Errorf("bgm_id: want 999, got %d", e.BgmID)
	}
	if e.MalID != 100 {
		t.Errorf("mal_id: want 100, got %d", e.MalID)
	}
	// A MAL-sourced binding still carries Fribb's anidb_id (feeds AnimeTosho).
	if e.AnidbID != 200 {
		t.Errorf("anidb_id: want 200, got %d", e.AnidbID)
	}
	if e.Source != "mal" {
		t.Errorf("source: want mal, got %s", e.Source)
	}
}

func TestBuildMap_AnidbFallback(t *testing.T) {
	// No MAL id on either side; AniDB id should bridge.
	fribb := []FribbEntry{
		{AnilistID: 20, MalID: 0, AnidbID: 300},
	}
	bel := []BelEntry{
		{BgmID: "777", MalID: "", AnidbID: "300"},
	}
	e := onlyEntry(t, BuildMap(fribb, bel))

	if e.Source != "anidb" {
		t.Errorf("source: want anidb, got %s", e.Source)
	}
	if e.BgmID != 777 {
		t.Errorf("bgm_id: want 777, got %d", e.BgmID)
	}
	if e.MalID != 0 {
		t.Errorf("mal_id: want 0 (omitted), got %d", e.MalID)
	}
	// AniDB-sourced binding must carry the bridging anidb_id.
	if e.AnidbID != 300 {
		t.Errorf("anidb_id: want 300, got %d", e.AnidbID)
	}
}

func TestBuildMap_NoAnilistSkip(t *testing.T) {
	// Fribb entry has no anilist_id → must be skipped.
	fribb := []FribbEntry{
		{AnilistID: 0, MalID: 500, AnidbID: 600},
	}
	bel := []BelEntry{
		{BgmID: "111", MalID: "500", AnidbID: "600"},
	}
	res := BuildMap(fribb, bel)

	if res.Stats.Mapped != 0 || len(res.Skips) != 0 {
		t.Errorf("expected nothing mapped or skipped (no anilist_id), got %+v", res)
	}
}

func TestBuildMap_NoMatchSkip(t *testing.T) {
	// Fribb entry has anilist_id but no BEL entry with matching mal or anidb.
	// That is "no answer", not a refusal: it must not show up as a skip.
	fribb := []FribbEntry{
		{AnilistID: 30, MalID: 9001, AnidbID: 9002},
	}
	bel := []BelEntry{
		{BgmID: "555", MalID: "1", AnidbID: "2"},
	}
	res := BuildMap(fribb, bel)

	if res.Stats.Mapped != 0 || len(res.Skips) != 0 {
		t.Errorf("expected nothing mapped or skipped (no bgm match), got %+v", res)
	}
}

// The two upstream paths name different subjects — the live 2026-10 case:
// Fribb moved AniList 315 (Xiao Qian, 1997) onto MAL 60451, which Bangumi
// links to the 2024 re-release, while the AniDB id still reaches the 1997
// film.  Picking either would be a guess, so the id is left out.
func TestBuildMap_MalAndAnidbDisagree_Refused(t *testing.T) {
	fribb := []FribbEntry{{AnilistID: 315, MalID: 60451, AnidbID: 1424}}
	bel := []BelEntry{
		{BgmID: "448690", MalID: "60451"},
		{BgmID: "15174", MalID: "315", AnidbID: "1424"},
	}
	s := onlySkip(t, BuildMap(fribb, bel))

	if s.AnilistID != 315 || s.Reason != SkipMalAnidbDisagree {
		t.Errorf("want 315 refused as %s, got %+v", SkipMalAnidbDisagree, s)
	}
	if !reflect.DeepEqual(s.ViaMal, []int{448690}) || !reflect.DeepEqual(s.ViaAnidb, []int{15174}) {
		t.Errorf("candidates: want mal=[448690] anidb=[15174], got mal=%v anidb=%v", s.ViaMal, s.ViaAnidb)
	}
}

// Bangumi splits a 24-episode AniList entry into two cours that share one
// AniDB id; the MAL id names the first.  The AniDB side is ambiguous on its
// own but does not contradict MAL, so MAL decides — the live BASTARD!! case.
func TestBuildMap_MalNarrowsAmbiguousAnidb(t *testing.T) {
	fribb := []FribbEntry{{AnilistID: 144677, MalID: 50953, AnidbID: 17175}}
	bel := []BelEntry{
		{BgmID: "367726", MalID: "50953", AnidbID: "17175"},
		{BgmID: "390312", AnidbID: "17175"},
	}
	e := onlyEntry(t, BuildMap(fribb, bel))

	if e.BgmID != 367726 || e.Source != "mal" {
		t.Errorf("want bgm 367726 via mal, got %+v", e)
	}
}

// Several subjects claim one AniDB id and there is no MAL id to choose
// between them.  The old join took whichever came last in the file.
func TestBuildMap_AmbiguousAnidb_Refused(t *testing.T) {
	fribb := []FribbEntry{{AnilistID: 50, AnidbID: 7}}
	bel := []BelEntry{
		{BgmID: "71", AnidbID: "7"},
		{BgmID: "72", AnidbID: "7"},
	}
	s := onlySkip(t, BuildMap(fribb, bel))

	if s.Reason != SkipAmbiguousAnidb {
		t.Errorf("reason: want %s, got %s", SkipAmbiguousAnidb, s.Reason)
	}
	if !reflect.DeepEqual(s.ViaAnidb, []int{71, 72}) {
		t.Errorf("candidates: want anidb=[71 72], got %v", s.ViaAnidb)
	}
}

// Two subjects claim one MAL id, and the AniDB id singles out one of them —
// the live Gekidol / Alice in Deadly School case, where the old join took the
// last of the two and bound the wrong show.
func TestBuildMap_AnidbNarrowsAmbiguousMal(t *testing.T) {
	fribb := []FribbEntry{{AnilistID: 21569, MalID: 33839, AnidbID: 12330}}
	bel := []BelEntry{
		{BgmID: "189777", MalID: "33839", AnidbID: "12330"},
		{BgmID: "195723", MalID: "33839", AnidbID: "15734"},
	}
	e := onlyEntry(t, BuildMap(fribb, bel))

	if e.BgmID != 189777 || e.Source != "mal" || e.MalID != 33839 {
		t.Errorf("want bgm 189777 via mal 33839, got %+v", e)
	}
}

// Two subjects claim one MAL id and the AniDB id cannot tell them apart.
func TestBuildMap_AmbiguousMal_Refused(t *testing.T) {
	fribb := []FribbEntry{{AnilistID: 170, MalID: 170, AnidbID: 2316}}
	bel := []BelEntry{
		{BgmID: "1608", MalID: "170", AnidbID: "2316"},
		{BgmID: "3731", MalID: "170", AnidbID: "2316"},
	}
	s := onlySkip(t, BuildMap(fribb, bel))

	if s.Reason != SkipAmbiguousMal {
		t.Errorf("reason: want %s, got %s", SkipAmbiguousMal, s.Reason)
	}
	if !reflect.DeepEqual(s.ViaMal, []int{1608, 3731}) {
		t.Errorf("candidates: want mal=[1608 3731], got %v", s.ViaMal)
	}
}

func TestBuildMap_AmbiguousMalWithoutAnidb_Refused(t *testing.T) {
	fribb := []FribbEntry{{AnilistID: 60, MalID: 8}}
	bel := []BelEntry{
		{BgmID: "81", MalID: "8"},
		{BgmID: "82", MalID: "8"},
	}
	if s := onlySkip(t, BuildMap(fribb, bel)); s.Reason != SkipAmbiguousMal {
		t.Errorf("reason: want %s, got %s", SkipAmbiguousMal, s.Reason)
	}
}

// Fribb occasionally lists one AniList id twice.  When the rows reach
// different subjects the id is refused rather than resolved by row order.
func TestBuildMap_FribbRowsDisagree_Refused(t *testing.T) {
	fribb := []FribbEntry{
		{AnilistID: 40, MalID: 0, AnidbID: 401},
		{AnilistID: 40, MalID: 402, AnidbID: 0},
	}
	bel := []BelEntry{
		{BgmID: "10", MalID: "", AnidbID: "401"},
		{BgmID: "20", MalID: "402", AnidbID: ""},
	}
	s := onlySkip(t, BuildMap(fribb, bel))

	if s.Reason != SkipFribbRowsDisagree {
		t.Errorf("reason: want %s, got %s", SkipFribbRowsDisagree, s.Reason)
	}
	if !reflect.DeepEqual(s.ViaMal, []int{20}) || !reflect.DeepEqual(s.ViaAnidb, []int{10}) {
		t.Errorf("candidates: want mal=[20] anidb=[10], got mal=%v anidb=%v", s.ViaMal, s.ViaAnidb)
	}
}

// Duplicate Fribb rows that agree are one answer, and the MAL-sourced row's
// ids are the ones kept.
func TestBuildMap_FribbRowsAgree_Mapped(t *testing.T) {
	fribb := []FribbEntry{
		{AnilistID: 41, MalID: 0, AnidbID: 411},
		{AnilistID: 41, MalID: 412, AnidbID: 411},
	}
	bel := []BelEntry{{BgmID: "30", MalID: "412", AnidbID: "411"}}
	e := onlyEntry(t, BuildMap(fribb, bel))

	if e.BgmID != 30 || e.Source != "mal" || e.MalID != 412 {
		t.Errorf("want bgm 30 via mal 412, got %+v", e)
	}
}

// If any of an id's Fribb rows is ambiguous, the id is refused even when
// another row resolves cleanly: the clean row cannot vouch for the other.
func TestBuildMap_OneAmbiguousFribbRow_RefusesTheId(t *testing.T) {
	fribb := []FribbEntry{
		{AnilistID: 42, MalID: 421},
		{AnilistID: 42, AnidbID: 422},
	}
	bel := []BelEntry{
		{BgmID: "50", MalID: "421"},
		{BgmID: "50", AnidbID: "422"},
		{BgmID: "51", AnidbID: "422"},
	}
	if s := onlySkip(t, BuildMap(fribb, bel)); s.Reason != SkipAmbiguousAnidb {
		t.Errorf("reason: want %s, got %s", SkipAmbiguousAnidb, s.Reason)
	}
}

// An id refused by several Fribb rows for different reasons reports the same
// reason whichever order Fribb lists the rows in.
func TestBuildMap_RefusalReasonIndependentOfFribbOrder(t *testing.T) {
	rows := []FribbEntry{
		{AnilistID: 43, AnidbID: 432},             // ambiguous via AniDB
		{AnilistID: 43, MalID: 431, AnidbID: 433}, // MAL and AniDB disagree
	}
	bel := []BelEntry{
		{BgmID: "60", AnidbID: "432"},
		{BgmID: "61", AnidbID: "432"},
		{BgmID: "62", MalID: "431"},
		{BgmID: "63", AnidbID: "433"},
	}
	for _, fribb := range [][]FribbEntry{rows, {rows[1], rows[0]}} {
		if s := onlySkip(t, BuildMap(fribb, bel)); s.Reason != SkipMalAnidbDisagree {
			t.Errorf("rows %+v: want %s, got %s", fribb, SkipMalAnidbDisagree, s.Reason)
		}
	}
}

// The old join was last-writer-wins over the BEL file, so the answer
// depended on upstream row order.  The output must not.
func TestBuildMap_IndependentOfUpstreamOrder(t *testing.T) {
	fribb := []FribbEntry{
		{AnilistID: 1, MalID: 11, AnidbID: 111},
		{AnilistID: 2, MalID: 22},
		{AnilistID: 3, AnidbID: 333},
	}
	bel := []BelEntry{
		{BgmID: "101", MalID: "11", AnidbID: "111"},
		{BgmID: "102", MalID: "11"},
		{BgmID: "201", MalID: "22"},
		{BgmID: "202", MalID: "22"},
		{BgmID: "301", AnidbID: "333"},
	}
	reversed := make([]BelEntry, len(bel))
	for i, e := range bel {
		reversed[len(bel)-1-i] = e
	}

	a, b := BuildMap(fribb, bel), BuildMap(fribb, reversed)
	if !reflect.DeepEqual(a, b) {
		t.Errorf("result depends on BEL order:\n forward  %+v\n reversed %+v", a, b)
	}
	if len(a.Entries) != 2 || len(a.Skips) != 1 {
		t.Errorf("want 2 entries + 1 skip, got %+v", a)
	}
}

func TestBuildMap_SortedByAnilistID(t *testing.T) {
	fribb := []FribbEntry{
		{AnilistID: 300, MalID: 3, AnidbID: 0},
		{AnilistID: 100, MalID: 1, AnidbID: 0},
		{AnilistID: 200, MalID: 2, AnidbID: 0},
		{AnilistID: 250, MalID: 9},
		{AnilistID: 150, MalID: 9},
	}
	bel := []BelEntry{
		{BgmID: "31", MalID: "3", AnidbID: ""},
		{BgmID: "11", MalID: "1", AnidbID: ""},
		{BgmID: "21", MalID: "2", AnidbID: ""},
		{BgmID: "91", MalID: "9"},
		{BgmID: "92", MalID: "9"},
	}
	res := BuildMap(fribb, bel)

	if len(res.Entries) != 3 {
		t.Fatalf("expected 3 entries, got %d", len(res.Entries))
	}
	for i := 1; i < len(res.Entries); i++ {
		if res.Entries[i].AnilistID <= res.Entries[i-1].AnilistID {
			t.Errorf("entries not sorted at %d: %+v", i, res.Entries)
		}
	}
	if len(res.Skips) != 2 || res.Skips[0].AnilistID != 150 || res.Skips[1].AnilistID != 250 {
		t.Errorf("skips not sorted by anilist_id: %+v", res.Skips)
	}
}

func TestBuildMap_EmptyInputs(t *testing.T) {
	res := BuildMap(nil, nil)
	if res.Entries == nil {
		t.Error("expected non-nil slice for empty inputs")
	}
	if res.Stats.Mapped != 0 || res.Stats.Skipped != 0 {
		t.Errorf("expected 0 mapped/skipped for empty inputs, got %+v", res.Stats)
	}
}

func TestBuildAnidbMap(t *testing.T) {
	fribb := []FribbEntry{
		{AnilistID: 3, AnidbID: 30},
		{AnilistID: 1, AnidbID: 10},
		{AnilistID: 1, AnidbID: 10}, // duplicate row, same answer
		{AnilistID: 2, AnidbID: 20},
		{AnilistID: 2, AnidbID: 21}, // Fribb disagrees with itself
		{AnilistID: 4, AnidbID: 0},  // no AniDB id
		{AnilistID: 0, AnidbID: 50}, // no AniList id
	}
	got := BuildAnidbMap(fribb)
	want := []AnidbEntry{{AnilistID: 1, AnidbID: 10}, {AnilistID: 3, AnidbID: 30}}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("BuildAnidbMap: want %+v, got %+v", want, got)
	}
}

// An AniList id whose Bangumi side is refused keeps its AniDB id: the two
// come from different joins and only the Bangumi one was in doubt.
func TestBuildAnidbMap_IndependentOfBangumiRefusals(t *testing.T) {
	fribb := []FribbEntry{{AnilistID: 170, MalID: 170, AnidbID: 2316}}
	bel := []BelEntry{
		{BgmID: "1608", MalID: "170", AnidbID: "2316"},
		{BgmID: "3731", MalID: "170", AnidbID: "2316"},
	}
	if res := BuildMap(fribb, bel); len(res.Entries) != 0 {
		t.Fatalf("precondition: want the Bangumi side refused, got %+v", res.Entries)
	}
	want := []AnidbEntry{{AnilistID: 170, AnidbID: 2316}}
	if got := BuildAnidbMap(fribb); !reflect.DeepEqual(got, want) {
		t.Errorf("want %+v, got %+v", want, got)
	}
}

// ---- fixture-file integration test (reads testdata/*.json) ----

func TestBuildMap_Fixtures(t *testing.T) {
	fribb := loadFribbFixture(t, "testdata/fribb.json")
	bel := loadBelFixture(t, "testdata/bel.json")
	res := BuildMap(fribb, bel)

	// Fixture has 6 Fribb entries:
	//   anilist=1 mal=101→bgm=11  ✓ (also anidb=201→bgm=11, same bgm, agrees)
	//   anilist=2 mal=102→bgm=22  ✓
	//   anilist=3 no mal, anidb=203→bgm=33  ✓
	//   anilist=4 mal=104→bgm=44  ✓
	//   anilist=0 → skipped (no anilist_id)
	//   anilist=5 mal=999 no bel match, anidb=999 no bel match → no answer
	// Expected mapped: 4
	if res.Stats.Mapped != 4 {
		t.Errorf("fixture: expected 4 mapped, got %d", res.Stats.Mapped)
	}
	if len(res.Entries) != 4 {
		t.Errorf("fixture: expected 4 entries, got %d", len(res.Entries))
	}
	if len(res.Skips) != 0 {
		t.Errorf("fixture: expected no refusals, got %+v", res.Skips)
	}

	// Verify anilist=3 came via anidb fallback.
	var entry3 *MapEntry
	for i := range res.Entries {
		if res.Entries[i].AnilistID == 3 {
			entry3 = &res.Entries[i]
			break
		}
	}
	if entry3 == nil {
		t.Fatal("fixture: anilist_id=3 not found in output")
	}
	if entry3.Source != "anidb" {
		t.Errorf("fixture: anilist_id=3 source: want anidb, got %s", entry3.Source)
	}
	if entry3.BgmID != 33 {
		t.Errorf("fixture: anilist_id=3 bgm_id: want 33, got %d", entry3.BgmID)
	}
	if entry3.AnidbID != 203 {
		t.Errorf("fixture: anilist_id=3 anidb_id: want 203, got %d", entry3.AnidbID)
	}

	// Verify stats counts.
	if res.Stats.FribbCount != len(fribb) {
		t.Errorf("FribbCount: want %d, got %d", len(fribb), res.Stats.FribbCount)
	}
	if res.Stats.BelCount != len(bel) {
		t.Errorf("BelCount: want %d, got %d", len(bel), res.Stats.BelCount)
	}
}
