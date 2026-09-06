package queue

import (
	"testing"

	"github.com/stretchr/testify/require"
)

// planRetraction is the entire policy of the Bangumi withdrawal, so these are
// the tests that decide what it will and will not delete in production.
//
// The cases are written as pairs wherever a boundary exists, because the one
// mutation that survived the #156 round was an off-by-one on a bound whose
// only test passed a value where both sides of the branch agreed.  An episode
// exactly ON the window and one exactly past it must therefore appear
// together, and so must "held equals kept" against "held has one extra".
func TestPlanRetraction(t *testing.T) {
	tests := []struct {
		name      string
		kept      []int32
		held      []int32
		window    int32
		withdraw  int
		shielded  int
		protected []int32
	}{
		{
			name:      "an empty kept-set decides nothing and protects nothing",
			kept:      nil,
			held:      []int32{1, 2, 3},
			window:    12,
			withdraw:  0,
			shielded:  0,
			protected: nil,
		},
		{
			name:      "a fetch that re-states everything held withdraws nothing",
			kept:      []int32{1, 2, 3},
			held:      []int32{1, 2, 3},
			window:    3,
			withdraw:  0,
			shielded:  0,
			protected: []int32{1, 2, 3},
		},
		{
			name:      "a tail past the season is withdrawn",
			kept:      []int32{1, 2, 3},
			held:      []int32{1, 2, 3, 4, 5},
			window:    3,
			withdraw:  2,
			shielded:  0,
			protected: []int32{1, 2, 3},
		},
		{
			name:      "★ the last episode of the season is not a tail",
			kept:      []int32{1, 2},
			held:      []int32{1, 2, 3},
			window:    3,
			withdraw:  0,
			shielded:  1,
			protected: []int32{1, 2, 3},
		},
		{
			name:      "★ one past the season is",
			kept:      []int32{1, 2},
			held:      []int32{1, 2, 4},
			window:    3,
			withdraw:  1,
			shielded:  0,
			protected: []int32{1, 2},
		},
		{
			name:      "★ a half-answered fetch loses nothing",
			kept:      []int32{1, 2, 3, 4, 5, 6},
			held:      []int32{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12},
			window:    12,
			withdraw:  0,
			shielded:  6,
			protected: []int32{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12},
		},
		{
			name:      "★ an unknown season length asks no question and answers none",
			kept:      []int32{1, 2},
			held:      []int32{1, 2, 3, 400},
			window:    0,
			withdraw:  0,
			shielded:  2,
			protected: []int32{1, 2, 3, 400},
		},
		{
			name:      "the two verdicts are reached independently on the same anime",
			kept:      []int32{1, 2, 3},
			held:      []int32{1, 2, 3, 5, 13, 26},
			window:    12,
			withdraw:  2,
			shielded:  1,
			protected: []int32{1, 2, 3, 5},
		},
		{
			name:      "an episode upstream lists but has not named is kept, not withdrawn",
			kept:      []int32{1, 2, 3, 4},
			held:      []int32{1, 2},
			window:    4,
			withdraw:  0,
			shielded:  0,
			protected: []int32{1, 2, 3, 4},
		},
		{
			name:      "holding nothing yet is not a withdrawal",
			kept:      []int32{1, 2, 3},
			held:      nil,
			window:    12,
			withdraw:  0,
			shielded:  0,
			protected: []int32{1, 2, 3},
		},
		{
			name:      "a repeated held episode is counted once",
			kept:      []int32{1},
			held:      []int32{5, 5, 5},
			window:    3,
			withdraw:  1,
			shielded:  0,
			protected: []int32{1},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := planRetraction(tc.kept, tc.held, tc.window)

			require.Equal(t, tc.withdraw, got.withdraw, "rows to withdraw")
			require.Equal(t, tc.shielded, got.shielded, "rows the guard spared")
			require.Equal(t, tc.protected, nilIfEmpty(got.protected),
				"the kept-set handed to the retraction")
		})
	}
}

// TestPlanRetractionProtectedSetIsAscending pins the ordering the SQL argument
// is built from.  ClearEpisodeTitlesBySourceOutside does not care about order,
// but the logs and the integration assertions compare slices, and an unstable
// order would make a passing test a coin flip -- the protected set is built by
// ranging over a map.
func TestPlanRetractionProtectedSetIsAscending(t *testing.T) {
	got := planRetraction([]int32{9, 3, 1}, []int32{2, 7}, 12)

	require.Equal(t, []int32{1, 2, 3, 7, 9}, got.protected)
	require.Equal(t, 0, got.withdraw)
	require.Equal(t, 2, got.shielded)
}

// TestKeptEpisodesCountsTheUnnamed is the seam between the write and the
// withdrawal.  writeEpisodeTitles skips a title with no name in either
// language; the kept-set must not, or every unaired episode of an airing show
// would look like a row upstream had dropped.
func TestKeptEpisodesCountsTheUnnamed(t *testing.T) {
	name := "Sea of Trees"
	titles := []epTitle{
		{episode: 1, nameCN: &name},
		{episode: 2},
		{episode: 3, name: &name},
	}

	require.Equal(t, []int32{1, 2, 3}, keptEpisodes(titles))
}

func nilIfEmpty(v []int32) []int32 {
	if len(v) == 0 {
		return nil
	}
	return v
}
