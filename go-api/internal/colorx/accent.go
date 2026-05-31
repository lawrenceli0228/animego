// Package colorx — port of server/utils/normalizeAccent.js. OKLab/OKLCH
// math + brand fallback + WCAG contrast computation. Output must match
// the JS for any input hex (validated by parity fixtures in accent_test.go).
package colorx

import (
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
)

// PosterAccent is the shape returned by NormalizePosterAccent.
// JSON tags follow the legacy Express envelope:
//
//	{ "raw": ..., "accent": ..., "accentRgb": ..., "accentContrastOnBlack": ... }
//
// Raw is *string because the JS returns `null` for invalid input — encoding/json
// will emit JSON null for nil string pointers.
type PosterAccent struct {
	Raw                   *string `json:"raw"`
	Accent                string  `json:"accent"`
	AccentRgb             string  `json:"accentRgb"`
	AccentContrastOnBlack float64 `json:"accentContrastOnBlack"`
}

const (
	brandFallback      = "#8B5CF6"
	chromaFloor        = 0.11
	lightnessMin       = 0.56
	lightnessMax       = 0.70
	grayscaleThreshold = 0.005 // raw chroma below this = no meaningful hue
)

// hexPattern matches a 6-character lowercase hex string.
var hexPattern = regexp.MustCompile(`^[0-9a-f]{6}$`)

// parsedHex is the result of parseHex: canonical lowercase hex plus 0-255 RGB.
type parsedHex struct {
	hex     string
	r, g, b int
}

// parseHex accepts input with or without a leading '#', lowercases it, and
// validates against ^[0-9a-f]{6}$. Returns ok=false for empty/invalid input.
func parseHex(input string) (parsedHex, bool) {
	if input == "" {
		return parsedHex{}, false
	}
	m := strings.ToLower(strings.TrimPrefix(input, "#"))
	if !hexPattern.MatchString(m) {
		return parsedHex{}, false
	}
	r, _ := strconv.ParseInt(m[0:2], 16, 32)
	g, _ := strconv.ParseInt(m[2:4], 16, 32)
	b, _ := strconv.ParseInt(m[4:6], 16, 32)
	return parsedHex{
		hex: "#" + m,
		r:   int(r),
		g:   int(g),
		b:   int(b),
	}, true
}

// srgbToLinear converts an 8-bit sRGB channel value to linear light.
func srgbToLinear(c int) float64 {
	n := float64(c) / 255.0
	if n <= 0.04045 {
		return n / 12.92
	}
	return math.Pow((n+0.055)/1.055, 2.4)
}

// linearToSrgb converts a linear-light value back to an 8-bit sRGB channel,
// clamped to [0, 255].
func linearToSrgb(c float64) int {
	var v float64
	if c <= 0.0031308 {
		v = c * 12.92
	} else {
		v = 1.055*math.Pow(c, 1.0/2.4) - 0.055
	}
	rounded := math.Round(v * 255.0)
	if rounded < 0 {
		rounded = 0
	}
	if rounded > 255 {
		rounded = 255
	}
	return int(rounded)
}

// oklab is the OKLab L*a*b* triplet.
type oklab struct {
	L, a, b float64
}

// linearToOklab applies Björn Ottosson's OKLab forward matrices.
// See https://bottosson.github.io/posts/oklab/
func linearToOklab(r, g, b float64) oklab {
	l := math.Cbrt(0.4122214708*r + 0.5363325363*g + 0.0514459929*b)
	m := math.Cbrt(0.2119034982*r + 0.6806995451*g + 0.1073969566*b)
	s := math.Cbrt(0.0883024619*r + 0.2817188376*g + 0.6299787005*b)
	return oklab{
		L: 0.2104542553*l + 0.7936177850*m - 0.0040720468*s,
		a: 1.9779984951*l - 2.4285922050*m + 0.4505937099*s,
		b: 0.0259040371*l + 0.7827717662*m - 0.8086757660*s,
	}
}

// linearRgb is the linear-light RGB triplet.
type linearRgb struct {
	r, g, b float64
}

