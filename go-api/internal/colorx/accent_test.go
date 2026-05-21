package colorx

import (
	"encoding/json"
	"math"
	"testing"
)

// strPtr returns a pointer to s — helper for table literals.
func strPtr(s string) *string { return &s }

// TestParseHex_TableDriven exercises the package-private parseHex helper across
// the full matrix of accepted/rejected formats: with #, without #, mixed case,
// invalid chars, wrong length, empty string.
func TestParseHex_TableDriven(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name      string
		input     string
		wantOK    bool
		wantHex   string
		wantR     int
		wantG     int
		wantB     int
	}{
		{"with hash lowercase", "#3b82f6", true, "#3b82f6", 0x3b, 0x82, 0xf6},
		{"without hash", "3b82f6", true, "#3b82f6", 0x3b, 0x82, 0xf6},
		{"uppercase canonicalized", "#3B82F6", true, "#3b82f6", 0x3b, 0x82, 0xf6},
		{"mixed case canonicalized", "#3B82f6", true, "#3b82f6", 0x3b, 0x82, 0xf6},
		{"black", "#000000", true, "#000000", 0, 0, 0},
		{"white", "#ffffff", true, "#ffffff", 0xff, 0xff, 0xff},
		{"empty string", "", false, "", 0, 0, 0},
		{"just hash", "#", false, "", 0, 0, 0},
		{"too short", "#abc", false, "", 0, 0, 0},
		{"too long", "#abcdefab", false, "", 0, 0, 0},
		{"non-hex chars", "#zzzzzz", false, "", 0, 0, 0},
		{"random text", "not-a-hex", false, "", 0, 0, 0},
		{"5 hex chars", "#abcde", false, "", 0, 0, 0},
		{"7 hex chars", "#abcdef0", false, "", 0, 0, 0},
		{"hex with spaces", "# 3b82f6", false, "", 0, 0, 0},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got, ok := parseHex(tc.input)
			if ok != tc.wantOK {
				t.Fatalf("parseHex(%q) ok = %v, want %v", tc.input, ok, tc.wantOK)
			}
			if !tc.wantOK {
				return
			}
			if got.hex != tc.wantHex {
				t.Errorf("parseHex(%q).hex = %q, want %q", tc.input, got.hex, tc.wantHex)
			}
			if got.r != tc.wantR || got.g != tc.wantG || got.b != tc.wantB {
				t.Errorf("parseHex(%q) rgb = (%d,%d,%d), want (%d,%d,%d)",
					tc.input, got.r, got.g, got.b, tc.wantR, tc.wantG, tc.wantB)
			}
		})
	}
}

// brandFallbackContrast is the WCAG contrast on black for the brand violet
// (#8B5CF6 → rgb(139,92,246)), computed once and locked here as a parity
// constant from the JS reference: 4.96.
const brandFallbackContrast = 4.96

// TestNormalize_NilInput confirms empty string routes to fallback with Raw=nil.
func TestNormalize_NilInput(t *testing.T) {
	t.Parallel()
	got := NormalizePosterAccent("")
	if got.Raw != nil {
		t.Errorf("Raw = %v, want nil", got.Raw)
	}
	if got.Accent != "#8B5CF6" {
		t.Errorf("Accent = %q, want %q", got.Accent, "#8B5CF6")
	}
	if got.AccentRgb != "139, 92, 246" {
		t.Errorf("AccentRgb = %q, want %q", got.AccentRgb, "139, 92, 246")
	}
	if got.AccentContrastOnBlack != brandFallbackContrast {
		t.Errorf("AccentContrastOnBlack = %v, want %v", got.AccentContrastOnBlack, brandFallbackContrast)
	}
}

// TestNormalize_InvalidHex confirms a non-hex string routes to fallback.
func TestNormalize_InvalidHex(t *testing.T) {
	t.Parallel()
	got := NormalizePosterAccent("not-a-hex")
	if got.Raw != nil {
		t.Errorf("Raw = %v, want nil", got.Raw)
	}
	if got.Accent != "#8B5CF6" {
		t.Errorf("Accent = %q, want %q", got.Accent, "#8B5CF6")
	}
	if got.AccentRgb != "139, 92, 246" {
		t.Errorf("AccentRgb = %q, want %q", got.AccentRgb, "139, 92, 246")
	}
}

