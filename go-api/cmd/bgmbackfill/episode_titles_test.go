package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/lawrenceli0228/animego/go-api/internal/dandanplay"
)

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

// TestNextEmptyStreak pins the counter the breaker reads.
//
// The breaker's own predicate (shouldAbortOnEmptyStreak) was unit-tested from
// the day it shipped and was never wrong.  The counter feeding it lived inline
// in the loop, was not tested, and was wrong in a way that made the whole
// breaker inert against the exact failure it existed for.  That is the reason
// this function was pulled out: a guard is only as good as the number it is
// handed, and the number needs its own test.
func TestNextEmptyStreak(t *testing.T) {
	tests := []struct {
		name          string
		streak        int
		askedUpstream bool
		class         string
		want          int
	}{
		{
			name:          "an empty answer from upstream advances the streak",
			streak:        5,
			askedUpstream: true,
			class:         epClassNoTitles,
			want:          6,
		},
		{
			name:          "a real answer from upstream clears it",
			streak:        199,
			askedUpstream: true,
			class:         epClassWritten,
			want:          0,
		},
		{
			name:          "so does a real answer we then refuse to act on",
			streak:        199,
			askedUpstream: true,
			class:         epClassUndecided,
			want:          0,
		},
		{
			// The production bug, as a single row.  This row's subject was
			// fetched earlier in the same pass, so the response came from the
			// client's in-process cache and upstream was never asked.  Reading
			// it as proof of life is what kept the breaker from ever firing.
			name:          "a cached answer neither advances nor clears it",
			streak:        199,
			askedUpstream: false,
			class:         epClassUndecided,
			want:          199,
		},
		{
			name:          "a row decided before the fetch is equally neutral",
			streak:        150,
			askedUpstream: false,
			class:         epClassMapConflict,
			want:          150,
		},
		{
			name:          "a skipped row leaves the count where it was",
			streak:        150,
			askedUpstream: false,
			class:         epClassSkipped,
			want:          150,
		},
		{
			name:          "an upstream error is not an empty answer",
			streak:        10,
			askedUpstream: true,
			class:         epClassFetchFail,
			want:          0,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := nextEmptyStreak(tc.streak, tc.askedUpstream, tc.class); got != tc.want {
				t.Fatalf("nextEmptyStreak(%d, %v, %q) = %d, want %d",
					tc.streak, tc.askedUpstream, tc.class, got, tc.want)
			}
		})
	}
}

// TestEmptyStreakReachesThresholdDespiteCacheHits replays the production
// sequence that the old rule could not terminate.
//
// Upstream has gone quiet, so every row that reaches the network answers
// NO_TITLES.  Scattered among them are rows whose subject an earlier row
// already fetched -- 8.2% of one real candidate set, because 541 bgm subjects
// are held by more than one anime -- and those come back from cache carrying
// whatever the subject really said.  Under the old rule each of those reset
// the counter, so 350 consecutive dead rows never reached a threshold of 200.
//
// The assertion is that the streak now crosses the threshold, and the control
// case is that it does NOT cross when the same cached rows are counted as
// evidence of life.  Without the control this test would pass against the bug.
func TestEmptyStreakReachesThresholdDespiteCacheHits(t *testing.T) {
	const (
		rows         = 350
		cacheEvery   = 12 // the observed spacing
		threshold    = 200
		writtenSoFar = 3890 // the pass had already written, so the breaker is armed
	)

	// The fixed rule.
	streak := 0
	fired := false
	for i := 1; i <= rows; i++ {
		asked := i%cacheEvery != 0
		class := epClassNoTitles
		if !asked {
			class = epClassUndecided // what the cached response resolved to
		}
		streak = nextEmptyStreak(streak, asked, class)
		if shouldAbortOnEmptyStreak(streak, threshold, writtenSoFar) {
			fired = true
			break
		}
	}
	if !fired {
		t.Fatalf("the breaker never fired over %d dead rows; streak reached %d, threshold %d",
			rows, streak, threshold)
	}

	// Control: the old rule, restated here rather than referenced, so this
	// stays a statement about the two rules and not about whichever one the
	// production code currently holds.
	oldStreak := 0
	oldFired := false
	for i := 1; i <= rows; i++ {
		asked := i%cacheEvery != 0
		class := epClassNoTitles
		if !asked {
			class = epClassUndecided
		}
		switch {
		case class == epClassNoTitles:
			oldStreak++
		case class != epClassSkipped:
			oldStreak = 0
		}
		if shouldAbortOnEmptyStreak(oldStreak, threshold, writtenSoFar) {
			oldFired = true
			break
		}
	}
	if oldFired {
		t.Fatal("the control did not reproduce the bug, so the case above proves nothing " +
			"about the fix -- check the cache-hit spacing against the threshold")
	}
}

// TestClassifyFetchErrorSeesQuotaThroughTheRealClient drives the classifier
// with an error produced by the actual dandanplay client against the actual
// body upstream sends, rather than with a hand-made sentinel.
//
// That matters because the sentinel is wrapped twice on its way here — once by
// checkStatus and once by do() — and because the body that produces it is a
// 200. A classifier written against an assumption about either would compile,
// pass a test built on the same assumption, and classify every real quota
// refusal as FETCH_FAIL: counted, walked past, and repeated for every
// remaining row in the catalogue.
func TestClassifyFetchErrorSeesQuotaThroughTheRealClient(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK) // upstream really does answer 200
		_, _ = w.Write([]byte(`{"errorCode":429,"success":false,"errorMessage":"已达到接口调用配额上限"}`))
	}))
	defer srv.Close()

	c, err := dandanplay.NewClient(
		dandanplay.WithEndpoint(srv.URL),
		dandanplay.WithCredentials("id", "secret"),
	)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	defer c.Close()

	_, fetchErr := c.FetchEpisodesByBgmID(context.Background(), 253)
	if fetchErr == nil {
		t.Fatal("the client must surface a quota refusal as an error")
	}

	if got := classifyFetchError(fetchErr); got != epClassQuotaSpent {
		t.Fatalf("want %s so the run aborts, got %s — every remaining row would be asked and refused",
			epClassQuotaSpent, got)
	}
}

func TestClassifyFetchErrorLeavesOrdinaryFailuresAlone(t *testing.T) {
	// A transport failure says nothing about the budget, so it must stay
	// FETCH_FAIL and let the run continue: aborting the whole pass on one
	// flaky connection would be a worse bug than the one being fixed.
	if got := classifyFetchError(errors.New("dial tcp: connection refused")); got != epClassFetchFail {
		t.Fatalf("want %s, got %s", epClassFetchFail, got)
	}
}
