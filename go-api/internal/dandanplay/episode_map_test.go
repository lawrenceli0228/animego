package dandanplay

// episode_map_test.go — exhaustive off-by-one coverage for
// BuildEpisodeMap.  The 3-level fallback is the highest-risk piece of
// dandanplay code; every requested-episode boundary (1, last, beyond
// last) must be locked in so an upstream feed shape change can't
// silently degrade matching.

import (
	"reflect"
	"testing"
)

// helper: build a DandanEpisode with optional Number pointer.
func ep(id int64, title, raw string, number *int) DandanEpisode {
	return DandanEpisode{
		DandanEpisodeID:  id,
		Title:            title,
		RawEpisodeNumber: raw,
		Number:           number,
	}
}

func ip(n int) *int { return &n }

func TestBuildEpisodeMap_Empty(t *testing.T) {
	out := BuildEpisodeMap(nil, []int{1, 2, 3})
	if len(out) != 0 {
		t.Fatalf("nil dandan input → got map len %d, want 0", len(out))
	}
	out = BuildEpisodeMap([]DandanEpisode{}, []int{1})
	if len(out) != 0 {
		t.Fatalf("empty dandan input → got len %d, want 0", len(out))
	}
}

func TestBuildEpisodeMap_Level1_ExactNumeric(t *testing.T) {
	dandan := []DandanEpisode{
		ep(101, "Ep 1", "1", ip(1)),
		ep(102, "Ep 2", "2", ip(2)),
		ep(103, "Ep 3", "3", ip(3)),
	}
	out := BuildEpisodeMap(dandan, []int{1, 2, 3})
	want := map[int]EpisodeMapEntry{
		1: {DandanEpisodeID: 101, Title: "Ep 1"},
		2: {DandanEpisodeID: 102, Title: "Ep 2"},
		3: {DandanEpisodeID: 103, Title: "Ep 3"},
	}
	if !reflect.DeepEqual(out, want) {
		t.Fatalf("level1 exact-numeric mismatch:\n got:  %v\n want: %v", out, want)
	}
}

func TestBuildEpisodeMap_Level2_OVAPrefix(t *testing.T) {
	dandan := []DandanEpisode{
		ep(201, "Episode 1", "1", ip(1)),
		ep(202, "OVA 1", "O1", nil),
		ep(203, "Special 2", "S2", nil),
		ep(204, "special 3 lower", "s3", nil), // case-insensitive match
	}
	// Request episode 1 (numeric hit) + 1 (OVA), 2 (special), 3 (lower special).
	// Level 1 takes "1" first; level 2 fills 2 and 3 (OVA "S2", "s3").
	// The OVA "O1" wins for request 1 only if level 1 misses — which
	// it does NOT here, so OVA O1 stays unmatched and request 1 maps to
	// the numeric "1" entry.
	out := BuildEpisodeMap(dandan, []int{1, 2, 3})
	want := map[int]EpisodeMapEntry{
		1: {DandanEpisodeID: 201, Title: "Episode 1"},
		2: {DandanEpisodeID: 203, Title: "Special 2"},
		3: {DandanEpisodeID: 204, Title: "special 3 lower"},
	}
	if !reflect.DeepEqual(out, want) {
		t.Fatalf("level2 OVA prefix mismatch:\n got:  %v\n want: %v", out, want)
	}
}

func TestBuildEpisodeMap_Level3_IndexFallback_ContinuationSeason(t *testing.T) {
	// Continuation season: feed numbers 25..27 but the player is
	// requesting 1..3.  Pure-numeric pool picks up 25/26/27; pool[0]
	// → 25, pool[1] → 26, etc.  This is the "S2 numbered as 25-onward"
	// case Express buildEpisodeMap was designed for.
	dandan := []DandanEpisode{
		ep(401, "Ep 25", "25", ip(25)),
		ep(402, "Ep 26", "26", ip(26)),
		ep(403, "Ep 27", "27", ip(27)),
	}
	out := BuildEpisodeMap(dandan, []int{1, 2, 3})
	want := map[int]EpisodeMapEntry{
		1: {DandanEpisodeID: 401, Title: "Ep 25"},
		2: {DandanEpisodeID: 402, Title: "Ep 26"},
		3: {DandanEpisodeID: 403, Title: "Ep 27"},
	}
	if !reflect.DeepEqual(out, want) {
		t.Fatalf("continuation-season index fallback:\n got:  %v\n want: %v", out, want)
	}
}

