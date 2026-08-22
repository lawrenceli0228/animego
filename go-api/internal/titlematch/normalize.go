// Package titlematch — normalize.go
//
// The LOOSE normaliser: lowercases and strips brackets / punctuation /
// whitespace, and — unlike bangumi.NormalizeTitle — leaves season and part
// markers intact.  That is what makes it safe to use for containment: a
// containment pass cannot smuggle a wrong season past a caller's marker gate,
// because the marker is still in both strings.
//
// Moved here verbatim from internal/dandanplay so that the containment half of
// MatchesQuery lives next to the similarity half instead of forcing an import
// cycle.  dandanplay.NormalizeTitle and dandanplay.TitleLooselyMatchesKeyword
// remain as thin wrappers over these.

package titlematch

import "strings"

// stripChars is the exact set of code points
// server/controllers/dandanplay.controller.js:normalizeTitle erases.
// JS regex: /[\s\[\]【】()《》「」『』,.\-_~!@#$%^&*+=|\\/:;?'"]/g
//
// Listed verbatim here so the cutover audit can grep both sides.
// `\s` translates to unicode whitespace (handled below).
var stripChars = map[rune]struct{}{
	'[': {}, ']': {}, '【': {}, '】': {},
	'(': {}, ')': {}, '《': {}, '》': {}, '「': {}, '」': {}, '『': {}, '』': {},
	',': {}, '.': {}, '-': {}, '_': {}, '~': {},
	'!': {}, '@': {}, '#': {}, '$': {}, '%': {}, '^': {}, '&': {}, '*': {},
	'+': {}, '=': {}, '|': {}, '\\': {}, '/': {}, ':': {}, ';': {}, '?': {},
	'\'': {}, '"': {},
}

// LooseNormalize lower-cases the input and strips bracket / punctuation
// / whitespace runs, keeping season and part markers.  Used by the
// loose-match accept gate in dandanplay's Phase 1 to salvage candidates when
// dandanplay returns isMatched=false but the title overlap is obviously the
// right anime (new-season fansub releases that haven't been hash-indexed
// yet), and by MatchesQuery's containment branch.
//
// JS source (verbatim):
//
//	function normalizeTitle(s) {
//	  return String(s || '')
//	    .toLowerCase()
//	    .replace(/[\s\[\]【】()《》「」『』,.\-_~!@#$%^&*+=|\\/:;?'"]/g, '');
//	}
func LooseNormalize(s string) string {
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

// LooselyMatchesKeyword returns true when either LooseNormalize-d string
// is a substring of the other.  Empty inputs return false (avoids the
// empty-string is-substring-of-anything trap).  The relation is symmetric.
//
// JS source:
//
//	function titleLooselyMatchesKeyword(animeTitle, keyword) {
//	  const a = normalizeTitle(animeTitle);
//	  const k = normalizeTitle(keyword);
//	  if (!a || !k) return false;
//	  return a.includes(k) || k.includes(a);
//	}
func LooselyMatchesKeyword(animeTitle, keyword string) bool {
	a := LooseNormalize(animeTitle)
	k := LooseNormalize(keyword)
	if a == "" || k == "" {
		return false
	}
	return strings.Contains(a, k) || strings.Contains(k, a)
}
