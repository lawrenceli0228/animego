package queue

import (
	"testing"

	"github.com/lawrenceli0228/animego/go-api/internal/episodetitles"
)

// windowTitles is the RELEASING sweep's half of the season window. It has to
// reach the same answer normalizeEpisodeTitles does on the Bangumi list --
// both go through episodeBound -- or the two writers would disagree about
// where a season begins while writing the same table.
//
// Before this, the sweep refused a too-wide list outright. That was right
// about the prefix (a series list has the SERIES' episode 1 at its head) and
// wrong about the conclusion: the window names which slice is this season's,
// so there is something better to do than refuse.

func titles(nums ...int32) []episodetitles.Title {
	out := make([]episodetitles.Title, 0, len(nums))
	for _, n := range nums {
		out = append(out, episodetitles.Title{Episode: n, Name: "E" + string(rune('0'+n%10))})
	}
	return out
}

func nums(ts []episodetitles.Title) []int32 {
	out := make([]int32, 0, len(ts))
	for _, t := range ts {
		out = append(out, t.Episode)
	}
	return out
}

func eqI32(a, b []int32) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestWindowTitles_UnknownTotalRefuses(t *testing.T) {
	t.Parallel()
	z := int32(0)
	if got := windowTitles(titles(1, 2, 3), 0, &z); got != nil {
		t.Fatalf("no season length means no window to compute: %v", nums(got))
	}
}

func TestWindowTitles_UnknownOffsetRefuses(t *testing.T) {
	t.Parallel()
	// known:false is not offset:0. Defaulting here would renumber a list
	// against an origin nobody established -- the exact write the window
	// exists to prevent.
	if got := windowTitles(titles(1, 2, 3), 2, nil); got != nil {
		t.Fatalf("unknown offset must refuse, got %v", nums(got))
	}
}

func TestWindowTitles_FirstSeasonKeepsTheHead(t *testing.T) {
	t.Parallel()
	zero := int32(0)
	got := windowTitles(titles(1, 2, 3, 4), 2, &zero)
	if want := []int32{1, 2}; !eqI32(nums(got), want) {
		t.Fatalf("offset 0 window is [1,total]: got %v want %v", nums(got), want)
	}
}

func TestWindowTitles_SequelTakesItsOwnSliceAndRenumbers(t *testing.T) {
	t.Parallel()
	// The case that is wrong in production today: slots 1..N hold the
	// PREVIOUS season's titles because the list starts at the franchise's
	// episode 1. The window must select the tail AND map it onto 1..total.
	off := int32(2)
	src := []episodetitles.Title{
		{Episode: 1, Name: "S1E1"}, {Episode: 2, Name: "S1E2"},
		{Episode: 3, Name: "S2E1"}, {Episode: 4, Name: "S2E2"},
	}
	got := windowTitles(src, 2, &off)
	if want := []int32{1, 2}; !eqI32(nums(got), want) {
		t.Fatalf("renumbering wrong: got %v want %v", nums(got), want)
	}
	if got[0].Name != "S2E1" || got[1].Name != "S2E2" {
		t.Fatalf("slot 1 must hold THIS season's first episode, got %q,%q", got[0].Name, got[1].Name)
	}
}

func TestWindowTitles_EmptyWindowYieldsNothing(t *testing.T) {
	t.Parallel()
	// An offset past everything the list holds describes no episodes. The
	// caller reads the empty result as a refusal rather than writing a prefix.
	off := int32(50)
	if got := windowTitles(titles(1, 2, 3), 2, &off); len(got) != 0 {
		t.Fatalf("empty window must yield nothing, got %v", nums(got))
	}
}
