package anilist

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func ip(v int) *int { return &v }

// TestFuzzyDate_Whole — all three parts or nothing, and an impossible
// day is refused rather than rolled forward.  This is the rule every
// writer of a date column follows (anime.dateFromFuzzy, queue.dateColumn),
// so it is pinned once here rather than once per writer.
func TestFuzzyDate_Whole(t *testing.T) {
	for _, tc := range []struct {
		name string
		in   *FuzzyDate
		want *time.Time
	}{
		{"nil receiver", nil, nil},
		{"all null", &FuzzyDate{}, nil},
		{"year only", &FuzzyDate{Year: ip(2011)}, nil},
		{"year and month", &FuzzyDate{Year: ip(2011), Month: ip(10)}, nil},
		{"no year", &FuzzyDate{Month: ip(10), Day: ip(3)}, nil},
		{"full", &FuzzyDate{Year: ip(2011), Month: ip(10), Day: ip(3)}, tp(time.Date(2011, 10, 3, 0, 0, 0, 0, time.UTC))},
		{"zero year", &FuzzyDate{Year: ip(0), Month: ip(1), Day: ip(1)}, nil},
		{"month 13", &FuzzyDate{Year: ip(2011), Month: ip(13), Day: ip(1)}, nil},
		{"day 32", &FuzzyDate{Year: ip(2011), Month: ip(1), Day: ip(32)}, nil},
		{"Feb 30 refused, not normalised to Mar 2", &FuzzyDate{Year: ip(2023), Month: ip(2), Day: ip(30)}, nil},
		{"leap day accepted", &FuzzyDate{Year: ip(2024), Month: ip(2), Day: ip(29)}, tp(time.Date(2024, 2, 29, 0, 0, 0, 0, time.UTC))},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := tc.in.Whole()
			if tc.want == nil {
				assert.False(t, ok, "expected no whole date, got %v", got)
				return
			}
			require.True(t, ok)
			assert.Equal(t, *tc.want, got)
		})
	}
}

func tp(t time.Time) *time.Time { return &t }
