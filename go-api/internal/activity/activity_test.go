package activity

import (
	"testing"
	"time"
)

// TestDay_BucketsOnPlusEight pins the boundary that every date in this feature
// depends on.
//
// The failure this guards against is not a crash — it is a silently wrong
// chart.  Under UTC bucketing the whole 00:00–08:00 local slice of an evening
// lands on the previous calendar day, which is prime viewing time here, so a
// regression to UTC would split single evenings in two, inflate visit-day
// counts, and look entirely plausible on screen.
func TestDay_BucketsOnPlusEight(t *testing.T) {
	cases := []struct {
		name string
		in   time.Time
		want string
	}{
		{
			// 15:59 UTC is 23:59 local — the last minute of the local day.
			name: "last minute of the local day",
			in:   time.Date(2026, 8, 27, 15, 59, 0, 0, time.UTC),
			want: "2026-08-27",
		},
		{
			// One minute later is 00:00 local on the NEXT day.  This is the
			// pair that fails under UTC bucketing: UTC would put both on the
			// 27th.
			name: "first minute of the next local day",
			in:   time.Date(2026, 8, 27, 16, 0, 0, 0, time.UTC),
			want: "2026-08-28",
		},
		{
			// 02:00 local, i.e. an early-morning session.  UTC would file this
			// under the previous day, which is the specific error that would
			// smear an evening across two "active days".
			name: "early local morning stays on its own day",
			in:   time.Date(2026, 8, 27, 18, 0, 0, 0, time.UTC),
			want: "2026-08-28",
		},
		{
			// An input already carrying a non-UTC zone must be converted, not
			// read field-by-field.
			name: "input in another zone is converted",
			in:   time.Date(2026, 8, 27, 20, 0, 0, 0, time.FixedZone("UTC-4", -4*3600)),
			want: "2026-08-28",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := Day(tc.in).Format("2006-01-02")
			if got != tc.want {
				t.Fatalf("Day(%s) = %s, want %s", tc.in.Format(time.RFC3339), got, tc.want)
			}
		})
	}
}

// TestDay_ReturnsLocalMidnight checks the returned instant is midnight in the
// reporting zone, not merely a time somewhere inside the right day.  The
// recorder uses the value as a map key, so two instants in the same local day
// must produce byte-identical keys.
func TestDay_ReturnsLocalMidnight(t *testing.T) {
	morning := time.Date(2026, 8, 27, 1, 0, 0, 0, reportingZone)
	evening := time.Date(2026, 8, 27, 23, 30, 0, 0, reportingZone)

	if !Day(morning).Equal(Day(evening)) {
		t.Fatalf("same local day produced different buckets: %v vs %v", Day(morning), Day(evening))
	}
	got := Day(morning)
	if h, m, s := got.Clock(); h != 0 || m != 0 || s != 0 {
		t.Fatalf("Day did not return midnight: %v", got)
	}
}

func TestNormalizeSurface(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want Surface
	}{
		{"known surface passes through", "watch", SurfaceWatch},
		{"unknown surface degrades to other", "checkout", SurfaceOther},
		{"empty degrades to other", "", SurfaceOther},
		// Casing is not normalised on purpose: the allow-list is a fixed set of
		// lowercase identifiers the frontend sends verbatim, and accepting
		// "Watch" would mean two spellings of one surface could both be valid
		// depending on which caller ships first.
		{"casing is not coerced", "Watch", SurfaceOther},
		// The length guard runs before the map lookup so an oversized body
		// cannot be hashed on every request.
		{"oversized input is rejected before lookup", string(make([]byte, maxSurfaceLen+1)), SurfaceOther},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := NormalizeSurface(tc.in); got != tc.want {
				t.Fatalf("NormalizeSurface(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// TestNormalizeSurface_OnlyEmitsAllowListedValues is the constraint that
// matters at the database edge: whatever a caller sends, the string that
// reaches the INSERT is one the CHECK constraint accepts.  A failure here is a
// 500 in production, not a wrong number.
func TestNormalizeSurface_OnlyEmitsAllowListedValues(t *testing.T) {
	inputs := []string{
		"home", "anime", "watch", "seasonal", "library", "community",
		"profile", "search", "auth", "other",
		"", "HOME", "'; DROP TABLE users; --", "../../etc/passwd", "日本語",
	}
	for _, in := range inputs {
		got := NormalizeSurface(in)
		if _, ok := validSurfaces[got]; !ok {
			t.Fatalf("NormalizeSurface(%q) returned %q, which is not on the allow-list", in, got)
		}
	}
}

func TestValidKind(t *testing.T) {
	if !ValidKind(KindPageView) || !ValidKind(KindPlayback) {
		t.Fatal("the two real kinds must validate")
	}
	// Unlike surfaces, an unknown kind is REJECTED rather than bucketed: kind
	// decides which counter column moves, so silently treating an unfamiliar
	// value as a page view would corrupt a number rather than coarsen it.
	for _, bad := range []string{"", "pageview", "PAGE_VIEW", "scroll"} {
		if ValidKind(bad) {
			t.Fatalf("ValidKind(%q) = true, want false", bad)
		}
	}
}
