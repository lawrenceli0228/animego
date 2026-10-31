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
// the fetchers (FormatBinaryBytes / ParseFansub).
package torrents

import (
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

	// Seeders is the peer seed count when the source can report it.
	// It is a pointer so the JSON discriminates three states:
	//   - non-nil → a known count (may legitimately be 0 = "0 seeders")
	//   - nil     → UNKNOWN (the source can't report seeders) — this is
	//     the case for the RSS scrapes (acg / nyaa) and any garden row
	//     missing the field.
	// nil is deliberately NOT the same as 0: the ranker sinks "unknown"
	// to the bottom rather than treating it as a genuine zero-seed
	// torrent.  omitempty drops the key entirely when nil, matching the
	// "key absent when upstream didn't set it" convention the other
	// optional fields use.
	Seeders *int `json:"seeders,omitempty"`

	// Infohash is the normalised BitTorrent infohash parsed from Magnet
	// (lowercase hex; base32 v1 hashes are decoded to 40-char hex; v1 is
	// 40 hex chars, v2 is 64).  Empty when the magnet carries no parseable
	// xt=urn:btih:<hash>.  It is the dedup key — two rows with the same
	// non-empty Infohash are the same torrent regardless of which source
	// surfaced them.  omitempty drops the key when no hash could be
	// derived, keeping the wire shape stable for magnet-less rows.
	Infohash string `json:"infohash,omitempty"`
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

// minRealSizeBytes is the smallest byte count FormatBinaryBytes treats as
// a real size; anything below it is a placeholder (see FormatBinaryBytes).
const minRealSizeBytes = 1024

// binaryUnits are the size units FormatBinaryBytes steps through, each
// 1024x the previous.  They are the units Nyaa prints in <nyaa:size>.
var binaryUnits = []string{"KiB", "MiB", "GiB", "TiB"}

// FormatBinaryBytes renders a raw byte count the way Nyaa renders sizes
// ("568.0 MiB", "26.3 GiB"): divide by 1024 until the value is below
// 1024 or the units run out, then print one decimal.
//
// Nyaa passes its size through as a ready-made string, while garden,
// dmhy, Mikan, acg.rip and AnimeTosho hand over byte counts.  Formatting
// those in decimal units (the old FormatBytes) printed the same file as
// "596 MB" from garden and "568.0 MiB" from Nyaa, so one release showed
// two different sizes in one list.  Using Nyaa's binary layout makes the
// same infohash read identically whichever source surfaced it.
//
// Input parsing keeps the parseIntJSLike leniency ("1234abc" is 1234).
// Empty, non-numeric and sub-KiB inputs yield "" — the "no size" signal
// the frontend hides.  The sub-KiB cut exists because dmhy's RSS puts a
// placeholder in <enclosure length>: on 2026-10-31 all 500 items of a
// live feed carried length="1", which the decimal formatter printed as
// "0 KB".  No real torrent payload is under a kibibyte, so a number that
// small is a placeholder, not a size.
func FormatBinaryBytes(raw string) string {
	n, ok := parseIntJSLike(raw)
	if !ok || n < minRealSizeBytes {
		return ""
	}
	v := float64(n) / 1024
	unit := binaryUnits[0]
	for _, u := range binaryUnits[1:] {
		if v < 1024 {
			break
		}
		v /= 1024
		unit = u
	}
	return strconv.FormatFloat(v, 'f', 1, 64) + " " + unit
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

// sceneTailRE strips what follows a scene-style release name: trailing
// notes in parentheses or brackets ("(VF, FRENCH, VOSTFR)", "(CR)",
// "[rartv]") and a file extension.  sceneGroup applies it until nothing
// more comes off.
var sceneTailRE = regexp.MustCompile(`\s*(?:\([^()]*\)|\[[^\[\]]*\])\s*$|\.(?i:mkv|mp4|avi)$`)

// sceneGroupRE reads the group off the last word of a scene-style release
// name, whose words are split by spaces or dots: "-Group" alone, or glued
// to the codec, audio, channel, source or language token before it
// ("x264-Tsundere-Raws", "H 264-VARYG", ".WEBRiP.x265-KAF", "FLAC 2.0-StaFer",
// "MULTi.VOSTFR-Tinosoft").  Requiring that token keeps a hyphenated title
// word from reading as a group.
var sceneGroupRE = regexp.MustCompile(
	`(?i)(?:^|[\s.])(?:x26[45]|h\.?26[45]|hevc|avc|av1|xvid|aac[0-9.]*|e?ac-?3[0-9.]*|ddp?[0-9.]*(?:\.atmos)?|` +
		`flac[0-9.]*|opus[0-9.]*|dts[a-z0-9.]*|truehd[0-9.]*|mp3|10-?bits?|8-?bits?|hi10p?|` +
		`web(?:rip|-?dl)?|blu-?ray|bdrip|bdremux|remux|hdtv|26[45]|[0-9]\.[0-9]|atmos|vostfr|multi|dual-?audio)?` +
		`-([a-z0-9][a-z0-9_]*(?:-[a-z0-9][a-z0-9_]*)*)$`)

// sceneNotGroups are the words that end a release name after a hyphen
// without naming a group ("WEB-DL", "Blu-ray").
var sceneNotGroups = map[string]bool{"dl": true, "rip": true, "ray": true, "dual": true, "multi": true}

// ParseFansub extracts the release group: the leading bracket group, e.g.
// "[SubsPlease] X" → "SubsPlease", "【喵萌奶茶屋】Y" → "喵萌奶茶屋", or,
// when the title has none, the group a scene-style name ends with, e.g.
// "Show S02E10 1080p WEB H.264-VARYG (CR)" → "VARYG".  Returns nil when
// neither is there.
//
// The returned pointer is the JSON null-vs-string discriminator: nil
// serialises to `"fansub": null`, a non-nil string serialises to the
// quoted value.  Matches Express's `parseFansub` returning `null` or a
// string.
func ParseFansub(title string) *string {
	if m := fansubBracketRE.FindStringSubmatch(title); m != nil {
		out := m[1]
		return &out
	}
	return sceneGroup(title)
}

// sceneGroup is ParseFansub's reading of a scene-style release name.
func sceneGroup(title string) *string {
	name := strings.TrimSpace(title)
	for range 4 {
		cut := strings.TrimSpace(sceneTailRE.ReplaceAllString(name, ""))
		if cut == name {
			break
		}
		name = cut
	}
	m := sceneGroupRE.FindStringSubmatch(name)
	if m == nil || sceneNotGroups[strings.ToLower(m[1])] {
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
// "0 parsed" from "no number" — currently both return "" from
// FormatBinaryBytes so it's a defensive distinction, but it keeps the
// helper honest if a future call site cares.
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
		// JS parseInt would return a float here; an int64 overflow is
		// 8 EiB, far past any real torrent, so "no size" is the honest
		// answer and not worth a big.Int dance.
		return 0, false
	}
	if neg {
		n = -n
	}
	return n, true
}
