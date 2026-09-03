package main

import "testing"

// TestShouldAbortOnEmptyStreak pins the breaker that turns a silent upstream
// into a stopped run instead of a full one that wrote almost nothing.
//
// The case that motivated it: a production pass wrote 3,890 anime over its
// first 40%, then received nothing for the remaining 8,215 because the shared
// account hit a quota ceiling.  The client reports a 4xx and a subject with no
// episodes identically, so every one of those rows was recorded as "upstream
// had no titles" and the run reported success.
func TestShouldAbortOnEmptyStreak(t *testing.T) {
	tests := []struct {
		name                     string
		streak, maxStreak, wrote int
		want                     bool
	}{
		{"below the threshold keeps going", 199, 200, 3890, false},
		{"at the threshold stops", 200, 200, 3890, true},
		{"past the threshold stops", 500, 200, 3890, true},
		{
			// A pass that has written nothing has not shown the upstream ever
			// answered, so a long empty run is not evidence it STOPPED.  That
			// is a different diagnosis and must not be reported as this one.
			name:   "a long streak with no writes yet is not this failure",
			streak: 500, maxStreak: 200, wrote: 0, want: false,
		},
		{"zero disables the breaker", 10000, 0, 3890, false},
		{"negative disables the breaker", 10000, -1, 3890, false},
		{"a fresh pass with no streak keeps going", 0, 200, 0, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := shouldAbortOnEmptyStreak(tt.streak, tt.maxStreak, tt.wrote); got != tt.want {
				t.Fatalf("shouldAbortOnEmptyStreak(%d, %d, %d) = %v, want %v",
					tt.streak, tt.maxStreak, tt.wrote, got, tt.want)
			}
		})
	}
}
