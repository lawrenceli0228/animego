// Package torrents — BT magnet aggregator.
//
// This package is the Go port of the Express
// server/controllers/anime.controller.js "getTorrents" slice (lines
// 157-325).  It fans out to three upstream sources in parallel, merges
// the results, caches per-query for one hour, and tolerates partial
// failures (one source down → other two still served).
//
//   - garden.go   : animes.garden JSON aggregator (covers 动漫花园 + bangumi.moe)
//   - acgrip.go   : acg.rip RSS scrape
//   - nyaa.go     : nyaa.si RSS scrape
//   - source.go   : Source interface + Capabilities + funcSource adapter
//   - registry.go : ordered, pluggable collection of Sources to fan out to
//   - aggregator.go : parallel fan-out + cache + partial-tolerance
//
// types.go owns the wire-level result struct and the helpers shared by
// the three fetchers (FormatBytes / FormatKb / ParseFansub).  Each helper
// preserves Express's JS-quirky number-formatting verbatim — see
// docstrings for the parity rules.
package torrents

import (
	"math"
	"regexp"
	"strconv"
	"strings"
)

// Source identifies which upstream a TorrentItem came from.
//
// The string values match the legacy Express field exactly so the
// frontend's source-pill switch doesn't change behaviour during the
// migration: "garden" / "acg" / "nyaa".
type Source string

const (
	// SourceGarden is animes.garden — JSON aggregator covering dmhy +
	// bangumi.moe + others (provider field disambiguates).
	SourceGarden Source = "garden"
	// SourceAcg is acg.rip — RSS feed of mostly Chinese-sub anime.
	SourceAcg Source = "acg"
	// SourceNyaa is nyaa.si — RSS feed of mostly English-sub anime.
	SourceNyaa Source = "nyaa"
)

// TorrentItem is one row in the aggregated result.  JSON tag layout
// matches the Express response shape (see anime.controller.js:197-205,
// 229-243, 277-284):
//
//	{ title, magnet, size, fansub, date, source, provider }
//
// Fansub / Date are pointers so a nil value serialises to JSON null,
// mirroring Express's `null` on missing data.
//
// Provider is only populated for SourceGarden (upstream sub-source like
// "dmhy" / "moe").  For SourceAcg + SourceNyaa it is nil; with
// omitempty,nullable handling in encoding/json (pointer + omitempty
// drops the key when nil), the resulting JSON omits the key entirely
// for those sources — matching Express's behaviour of "key absent when
// the JS spread didn't set it".
type TorrentItem struct {
	Title    string  `json:"title"`
	Magnet   string  `json:"magnet"`
	Size     string  `json:"size"`
	Fansub   *string `json:"fansub"`
	Date     *string `json:"date"`
	Source   Source  `json:"source"`
	Provider *string `json:"provider,omitempty"`
}

// magnetScheme is the required prefix for any magnet URI.  Items whose
// magnet field doesn't start with this are filtered out by every
// fetcher — Express does the same with `i.magnet.startsWith('magnet:')`.
const magnetScheme = "magnet:"

// hasMagnetScheme reports whether s is a magnet URI.  Centralised so
// the three fetchers don't open-code the same prefix check.
func hasMagnetScheme(s string) bool {
	return strings.HasPrefix(s, magnetScheme)
}

// FormatBytes mirrors server/controllers/anime.controller.js:158
// formatBytes.  Input is a raw byte count (e.g. acg.rip RSS
// enclosure[@length]).  Empty / zero / negative / non-numeric prefix →
// returns the empty string, matching JS `if (!n || n <= 0) return ”;`.
//
// Output format (Express parity):
//   - n >= 1e9 → "X.X GB" via toFixed(1)
//   - n >= 1e6 → "X MB"   via toFixed(0)
//   - else     → "X KB"   via Math.round(n / 1e3)
//
// JS quirks honoured:
//   - parseInt is permissive — "1234abc" parses as 1234.  We mimic
//     this by stripping any non-digit suffix.
//   - parseInt("") and parseInt("abc") return NaN, which JS coerces
//     to falsy → ” is returned.
//   - Negative inputs (parseInt("-5") = -5) are also caught by the
//     <= 0 guard and return ”.
func FormatBytes(raw string) string {
	n, ok := parseIntJSLike(raw)
	if !ok || n <= 0 {
		return ""
	}
	f := float64(n)
	switch {
	case f >= 1e9:
		return strconv.FormatFloat(f/1e9, 'f', 1, 64) + " GB"
	case f >= 1e6:
		return strconv.Itoa(int(math.Round(f/1e6))) + " MB"
	default:
		return strconv.Itoa(int(math.Round(f/1e3))) + " KB"
	}
}

