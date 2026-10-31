package main

import (
	"bytes"
	"encoding/json"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/lawrenceli0228/animego/go-api/internal/mikanidmap"
)

func sampleMap() Map {
	return Map{
		Version:          "0.3.231",
		Anilist:          map[int]int{10: 3, 9: 2, 154587: 3141},
		Bgm:              map[int]int{400602: 3141, 20: 3, 975: 228},
		AnilistConflicts: map[int][]int{21: {228, 3977}, 5: {7, 8}},
	}
}

func TestRender_SortsNumericallyOneEntryPerLine(t *testing.T) {
	got := string(Render(sampleMap()))

	want := `{
  "attribution": ` + quote(Attribution) + `,
  "bangumiDataVersion": "0.3.231",
  "anilist": {
    "9": 2,
    "10": 3,
    "154587": 3141
  },
  "bgm": {
    "20": 3,
    "975": 228,
    "400602": 3141
  },
  "anilistConflicts": {
    "5": [7, 8],
    "21": [228, 3977]
  }
}
`
	if got != want {
		t.Errorf("Render:\n--- want\n%s--- got\n%s", want, got)
	}
}

// Map iteration order is random; the bytes must not be.
func TestRender_IsDeterministic(t *testing.T) {
	first := Render(sampleMap())
	for i := 0; i < 20; i++ {
		if again := Render(sampleMap()); !bytes.Equal(first, again) {
			t.Fatalf("run %d rendered different bytes:\n%s\n%s", i, first, again)
		}
	}
}

func TestRender_EmptyMapsAreValidJSON(t *testing.T) {
	out := Render(Map{Version: "0.3.1"})
	if !json.Valid(out) {
		t.Fatalf("not valid JSON:\n%s", out)
	}
	for _, want := range []string{`"anilist": {},`, `"bgm": {},`, `"anilistConflicts": {}`} {
		if !strings.Contains(string(out), want) {
			t.Errorf("empty maps should render as {}; missing %s in:\n%s", want, out)
		}
	}
}

// The file carries bangumi-data's CC BY 4.0 attribution and the release it
// was built from, and reads back to the same map.
func TestRender_RoundTripsWithAttribution(t *testing.T) {
	out := Render(sampleMap())

	var f mapFile
	if err := json.Unmarshal(out, &f); err != nil {
		t.Fatalf("not valid JSON: %v\n%s", err, out)
	}
	for _, s := range []string{"bangumi-data", "https://github.com/bangumi-data/bangumi-data", "CC BY 4.0"} {
		if !strings.Contains(f.Attribution, s) {
			t.Errorf("attribution %q does not mention %q", f.Attribution, s)
		}
	}
	back, err := ParseMap(out)
	if err != nil {
		t.Fatalf("ParseMap: %v", err)
	}
	if !reflect.DeepEqual(back, sampleMap()) {
		t.Errorf("round trip:\n want %+v\n got  %+v", sampleMap(), back)
	}
}

// What the generator writes is what the server embeds: the reader must load
// it, answer from both keys, and know the conflicts.
func TestRender_LoadsInTheReader(t *testing.T) {
	m, err := mikanidmap.Parse(Render(sampleMap()))
	if err != nil {
		t.Fatalf("mikanidmap.Parse: %v", err)
	}
	if m.Version() != "0.3.231" {
		t.Errorf("version: got %q", m.Version())
	}
	if got := m.Lookup(154587, nil); !slices.Equal(got, []int32{3141}) {
		t.Errorf("AniList 154587: got %v", got)
	}
	bgm20, bgm975 := int32(20), int32(975)
	// Page 3 belongs to AniList 10, so a Bangumi hit on it for another
	// AniList id is refused; see mikanidmap.Map.Lookup.
	if got := m.Lookup(1, &bgm20); got != nil {
		t.Errorf("bgm 20 for AniList 1: want a refusal, got %v", got)
	}
	// AniList 21 is a conflict: it gets every one of its pages, and its own
	// Bangumi id does not narrow that to one.
	conflict := m.Lookup(21, &bgm975)
	if len(conflict) < 2 || !slices.Contains(conflict, 228) {
		t.Errorf("conflicted AniList 21 via bgm 975: want all its pages, got %v", conflict)
	}
}

func TestParseMap_RejectsANonNumericKey(t *testing.T) {
	if _, err := ParseMap([]byte(`{"anilist": {"x": 1}, "bgm": {}}`)); err == nil {
		t.Error("want an error for a non-numeric key")
	}
}
