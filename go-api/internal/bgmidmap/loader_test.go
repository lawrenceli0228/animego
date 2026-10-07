package bgmidmap

import "testing"

// TestLoad_EmbeddedMapParses guards the go:embed path and the JSON shape of
// the vendored map. If cmd/bgmmap changes the output schema or the file goes
// missing, this fails at build/test time rather than silently seeding an
// empty table at boot.
func TestLoad_EmbeddedMapParses(t *testing.T) {
	entries, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(entries) < 1000 {
		t.Fatalf("expected a substantial vendored map, got %d entries", len(entries))
	}

	checked := min(100, len(entries))
	withAnidb := 0
	for i := 0; i < checked; i++ {
		e := entries[i]
		if e.AnilistID <= 0 || e.BgmID <= 0 {
			t.Fatalf("entry %d invalid ids: anilist=%d bgm=%d", i, e.AnilistID, e.BgmID)
		}
		if e.Source == "" {
			t.Fatalf("entry %d has empty source", i)
		}
		if e.AnidbID < 0 {
			t.Fatalf("entry %d negative anidb_id: %d", i, e.AnidbID)
		}
		if e.AnidbID > 0 {
			withAnidb++
		}
	}
	// anidb_id feeds the AnimeTosho aid lookup; the vendored map should carry
	// it for the vast majority of rows (absent only when Fribb lists none).
	if withAnidb == 0 {
		t.Fatalf("no anidb_id present in first %d entries; embedded map missing the column", checked)
	}
}

// TestLoadAnidb_EmbeddedMapParses guards the second embed: the AniList->AniDB
// pairs the AnimeTosho feed reads.  Same failure mode as the Bangumi map — a
// missing or reshaped file must fail here, not seed an empty table at boot.
func TestLoadAnidb_EmbeddedMapParses(t *testing.T) {
	entries, err := LoadAnidb()
	if err != nil {
		t.Fatalf("LoadAnidb: %v", err)
	}
	if len(entries) < 1000 {
		t.Fatalf("expected a substantial vendored map, got %d entries", len(entries))
	}
	for i, e := range entries {
		if e.AnilistID <= 0 || e.AnidbID <= 0 {
			t.Fatalf("entry %d has a non-positive id: %+v", i, e)
		}
		if i > 0 && entries[i-1].AnilistID >= e.AnilistID {
			t.Fatalf("entries not strictly sorted by anilist_id at %d (%d then %d): the table's primary key would reject the COPY",
				i, entries[i-1].AnilistID, e.AnilistID)
		}
	}
}

// The AniDB map must not be a subset of the Bangumi map: it exists so a show
// keeps its magnet feed when its Bangumi link is refused.
func TestLoadAnidb_CoversShowsTheBangumiMapLeavesOut(t *testing.T) {
	bgm, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	anidb, err := LoadAnidb()
	if err != nil {
		t.Fatalf("LoadAnidb: %v", err)
	}
	inBgm := make(map[int32]bool, len(bgm))
	for _, e := range bgm {
		inBgm[e.AnilistID] = true
	}
	for _, e := range anidb {
		if !inBgm[e.AnilistID] {
			return
		}
	}
	t.Fatal("every AniDB pair is also in the Bangumi map; the split has no effect")
}