func TestBuildEpisodeMap_Level3_FiltersOutSpecials(t *testing.T) {
	// Specials (C1, C2 — opening/ending) must be filtered from the
	// index pool so pool[0] lands on the first regular numeric episode.
	dandan := []DandanEpisode{
		ep(501, "OP1", "C1", nil),
		ep(502, "ED1", "C2", nil),
		ep(503, "Ep 1", "1", ip(1)), // pool index 0
		ep(504, "Ep 2", "2", ip(2)), // pool index 1
	}
	// Request episode 1 → level 1 hits the numeric "1".  Request 2
	// hits numeric "2".  Now request episode 3, which has NO direct
	// numeric — level 3 falls to pool[2] which doesn't exist; expect
	// no entry for 3.
	out := BuildEpisodeMap(dandan, []int{1, 2, 3})
	want := map[int]EpisodeMapEntry{
		1: {DandanEpisodeID: 503, Title: "Ep 1"},
		2: {DandanEpisodeID: 504, Title: "Ep 2"},
		// 3 absent — pool only has 2 entries.
	}
	if !reflect.DeepEqual(out, want) {
		t.Fatalf("specials-filtered pool mismatch:\n got:  %v\n want: %v", out, want)
	}
}

func TestBuildEpisodeMap_Level3_FallsThroughWhenNoNumericPool(t *testing.T) {
	// All entries are non-numeric — pool defaults to the full list to
	// avoid losing every match.
	dandan := []DandanEpisode{
		ep(601, "OVA 1", "OVA01", nil),
		ep(602, "OVA 2", "OVA02", nil),
	}
	out := BuildEpisodeMap(dandan, []int{1, 2})
	want := map[int]EpisodeMapEntry{
		1: {DandanEpisodeID: 601, Title: "OVA 1"},
		2: {DandanEpisodeID: 602, Title: "OVA 2"},
	}
	if !reflect.DeepEqual(out, want) {
		t.Fatalf("empty-pool fallback:\n got:  %v\n want: %v", out, want)
	}
}

func TestBuildEpisodeMap_BoundaryFirstEpisode(t *testing.T) {
	// Off-by-one canary: requesting episode 1 should hit pool[0], not
	// pool[1].  Build a pool where pool[0] is intentionally a numbered
	// continuation episode so we'd catch a 0-vs-1 indexing bug.
	pool0 := int(25)
	dandan := []DandanEpisode{
		ep(701, "Ep 25", "25", &pool0),
		ep(702, "Ep 26", "26", ip(26)),
	}
	out := BuildEpisodeMap(dandan, []int{1})
	want := map[int]EpisodeMapEntry{
		1: {DandanEpisodeID: 701, Title: "Ep 25"},
	}
	if !reflect.DeepEqual(out, want) {
		t.Fatalf("epNum=1 → pool[0] mismatch:\n got:  %v\n want: %v", out, want)
	}
}

func TestBuildEpisodeMap_BoundaryBeyondPool(t *testing.T) {
	// Requesting an episode past the pool length must NOT panic and
	// must NOT add a zero-value entry — caller treats missing as
	// "not in this feed".
	dandan := []DandanEpisode{
		ep(801, "Ep 1", "1", ip(1)),
		ep(802, "Ep 2", "2", ip(2)),
	}
	out := BuildEpisodeMap(dandan, []int{1, 2, 99})
	want := map[int]EpisodeMapEntry{
		1: {DandanEpisodeID: 801, Title: "Ep 1"},
		2: {DandanEpisodeID: 802, Title: "Ep 2"},
	}
	if !reflect.DeepEqual(out, want) {
		t.Fatalf("beyond-pool index:\n got:  %v\n want: %v", out, want)
	}
}

func TestBuildEpisodeMap_FirstMatchWinsAcrossLevels(t *testing.T) {
	// If level 1 matches an episode, level 2 / 3 must NOT overwrite it
	// even if an OVA prefix or index would also land on the same
	// requested number.
	dandan := []DandanEpisode{
		ep(901, "Ep 1 (numeric)", "1", ip(1)),
		ep(902, "OVA 1", "O1", nil), // would match level 2 for ep 1
	}
	out := BuildEpisodeMap(dandan, []int{1})
	want := map[int]EpisodeMapEntry{
		1: {DandanEpisodeID: 901, Title: "Ep 1 (numeric)"},
	}
	if !reflect.DeepEqual(out, want) {
		t.Fatalf("level 1 must win:\n got:  %v\n want: %v", out, want)
	}
}

func TestBuildEpisodeMap_MultipleRequestsMixedLevels(t *testing.T) {
	// Realistic: request 1, 2, 5; feed has numeric 1 and 2 (level 1),
	// OVA "O5" for episode 5 (level 2).  All three should map.
	dandan := []DandanEpisode{
		ep(1001, "Episode 1", "1", ip(1)),
		ep(1002, "Episode 2", "2", ip(2)),
		ep(1003, "OVA 5", "O5", nil),
	}
	out := BuildEpisodeMap(dandan, []int{1, 2, 5})
	want := map[int]EpisodeMapEntry{
		1: {DandanEpisodeID: 1001, Title: "Episode 1"},
		2: {DandanEpisodeID: 1002, Title: "Episode 2"},
		5: {DandanEpisodeID: 1003, Title: "OVA 5"},
	}
	if !reflect.DeepEqual(out, want) {
		t.Fatalf("mixed-levels request set:\n got:  %v\n want: %v", out, want)
	}
}