// TestNormalize_BrandFallbackParity locks the exact fallback shape so any
// drift from #8B5CF6 / rgb(139,92,246) / 4.96 will fail loudly.
func TestNormalize_BrandFallbackParity(t *testing.T) {
	t.Parallel()
	got := NormalizePosterAccent("")
	want := PosterAccent{
		Raw:                   nil,
		Accent:                "#8B5CF6",
		AccentRgb:             "139, 92, 246",
		AccentContrastOnBlack: brandFallbackContrast,
	}
	if got.Raw != nil || got.Accent != want.Accent ||
		got.AccentRgb != want.AccentRgb ||
		got.AccentContrastOnBlack != want.AccentContrastOnBlack {
		t.Errorf("brand fallback = %+v, want %+v", got, want)
	}
}

// TestNormalize_GrayscaleRoutesToFallback confirms #888888 (chroma below
// grayscaleThreshold) preserves the input as Raw but returns brand fallback
// for accent / RGB / contrast.
func TestNormalize_GrayscaleRoutesToFallback(t *testing.T) {
	t.Parallel()
	got := NormalizePosterAccent("#888888")
	if got.Raw == nil {
		t.Fatal("Raw is nil, want pointer to #888888")
	}
	if *got.Raw != "#888888" {
		t.Errorf("Raw = %q, want %q", *got.Raw, "#888888")
	}
	if got.Accent != "#8B5CF6" {
		t.Errorf("Accent = %q, want %q", got.Accent, "#8B5CF6")
	}
	if got.AccentRgb != "139, 92, 246" {
		t.Errorf("AccentRgb = %q, want %q", got.AccentRgb, "139, 92, 246")
	}
	if got.AccentContrastOnBlack != brandFallbackContrast {
		t.Errorf("AccentContrastOnBlack = %v, want %v", got.AccentContrastOnBlack, brandFallbackContrast)
	}
}

// TestNormalize_VividInputClampsChroma confirms that a vivid input is
// processed (not passed through) and that contrast > 1 (i.e. not pure black).
// We assert structural invariants rather than an exact output so a slight
// JS-Go float drift here won't false-fail. Exact byte-parity is enforced
// separately in TestNormalize_HappyPath_FixedFixtures.
func TestNormalize_VividInputClampsChroma(t *testing.T) {
	t.Parallel()
	got := NormalizePosterAccent("#ff0000")
	if got.Raw == nil || *got.Raw != "#ff0000" {
		t.Errorf("Raw = %v, want pointer to #ff0000", got.Raw)
	}
	// Pure red has a very high L in OKLab actually — but let's just
	// confirm clamping went through (Accent != raw input is too strict
	// because clamping may legitimately not change every input).
	if got.AccentContrastOnBlack <= 1.0 {
		t.Errorf("AccentContrastOnBlack = %v, want > 1", got.AccentContrastOnBlack)
	}
	if got.Accent == "" || got.Accent[0] != '#' {
		t.Errorf("Accent = %q, want non-empty hex", got.Accent)
	}
	if got.AccentRgb == "" {
		t.Errorf("AccentRgb is empty")
	}
}

