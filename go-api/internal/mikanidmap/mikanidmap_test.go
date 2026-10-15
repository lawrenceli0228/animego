package mikanidmap

import (
	"regexp"
	"testing"
)

// fixture is a map in the shape cmd/mikanmap writes:
//   - AniList 154587 → page 3141; its Bangumi subject 400602 → the same page
//   - Bangumi 999001 → page 4001, a page no AniList id maps to
//   - Bangumi 515759 → page 3821, a page AniList 182255 maps to
//   - AniList 21 is a conflict over pages 228 and 3977, which its two
//     Bangumi subjects 975 and 602059 each map to (bangumi-data's One Piece)
const fixture = `{
  "attribution": "Mikan Project bangumi ids from bangumi-data, CC BY 4.0",
  "bangumiDataVersion": "0.3.231",
  "anilist": {
    "154587": 3141,
    "182255": 3821
  },
  "bgm": {
    "975": 228,
    "400602": 3141,
    "515759": 3821,
    "602059": 3977,
    "999001": 4001
  },
  "anilistConflicts": {
    "21": [228, 3977]
  }
}`

func mustParse(t *testing.T, data string) *Map {
	t.Helper()
	m, err := Parse([]byte(data))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	return m
}

func ptr(v int32) *int32 { return &v }

func TestLookup(t *testing.T) {
	m := mustParse(t, fixture)

	cases := []struct {
		name      string
		anilistID int32
		bgmID     *int32
		want      int32
		wantOK    bool
	}{
		{"AniList hit", 154587, nil, 3141, true},
		// The AniList id decides even when the bgm id would say otherwise.
		{"AniList hit wins over the bgm id", 154587, ptr(999001), 3141, true},
		{"bgm fallback", 1, ptr(999001), 4001, true},
		{"miss on both", 1, ptr(2), 0, false},
		{"miss, no bgm id", 1, nil, 0, false},
		// Page 3821 is AniList 182255's.  Reaching it through the bgm id of
		// an anime with another AniList id means the anime's bgm binding and
		// bangumi-data disagree, so it is not used.
		{"bgm hit on another AniList id's page", 1, ptr(515759), 0, false},
		// AniList 21 spans pages 228 and 3977.  Its bgm id names only one of
		// them; reading that page and dropping the keyword search would
		// lose the other page's releases.
		{"conflicted AniList id, through its own bgm id", 21, ptr(975), 0, false},
		{"conflicted AniList id, no bgm id", 21, nil, 0, false},
		// Nor may a bgm id that reaches some third, unowned page stand in
		// for a show that spans several.
		{"conflicted AniList id, bgm id on an unowned page", 21, ptr(999001), 0, false},
		// The conflict's pages are AniList 21's: another anime bound to one
		// of their subjects is refused, as for any owned page.
		{"bgm hit on a conflicted id's page", 1, ptr(602059), 0, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := m.Lookup(tc.anilistID, tc.bgmID)
			if got != tc.want || ok != tc.wantOK {
				t.Errorf("Lookup(%d, %v) = %d, %v; want %d, %v", tc.anilistID, tc.bgmID, got, ok, tc.want, tc.wantOK)
			}
		})
	}
}

func TestParse_VersionAndSize(t *testing.T) {
	m := mustParse(t, fixture)
	if m.Version() != "0.3.231" {
		t.Errorf("version: got %q", m.Version())
	}
	if anilist, bgm := m.Len(); anilist != 2 || bgm != 5 {
		t.Errorf("Len: got %d, %d", anilist, bgm)
	}
}

func TestParse_RejectsBadEntries(t *testing.T) {
	for name, data := range map[string]string{
		"not JSON":                      `{`,
		"non-numeric key":               `{"anilist": {"abc": 1}, "bgm": {}}`,
		"zero key":                      `{"anilist": {"0": 1}, "bgm": {}}`,
		"zero value":                    `{"anilist": {}, "bgm": {"5": 0}}`,
		"key past int32":                `{"anilist": {"4294967296": 1}, "bgm": {}}`,
		"string value":                  `{"anilist": {"5": "1"}, "bgm": {}}`,
		"negative value id":             `{"anilist": {"5": -1}, "bgm": {}}`,
		"conflict with one page":        `{"anilist": {}, "bgm": {}, "anilistConflicts": {"21": [228]}}`,
		"conflict with a zero page":     `{"anilist": {}, "bgm": {}, "anilistConflicts": {"21": [228, 0]}}`,
		"conflict key not an id":        `{"anilist": {}, "bgm": {}, "anilistConflicts": {"x": [1, 2]}}`,
		"mapped and conflicted at once": `{"anilist": {"21": 228}, "bgm": {}, "anilistConflicts": {"21": [228, 3977]}}`,
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := Parse([]byte(data)); err == nil {
				t.Error("want an error")
			}
		})
	}
}

// The vendored file is what the server embeds.  A missing, reshaped or
// emptied file must fail here, not at boot (where it would only log and
// leave every anime on Mikan's keyword search).
func TestEmbedded_ParsesAndIsSubstantial(t *testing.T) {
	m, err := Embedded()
	if err != nil {
		t.Fatalf("Embedded: %v", err)
	}
	if !regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+$`).MatchString(m.Version()) {
		t.Errorf("version %q is not a bangumi-data release number", m.Version())
	}
	anilist, bgm := m.Len()
	if anilist < 1000 || bgm < 1000 {
		t.Errorf("expected a substantial vendored map, got %d AniList and %d Bangumi ids", anilist, bgm)
	}
}

// The package-level Lookup answers from the embedded map.
func TestLookup_PackageLevelUsesTheEmbeddedMap(t *testing.T) {
	m, err := Embedded()
	if err != nil {
		t.Fatalf("Embedded: %v", err)
	}
	for anilistID, mikanID := range m.byAnilist {
		got, ok := Lookup(anilistID, nil)
		if !ok || got != mikanID {
			t.Errorf("Lookup(%d) = %d, %v; the embedded map says %d", anilistID, got, ok, mikanID)
		}
		return
	}
	t.Fatal("embedded map has no AniList ids")
}
