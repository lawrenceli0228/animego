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

	"github.com/lawrenceli0228/animego/go-api/internal/titlematch"
)

// NormalizeTitle lower-cases the input and strips bracket / punctuation
// / whitespace runs.  Used by the loose-match accept gate in Phase 1
// to salvage candidates when dandanplay returns isMatched=false but the
// title overlap is obviously the right anime (new-season fansub
// releases that haven't been hash-indexed yet).
//
// The implementation — and the verbatim JS source it mirrors — moved to
// titlematch.LooseNormalize so that the containment half of the siteAnime
// gate could sit next to the similarity half without an import cycle.  This
// remains the dandanplay-facing name; behaviour is unchanged.
func NormalizeTitle(s string) string {
	return titlematch.LooseNormalize(s)
}

// TitleLooselyMatchesKeyword returns true when either normalised string
// is a substring of the other — the Phase 1 loose-match gate.  Empty
// inputs return false (avoids the empty-string is-substring-of-anything
// trap).
//
// Implemented by titlematch.LooselyMatchesKeyword; see NormalizeTitle above.
func TitleLooselyMatchesKeyword(animeTitle, keyword string) bool {
	return titlematch.LooselyMatchesKeyword(animeTitle, keyword)
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