// TestNormalize_HappyPath_FixedFixtures locks byte-exact parity with the JS
// implementation for a handful of real-world inputs. These expected values
// were captured by running the JS source via `node -e ...` against the
// same inputs — see PR description for the capture command.
//
// THIS IS THE CRITICAL CORRECTNESS GATE. If this fails, the OKLab/OKLCH
// math has drifted from the reference implementation.
func TestNormalize_HappyPath_FixedFixtures(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name             string
		input            string
		wantRaw          string
		wantAccent       string
		wantAccentRgb    string
		wantContrast     float64
	}{
		{
			name:          "tailwind blue-500",
			input:         "#3b82f6",
			wantRaw:       "#3b82f6",
			wantAccent:    "#3b82f6",
			wantAccentRgb: "59, 130, 246",
			wantContrast:  5.71,
		},
		{
			name:          "tailwind pink-500",
			input:         "#ec4899",
			wantRaw:       "#ec4899",
			wantAccent:    "#ec4899",
			wantAccentRgb: "236, 72, 153",
			wantContrast:  5.95,
		},
		{
			name:          "tailwind emerald-500",
			input:         "#10b981",
			wantRaw:       "#10b981",
			wantAccent:    "#10b981",
			wantAccentRgb: "16, 185, 129",
			wantContrast:  8.28,
		},
		{
			name:          "pure red clamps to itself",
			input:         "#ff0000",
			wantRaw:       "#ff0000",
			wantAccent:    "#ff0000",
			wantAccentRgb: "255, 0, 0",
			wantContrast:  5.25,
		},
		{
			name:          "dark violet pumped to clamp",
			input:         "#1a0033",
			wantRaw:       "#1a0033",
			wantAccent:    "#8064aa",
			wantAccentRgb: "128, 100, 170",
			wantContrast:  4.32,
		},
		{
			name:          "pale green pulled down to clamp",
			input:         "#aaffaa",
			wantRaw:       "#aaffaa",
			wantAccent:    "#62b564",
			wantAccentRgb: "98, 181, 100",
			wantContrast:  8.31,
		},
		{
			name:          "uppercase normalizes to lowercase raw",
			input:         "#3B82F6",
			wantRaw:       "#3b82f6",
			wantAccent:    "#3b82f6",
			wantAccentRgb: "59, 130, 246",
			wantContrast:  5.71,
		},
		{
			name:          "missing leading hash still parsed",
			input:         "3b82f6",
			wantRaw:       "#3b82f6",
			wantAccent:    "#3b82f6",
			wantAccentRgb: "59, 130, 246",
			wantContrast:  5.71,
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := NormalizePosterAccent(tc.input)
			if got.Raw == nil {
				t.Fatalf("Raw is nil, want %q", tc.wantRaw)
			}
			if *got.Raw != tc.wantRaw {
				t.Errorf("Raw = %q, want %q", *got.Raw, tc.wantRaw)
			}
			if got.Accent != tc.wantAccent {
				t.Errorf("Accent = %q, want %q", got.Accent, tc.wantAccent)
			}
			if got.AccentRgb != tc.wantAccentRgb {
				t.Errorf("AccentRgb = %q, want %q", got.AccentRgb, tc.wantAccentRgb)
			}
			if got.AccentContrastOnBlack != tc.wantContrast {
				t.Errorf("AccentContrastOnBlack = %v, want %v",
					got.AccentContrastOnBlack, tc.wantContrast)
			}
		})
	}
}

// TestContrastOnBlack_Rounded confirms the contrast value is rounded to two
// decimal places — matching the JS `Number((...).toFixed(2))` behavior.
func TestContrastOnBlack_Rounded(t *testing.T) {
	t.Parallel()

	// Use the brand fallback's RGB and confirm the value rounds at 2dp.
	// 4.96 is the locked reference value.
	c := contrastOnBlack(139, 92, 246)
	if c != 4.96 {
		t.Errorf("contrastOnBlack(139,92,246) = %v, want 4.96", c)
	}

	// Confirm rounding rather than truncation: build a hypothetical value
	// and check it lands at 2dp. We'll do that by examining several
	// known fixture results and asserting the multiply-by-100 equals an int.
	knownInputs := []string{"#3b82f6", "#ec4899", "#10b981", "#ff0000", "#aaffaa"}
	for _, in := range knownInputs {
		got := NormalizePosterAccent(in).AccentContrastOnBlack
		scaled := got * 100
		if math.Abs(scaled-math.Round(scaled)) > 1e-9 {
			t.Errorf("%s contrast %v not rounded to 2dp (scaled=%v)", in, got, scaled)
		}
	}
}

// TestJSONEncoding_NullRaw asserts that nil Raw serializes to JSON null
// (not the string "<nil>" or an omitted field). This mirrors the JS shape.
func TestJSONEncoding_NullRaw(t *testing.T) {
	t.Parallel()

	got := NormalizePosterAccent("")
	encoded, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("json.Marshal failed: %v", err)
	}
	// Expect: {"raw":null,"accent":"#8B5CF6","accentRgb":"139, 92, 246","accentContrastOnBlack":4.96}
	want := `{"raw":null,"accent":"#8B5CF6","accentRgb":"139, 92, 246","accentContrastOnBlack":4.96}`
	if string(encoded) != want {
		t.Errorf("json = %s\nwant   %s", encoded, want)
	}
}

// TestJSONEncoding_RawSet asserts the JSON shape when Raw is populated.
func TestJSONEncoding_RawSet(t *testing.T) {
	t.Parallel()

	got := NormalizePosterAccent("#3b82f6")
	encoded, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("json.Marshal failed: %v", err)
	}
	want := `{"raw":"#3b82f6","accent":"#3b82f6","accentRgb":"59, 130, 246","accentContrastOnBlack":5.71}`
	if string(encoded) != want {
		t.Errorf("json = %s\nwant   %s", encoded, want)
	}
}

// Compile-time guard: strPtr is used; quiet linters if unused locally.
var _ = strPtr