// FormatKb mirrors formatKb (anime.controller.js:170).  Input is a raw
// KB count (animes.garden returns `size` already in KB — verified
// against known 1080p movies and post-credit clips).  Same parsing
// quirks as FormatBytes; the only difference is the bucket thresholds
// are 1000x lower because the input unit is KB not B.
//
//   - n >= 1e6 → "X.X GB" via toFixed(1)
//   - n >= 1e3 → "X MB"   via toFixed(0)
//   - else     → "X KB"   (raw number, no conversion)
func FormatKb(raw string) string {
	n, ok := parseIntJSLike(raw)
	if !ok || n <= 0 {
		return ""
	}
	f := float64(n)
	switch {
	case f >= 1e6:
		return strconv.FormatFloat(f/1e6, 'f', 1, 64) + " GB"
	case f >= 1e3:
		return strconv.Itoa(int(math.Round(f/1e3))) + " MB"
	default:
		return strconv.Itoa(n) + " KB"
	}
}

// fansubBracketRE matches a leading bracketed group at the start of a
// title.  Supports both ASCII `[...]` and CJK `【...】` brackets, since
// Chinese-sub fansubs commonly use the CJK variant.
//
// Anchor explanation:
//   - `^`            → must be at title start
//   - `[\[【]`       → opening bracket, either kind
//   - `([^\]】]+)`   → capture group: anything except a closing bracket
//   - `[\]】]`       → closing bracket (note: must also match either kind
//     so a title like "[SubsPlease】..." is still parsed — rare but harmless)
//
// This is a verbatim port of the JS regex
// /^[\[【]([^\]】]+)[\]】]/ from anime.controller.js:179.
var fansubBracketRE = regexp.MustCompile(`^[\[【]([^\]】]+)[\]】]`)

// ParseFansub extracts the leading bracket group, e.g.
// "[SubsPlease] X" → "SubsPlease", "【喵萌奶茶屋】Y" → "喵萌奶茶屋".
// Returns nil if no bracket prefix matches.
//
// The returned pointer is the JSON null-vs-string discriminator: nil
// serialises to `"fansub": null`, a non-nil string serialises to the
// quoted value.  Matches Express's `parseFansub` returning `null` or a
// string.
func ParseFansub(title string) *string {
	m := fansubBracketRE.FindStringSubmatch(title)
	if m == nil {
		return nil
	}
	out := m[1]
	return &out
}

// stringPtr returns &s.  Defined here so the three fetchers don't each
// open-code "take the address of a local variable to satisfy the
// pointer field on TorrentItem".  Returns nil for the empty input so a
// missing upstream date / provider serialises as JSON null instead of
// an empty string.
func stringPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// parseIntJSLike mimics JS parseInt(string, 10) for the subset of
// inputs the upstream sources produce.  Specifically:
//
//   - Leading whitespace is skipped (JS parseInt does this).
//   - An optional leading sign ("+" / "-") is consumed.
//   - Digits are consumed greedily.
//   - First non-digit terminates the parse → "1234abc" → 1234.
//   - No digits → returns (0, false).
//
// Returns (n, true) on a valid parse.  The bool lets callers distinguish
// "0 parsed" from "no number" — currently both code paths return ”
// from Format{Bytes,Kb} so it's a defensive distinction, but it keeps
// the helper honest if a future call site cares.
func parseIntJSLike(raw string) (int, bool) {
	s := strings.TrimLeft(raw, " \t\n\r\f\v")
	if s == "" {
		return 0, false
	}

	neg := false
	switch s[0] {
	case '+':
		s = s[1:]
	case '-':
		neg = true
		s = s[1:]
	}

	end := 0
	for end < len(s) && s[end] >= '0' && s[end] <= '9' {
		end++
	}
	if end == 0 {
		return 0, false
	}

	n, err := strconv.Atoi(s[:end])
	if err != nil {
		// Overflow — fall back to "no parse" so the caller returns "".
		// JS parseInt would return a float here, but the comparison
		// `n >= 1e9` is still correct at the bucket level; preserving
		// the JS quirk for arbitrarily-huge integers isn't worth the
		// big.Int dance.
		return 0, false
	}
	if neg {
		n = -n
	}
	return n, true
}
