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
		if isLooseSpace(r) {
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
// contains the other, starting and ending on a word boundary wherever the
// text is Latin.  Empty inputs return false (avoids the
// empty-string is-substring-of-anything trap).  The relation is symmetric.
//
// The boundary rule is the one change from the JS source below.  Plain
// substring containment let a release group's short name ("Tensei shita",
// for Tensei Shita Daiseijo wa…) match "Tensei Shitara Slime Datta Ken",
// because LooseNormalize joins the words and "tenseishita" is a prefix of
// "tenseishitara…".  A match may not begin or end between two ASCII letters
// or digits that sat next to each other in the original text.  CJK titles,
// which do not separate words, keep plain containment ("葬送的芙莉莲" is in
// "葬送的芙莉莲第二季"), and a keyword that writes words together still
// matches ("ReZERO" is in "Re:Zero kara…").
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
	a, aSep := looseRunes(animeTitle)
	k, kSep := looseRunes(keyword)
	if len(a) == 0 || len(k) == 0 {
		return false
	}
	return containsOnBoundaries(a, aSep, k) || containsOnBoundaries(k, kSep, a)
}

// looseRunes is LooseNormalize as runes, plus, for each kept rune, whether
// a dropped one (whitespace, bracket, punctuation) came right before it.
func looseRunes(s string) ([]rune, []bool) {
	lower := strings.ToLower(s)
	runes := make([]rune, 0, len(lower))
	sepBefore := make([]bool, 0, len(lower))
	dropped := false
	for _, r := range lower {
		if isLooseSpace(r) {
			dropped = true
			continue
		}
		if _, drop := stripChars[r]; drop {
			dropped = true
			continue
		}
		runes = append(runes, r)
		sepBefore = append(sepBefore, dropped)
		dropped = false
	}
	return runes, sepBefore
}

func isLooseSpace(r rune) bool {
	return r == ' ' || r == '\t' || r == '\n' || r == '\r' || r == '\f' || r == '\v' || r == '\u00a0'
}

// containsOnBoundaries reports whether needle occurs in hay at a position
// that does not cut a Latin word in hay.
func containsOnBoundaries(hay []rune, sepBefore []bool, needle []rune) bool {
	for i := 0; i+len(needle) <= len(hay); i++ {
		if !runesEqual(hay[i:i+len(needle)], needle) {
			continue
		}
		if cutsLatinWord(hay, sepBefore, i) || cutsLatinWord(hay, sepBefore, i+len(needle)) {
			continue
		}
		return true
	}
	return false
}

// cutsLatinWord reports whether the gap before hay[p] falls inside a Latin
// word: an ASCII letter or digit on each side, with nothing dropped between.
func cutsLatinWord(hay []rune, sepBefore []bool, p int) bool {
	if p <= 0 || p >= len(hay) || sepBefore[p] {
		return false
	}
	return isASCIIAlnum(hay[p-1]) && isASCIIAlnum(hay[p])
}

func isASCIIAlnum(r rune) bool {
	return (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9')
}

func runesEqual(a, b []rune) bool {
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
