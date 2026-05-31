// Package dandanplay — title normalisation + episode-number extraction
// helpers shared by the 3-phase match orchestration and the buildEpisodeMap
// fallbacks.  Mirrors server/controllers/dandanplay.controller.js
// + server/services/dandanplay.service.js helpers verbatim — the unicode
// strip table, the 6 episode-regex patterns, and the parseEpField rule
// all match the JS originals byte-for-byte so the cutover diff stays
// clean.

package dandanplay

import (
	"regexp"
	"strconv"
	"strings"
)

// stripChars is the exact set of code points
// server/controllers/dandanplay.controller.js:normalizeTitle erases.
// JS regex: /[\s\[\]【】()《》「」『』,.\-_~!@#$%^&*+=|\\/:;?'"]/g
//
// Listed verbatim here so the cutover audit can grep both sides.
// `\s` translates to unicode whitespace (handled by unicode.IsSpace).
var stripChars = map[rune]struct{}{
	'[': {}, ']': {}, '【': {}, '】': {},
	'(': {}, ')': {}, '《': {}, '》': {}, '「': {}, '」': {}, '『': {}, '』': {},
	',': {}, '.': {}, '-': {}, '_': {}, '~': {},
	'!': {}, '@': {}, '#': {}, '$': {}, '%': {}, '^': {}, '&': {}, '*': {},
	'+': {}, '=': {}, '|': {}, '\\': {}, '/': {}, ':': {}, ';': {}, '?': {},
	'\'': {}, '"': {},
}

// NormalizeTitle lower-cases the input and strips bracket / punctuation
// / whitespace runs.  Used by the loose-match accept gate in Phase 1
// to salvage candidates when dandanplay returns isMatched=false but the
// title overlap is obviously the right anime (new-season fansub
// releases that haven't been hash-indexed yet).
//
// JS source (verbatim):
//
//	function normalizeTitle(s) {
//	  return String(s || '')
//	    .toLowerCase()
//	    .replace(/[\s\[\]【】()《》「」『』,.\-_~!@#$%^&*+=|\\/:;?'"]/g, '');
//	}
func NormalizeTitle(s string) string {
	if s == "" {
		return ""
	}
	lower := strings.ToLower(s)
	var b strings.Builder
	b.Grow(len(lower))
	for _, r := range lower {
		// Whitespace catch-all (matches \s in JS regex).
		if r == ' ' || r == '\t' || r == '\n' || r == '\r' || r == '\f' || r == '\v' || r == ' ' {
			continue
		}
		if _, drop := stripChars[r]; drop {
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

// TitleLooselyMatchesKeyword returns true when either normalised string
// is a substring of the other — the Phase 1 loose-match gate.  Empty
// inputs return false (avoids the empty-string is-substring-of-anything
// trap).
//
// JS source:
//
//	function titleLooselyMatchesKeyword(animeTitle, keyword) {
//	  const a = normalizeTitle(animeTitle);
//	  const k = normalizeTitle(keyword);
//	  if (!a || !k) return false;
//	  return a.includes(k) || k.includes(a);
//	}
func TitleLooselyMatchesKeyword(animeTitle, keyword string) bool {
	a := NormalizeTitle(animeTitle)
	k := NormalizeTitle(keyword)
	if a == "" || k == "" {
		return false
	}
	return strings.Contains(a, k) || strings.Contains(k, a)
}

// ParseEpField returns the integer parse of a raw episode field if and
// only if the field is *pure digits* — Express explicitly rejects
// "C1" / "O2" / "SP1" / etc. so OVA/Special markers don't masquerade
// as numbered episodes.
//
// JS source:
//
//	function parseEpField(epNum) {
//	  if (!epNum) return null;
//	  const n = /^\d+$/.test(epNum) ? parseInt(epNum, 10) : null;
//	  return n;
//	}
func ParseEpField(epNum string) (int, bool) {
	if epNum == "" {
		return 0, false
	}
	if !pureDigitsRe.MatchString(epNum) {
		return 0, false
	}
	n, err := strconv.Atoi(epNum)
	if err != nil {
		return 0, false
	}
	return n, true
}

// pureDigitsRe matches "^\d+$" — Express's parseEpField guard.
var pureDigitsRe = regexp.MustCompile(`^\d+$`)

// episodeTitlePatterns is the priority-ordered list of regex patterns
// ExtractEpisodeNumber walks to pull a numeric episode out of a free-
// form episode title.  Six patterns, identical to Express:
//
//	1. 第(\d+)[話话集]           Japanese kanji "第1話", "第2话", "第3集"
//	2. (?i)EP?\s*(\d+)            "EP01", "E01", "Ep 01"
//	3. (?i)S\d+E(\d+)             "S01E03"
//	4. (?i)\b(?:Episode|Ep\.?)\s*(\d+)   "Episode 1", "Ep.1"
//	5. ^(\d+)$                    bare "1" / "01"
//	6. (\d+)$                     trailing number (catch-all)
//
// (?i) is the Go regex inline-flag for case-insensitive matching;
// Go's regexp package does not have a separate flag arg.
var episodeTitlePatterns = []*regexp.Regexp{
	regexp.MustCompile(`第(\d+)[話话集]`),
	regexp.MustCompile(`(?i)EP?\s*(\d+)`),
	regexp.MustCompile(`(?i)S\d+E(\d+)`),
	regexp.MustCompile(`(?i)\b(?:Episode|Ep\.?)\s*(\d+)`),
	regexp.MustCompile(`^(\d+)$`),
	regexp.MustCompile(`(\d+)$`),
}

// ExtractEpisodeNumber scans the title with each pattern in priority
// order; returns (n, true) on first match, (0, false) on none.
//
// Used by client.go when the dandanplay row has a non-numeric
// rawEpisodeNumber (e.g. "C1" opening) but the title carries the real
// episode number ("第13話 タイトル").  ParseEpField runs first; this
// is the fallback.
func ExtractEpisodeNumber(title string) (int, bool) {
	if title == "" {
		return 0, false
	}
	for _, re := range episodeTitlePatterns {
		m := re.FindStringSubmatch(title)
		if len(m) >= 2 {
			n, err := strconv.Atoi(m[1])
			if err == nil {
				return n, true
			}
		}
	}
	return 0, false
}
