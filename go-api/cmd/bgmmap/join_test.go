package main

import (
	"encoding/json"
	"os"
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

// ---- unit-level table tests (in-memory fixtures, no network) ----

func TestBuildMap_MalJoinHit(t *testing.T) {
	fribb := []FribbEntry{
		{AnilistID: 10, MalID: 100, AnidbID: 200},
	}
	bel := []BelEntry{
		{BgmID: "999", MalID: "100", AnidbID: "200"},
	}
	entries, stats := BuildMap(fribb, bel)

	if stats.Mapped != 1 {
		t.Fatalf("expected 1 mapped entry, got %d", stats.Mapped)
	}
	e := entries[0]
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
	entries, stats := BuildMap(fribb, bel)

	if stats.Mapped != 1 {
		t.Fatalf("expected 1 mapped entry, got %d", stats.Mapped)
	}
	e := entries[0]
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
	_, stats := BuildMap(fribb, bel)

	if stats.Mapped != 0 {
		t.Errorf("expected 0 mapped (no anilist_id), got %d", stats.Mapped)
	}
}

func TestBuildMap_NoMatchSkip(t *testing.T) {
	// Fribb entry has anilist_id but no BEL entry with matching mal or anidb.
	fribb := []FribbEntry{
		{AnilistID: 30, MalID: 9001, AnidbID: 9002},
	}
	bel := []BelEntry{
		{BgmID: "555", MalID: "1", AnidbID: "2"},
	}
	_, stats := BuildMap(fribb, bel)

	if stats.Mapped != 0 {
		t.Errorf("expected 0 mapped (no bgm match), got %d", stats.Mapped)
	}
}

func TestBuildMap_ConflictPrefersMAL(t *testing.T) {
	// Two Fribb entries share the same anilist_id but resolve to different bgm_ids;
	// one via MAL, one via AniDB. The MAL-sourced resolution must win.
	fribb := []FribbEntry{
		// First entry resolves via AniDB only (no mal).
		{AnilistID: 40, MalID: 0, AnidbID: 401},
		// Second entry for same anilist_id resolves via MAL.
		{AnilistID: 40, MalID: 402, AnidbID: 0},
	}
	bel := []BelEntry{
		{BgmID: "10", MalID: "", AnidbID: "401"}, // anidb → bgm 10
		{BgmID: "20", MalID: "402", AnidbID: ""}, // mal   → bgm 20
	}
	entries, stats := BuildMap(fribb, bel)

	if stats.Mapped != 1 {
		t.Fatalf("expected 1 deduped entry, got %d", stats.Mapped)
	}
	if stats.Conflicts != 1 {
		t.Errorf("expected 1 conflict, got %d", stats.Conflicts)
	}
	e := entries[0]
	if e.BgmID != 20 {
		t.Errorf("conflict resolution: want bgm_id=20 (mal), got %d", e.BgmID)
	}
	if e.Source != "mal" {
		t.Errorf("conflict resolution: want source=mal, got %s", e.Source)
	}
}

func TestBuildMap_SortedByAnilistID(t *testing.T) {
	fribb := []FribbEntry{
		{AnilistID: 300, MalID: 3, AnidbID: 0},
		{AnilistID: 100, MalID: 1, AnidbID: 0},
		{AnilistID: 200, MalID: 2, AnidbID: 0},
	}
	bel := []BelEntry{
		{BgmID: "31", MalID: "3", AnidbID: ""},
		{BgmID: "11", MalID: "1", AnidbID: ""},
		{BgmID: "21", MalID: "2", AnidbID: ""},
	}
	entries, _ := BuildMap(fribb, bel)

	if len(entries) != 3 {
		t.Fatalf("expected 3 entries, got %d", len(entries))
	}
	for i := 1; i < len(entries); i++ {
		if entries[i].AnilistID <= entries[i-1].AnilistID {
			t.Errorf("not sorted: entries[%d].AnilistID=%d <= entries[%d].AnilistID=%d",
				i, entries[i].AnilistID, i-1, entries[i-1].AnilistID)
		}
	}
}

func TestBuildMap_EmptyInputs(t *testing.T) {
	entries, stats := BuildMap(nil, nil)
	if entries == nil {
		t.Error("expected non-nil slice for empty inputs")
	}
	if stats.Mapped != 0 {
		t.Errorf("expected 0 mapped for empty inputs, got %d", stats.Mapped)
	}
}

// ---- fixture-file integration test (reads testdata/*.json) ----

func TestBuildMap_Fixtures(t *testing.T) {
	fribb := loadFribbFixture(t, "testdata/fribb.json")
	bel := loadBelFixture(t, "testdata/bel.json")
	entries, stats := BuildMap(fribb, bel)

	// Fixture has 6 Fribb entries:
	//   anilist=1 mal=101→bgm=11  ✓ (also anidb=201→bgm=11, same bgm, no conflict counted)
	//   anilist=2 mal=102→bgm=22  ✓
	//   anilist=3 no mal, anidb=203→bgm=33  ✓
	//   anilist=4 mal=104→bgm=44  ✓
	//   anilist=0 → skipped (no anilist_id)
	//   anilist=5 mal=999 no bel match, anidb=999 no bel match → skipped
	// Expected mapped: 4
	if stats.Mapped != 4 {
		t.Errorf("fixture: expected 4 mapped, got %d", stats.Mapped)
	}
	if len(entries) != 4 {
		t.Errorf("fixture: expected 4 entries, got %d", len(entries))
	}

	// Verify anilist=3 came via anidb fallback.
	var entry3 *MapEntry
	for i := range entries {
		if entries[i].AnilistID == 3 {
			entry3 = &entries[i]
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
	if stats.FribbCount != len(fribb) {
		t.Errorf("FribbCount: want %d, got %d", len(fribb), stats.FribbCount)
	}
	if stats.BelCount != len(bel) {
		t.Errorf("BelCount: want %d, got %d", len(bel), stats.BelCount)
	}
}
