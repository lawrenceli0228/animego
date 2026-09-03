// scope_test.go — the boundary the scope guard draws, pinned.
//
// The ceiling is a number read off a live distribution, which makes it exactly
// the kind of constant that drifts silently: someone rounds 2.0 to 3.0 to make
// one anime pass, and 88% of a known defect quietly comes back.  These cases
// pin both sides of the boundary and, more importantly, pin the two bands the
// distribution said must behave differently -- a catalogue undercounting a
// season by one, and a four-episode ONA carrying a whole series.
package episodetitles

import "testing"

func ep(n int32) *int32 { return &n }

func titlesUpTo(max int32) []Title {
	out := make([]Title, 0, max)
	for i := int32(1); i <= max; i++ {
		out = append(out, Title{Episode: i, Name: "t"})
	}
	return out
}

func TestScopeExceeded(t *testing.T) {
	tests := []struct {
		name       string
		titles     []Title
		catalogue  *int32
		wantMax    int32
		wantExceed bool
	}{
		{
			// The <=1.10x band: 89% of those bindings are confirmed by an
			// independent map and the entries average 29 episodes.  An overrun
			// of one is the catalogue undercounting a season, and refusing it
			// would throw away a real episode title.
			name:       "a season the catalogue undercounts by one is written",
			titles:     titlesUpTo(13),
			catalogue:  ep(12),
			wantMax:    13,
			wantExceed: false,
		},
		{
			name:       "an exactly complete season is written",
			titles:     titlesUpTo(12),
			catalogue:  ep(12),
			wantMax:    12,
			wantExceed: false,
		},
		{
			// Exactly at the ceiling, which the comparison is deliberately not
			// strict about: 2x is still plausibly one entry.
			name:       "twice the catalogue length is still written",
			titles:     titlesUpTo(24),
			catalogue:  ep(12),
			wantMax:    24,
			wantExceed: false,
		},
		{
			name:       "one episode past twice the length is refused",
			titles:     titlesUpTo(25),
			catalogue:  ep(12),
			wantMax:    25,
			wantExceed: true,
		},
		{
			// The >2.00x band in its worst observed form: a four-episode entry
			// carrying a whole franchise.
			name:       "a four-episode entry does not hold three thousand episodes",
			titles:     titlesUpTo(3528),
			catalogue:  ep(4),
			wantMax:    3528,
			wantExceed: true,
		},
		{
			// 2.9% of bgm-bound rows have no episode count.  With no
			// denominator there is nothing to judge, and refusing on no
			// evidence would discard real titles.
			name:       "a row with no catalogue count is written",
			titles:     titlesUpTo(300),
			catalogue:  nil,
			wantMax:    300,
			wantExceed: false,
		},
		{
			name:       "a zero catalogue count is treated as unknown, not as zero",
			titles:     titlesUpTo(300),
			catalogue:  ep(0),
			wantMax:    300,
			wantExceed: false,
		},
		{
			// The guard reads the numbers about to be WRITTEN, not the count
			// of them.  A sparse list whose highest number runs past the entry
			// is the same defect as a dense one, and counting instead of
			// maximising would let it through.
			name: "a sparse list is judged by its highest number, not its length",
			titles: []Title{
				{Episode: 1, Name: "a"},
				{Episode: 900, Name: "b"},
			},
			catalogue:  ep(4),
			wantMax:    900,
			wantExceed: true,
		},
		{
			name:       "an empty list exceeds nothing",
			titles:     nil,
			catalogue:  ep(4),
			wantMax:    0,
			wantExceed: false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			gotMax, gotExceed := ScopeExceeded(tc.titles, tc.catalogue)
			if gotMax != tc.wantMax {
				t.Errorf("max episode = %d, want %d", gotMax, tc.wantMax)
			}
			if gotExceed != tc.wantExceed {
				t.Errorf("exceeded = %v, want %v (catalogue=%v, max=%d)",
					gotExceed, tc.wantExceed, tc.catalogue, gotMax)
			}
		})
	}
}