// oklabToLinear applies the OKLab inverse matrices, returning linear-light RGB.
func oklabToLinear(L, a, b float64) linearRgb {
	l_ := L + 0.3963377774*a + 0.2158037573*b
	m_ := L - 0.1055613458*a - 0.0638541728*b
	s_ := L - 0.0894841775*a - 1.2914855480*b
	l := l_ * l_ * l_
	m := m_ * m_ * m_
	s := s_ * s_ * s_
	return linearRgb{
		r: 4.0767416621*l - 3.3077115913*m + 0.2309699292*s,
		g: -1.2684380046*l + 2.6097574011*m - 0.3413193965*s,
		b: -0.0041960863*l - 0.7034186147*m + 1.7076147010*s,
	}
}

// oklch is the OKLCH polar form: lightness, chroma, hue (radians).
type oklch struct {
	L, C, h float64
}

// rgbToOklch converts an 8-bit RGB triplet to OKLCH.
func rgbToOklch(p parsedHex) oklch {
	lin := linearToOklab(srgbToLinear(p.r), srgbToLinear(p.g), srgbToLinear(p.b))
	C := math.Sqrt(lin.a*lin.a + lin.b*lin.b)
	h := math.Atan2(lin.b, lin.a)
	return oklch{L: lin.L, C: C, h: h}
}

// oklchHexResult mirrors the JS oklchToHex return shape.
type oklchHexResult struct {
	hex     string
	r, g, b int
}

// oklchToHex converts an OKLCH triplet back to an sRGB hex + 8-bit RGB.
func oklchToHex(o oklch) oklchHexResult {
	a := o.C * math.Cos(o.h)
	b := o.C * math.Sin(o.h)
	lin := oklabToLinear(o.L, a, b)
	r8 := linearToSrgb(lin.r)
	g8 := linearToSrgb(lin.g)
	b8 := linearToSrgb(lin.b)
	return oklchHexResult{
		hex: fmt.Sprintf("#%02x%02x%02x", r8, g8, b8),
		r:   r8,
		g:   g8,
		b:   b8,
	}
}

// contrastOnBlack returns the WCAG contrast ratio of the given RGB against
// pure black, rounded to two decimal places (matching the JS toFixed(2)).
func contrastOnBlack(r, g, b int) float64 {
	L := 0.2126*srgbToLinear(r) + 0.7152*srgbToLinear(g) + 0.0722*srgbToLinear(b)
	ratio := (L + 0.05) / 0.05
	return math.Round(ratio*100) / 100
}

// makeBrandFallback assembles a PosterAccent using the brand violet (#8B5CF6).
// raw is the *string to set on the result (nil for invalid input, &canonicalHex
// for grayscale input that parsed cleanly).
func makeBrandFallback(raw *string) PosterAccent {
	parsed, _ := parseHex(brandFallback)
	return PosterAccent{
		Raw:                   raw,
		Accent:                brandFallback,
		AccentRgb:             fmt.Sprintf("%d, %d, %d", parsed.r, parsed.g, parsed.b),
		AccentContrastOnBlack: contrastOnBlack(parsed.r, parsed.g, parsed.b),
	}
}

// NormalizePosterAccent clamps OKLCH chroma & lightness so every poster
// accent carries visible weight; falls back to brand violet (#8B5CF6) for
// null / invalid / grayscale inputs.
//
// Empty string, missing "#", non-hex chars, wrong length, or chroma below
// grayscaleThreshold all route to the brand fallback.
func NormalizePosterAccent(input string) PosterAccent {
	parsed, ok := parseHex(input)
	if !ok {
		return makeBrandFallback(nil)
	}

	oc := rgbToOklch(parsed)

	// Grayscale covers have no meaningful hue — don't invent one.
	if oc.C < grayscaleThreshold {
		hex := parsed.hex
		return makeBrandFallback(&hex)
	}

	clampedC := math.Max(oc.C, chromaFloor)
	clampedL := math.Min(math.Max(oc.L, lightnessMin), lightnessMax)

	result := oklchToHex(oklch{L: clampedL, C: clampedC, h: oc.h})
	rawCopy := parsed.hex
	return PosterAccent{
		Raw:                   &rawCopy,
		Accent:                result.hex,
		AccentRgb:             fmt.Sprintf("%d, %d, %d", result.r, result.g, result.b),
		AccentContrastOnBlack: contrastOnBlack(result.r, result.g, result.b),
	}
}
