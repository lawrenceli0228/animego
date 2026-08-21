package hant

// The quality gate.
//
// Both vendored datasets are human-curated, and neither is clean.  A
// candidate that fails any rule below is dropped and the ladder falls
// through to the next tier, which is always a demotion -- usually to
// `opencc`, which migration 0022's generated title_hant_seo column keeps
// out of search results.  Losing a SERP-eligible title is the cheap
// mistake.  Publishing 黒の断章 as a row's Traditional Chinese name, or
// publishing a string with 学 in it under a locale whose whole point is
// that it does not use 学, is the expensive one.
//
// Every rule below is a measurement, not a guess.  The counts quoted are
// over the 8,492 records in anilist-chinese.json.

import (
	"fmt"
	"unicode"
)

// RejectReason names the rule that dropped a candidate.  It is also the
// key the JSON report groups rejections under, so the strings are part of
// the report's interface.
type RejectReason string

const (
	ReasonNone       RejectReason = ""
	ReasonKana       RejectReason = "kana"
	ReasonNoHan      RejectReason = "no_han"
	ReasonSimplified RejectReason = "simplified"
	ReasonEmpty      RejectReason = "empty"
)

// gate decides whether a dataset string may be written to a *_hant
// column.  It needs the converter because the Simplified rule is derived
// from the conversion table rather than hard-coded.
type gate struct {
	// simplified holds every rune that exists in Simplified Chinese and
	// does NOT survive Simplified→Traditional character conversion
	// unchanged.  See newGate for how it is derived and why it is not
	// simply "STCharacters has an entry for this rune".
	simplified map[rune]struct{}
}

// newGate derives the Simplified rune set from the loaded conversion
// table.
//
// The rule we want is "does a Simplified→Traditional character
// conversion change the string?", and the tempting implementation --
// convert each rune through the character dictionary and compare -- is
// wrong.  The dictionary is one-to-many: 里 maps to [裏 里] because 里 is
// *both* a Simplified form of 裏 and a Traditional character in its own
// right.  Taking the first alternative rewrites 里 to 裏 and the naive
// comparison then rejects 心之谷 and every other perfectly Traditional
// title containing 里, 后, 干, 面, 松, 几, 只, 谷 or 丰.
//
// The correct reading of "the conversion changes it" is "this character
// has no Traditional reading of itself" -- i.e. the dictionary has an
// entry for it and the rune is not among its own alternatives.  Of the
// 3,980 single-rune entries in STCharacters, 3,810 satisfy that and 170
// (里, 后, 干, ...) do not.
//
// Deriving the set from the table rather than listing characters by hand
// also means it tracks the vendored OpenCC release automatically, which
// is the property the instruction to avoid a hand-written list is after.
func newGate(c *Converter) (*gate, error) {
	cd, err := c.charDict()
	if err != nil {
		return nil, fmt.Errorf("build simplified rune set: %w", err)
	}

	simp := make(map[rune]struct{}, len(cd.entries))
	for key, alts := range cd.entries {
		rs := []rune(key)
		if len(rs) != 1 {
			continue
		}
		survives := false
		for _, alt := range alts {
			if alt == key {
				survives = true
				break
			}
		}
		if !survives {
			simp[rs[0]] = struct{}{}
		}
	}
	if len(simp) == 0 {
		return nil, fmt.Errorf("simplified rune set came out empty; the table is wrong")
	}
	return &gate{simplified: simp}, nil
}

// hasKana reports whether s contains a character in U+3040–U+30FF.
//
// 957 anilist-chinese titles that also contain Han characters are the
// Japanese original passed through untranslated (黒の断章, 夜が来る!), and
// another 350 are kana with no Han at all.  Writing those into a
// Traditional Chinese column ships Japanese to Chinese readers under a
// column that claims to be a translation.
//
// The range is used verbatim rather than unicode.Hiragana/unicode.Katakana
// because it is the rule as specified.  It is very slightly wider: U+30FB
// (・) and U+30FC (ー) sit inside it but carry script=Common, so a title
// using ・ as a separator is rejected as though it were Japanese.  Measured
// cost over both datasets is 5 candidates, all of which are Japanese
// anyway; the wider rule is kept because a rule stated as a range and
// implemented as a range cannot drift from its documentation.
func hasKana(s string) bool {
	for _, r := range s {
		if r >= 0x3040 && r <= 0x30FF {
			return true
		}
	}
	return false
}

// hasHan reports whether s contains any Han character.
//
// unicode.Han covers every CJK block including the extensions, so this
// does not need a hand-maintained range list.
func hasHan(s string) bool {
	for _, r := range s {
		if unicode.Is(unicode.Han, r) {
			return true
		}
	}
	return false
}

// simplifiedRunes returns the Simplified-only runes in s, in order of
// first appearance and deduplicated.  Empty means the string is clean.
func (g *gate) simplifiedRunes(s string) []rune {
	var out []rune
	seen := make(map[rune]struct{})
	for _, r := range s {
		if _, bad := g.simplified[r]; !bad {
			continue
		}
		if _, dup := seen[r]; dup {
			continue
		}
		seen[r] = struct{}{}
		out = append(out, r)
	}
	return out
}

// check runs the three rules in order and returns the first that fires.
//
// The order is not arbitrary.  Kana is checked first because a kana
// string is Japanese whether or not it also has Han characters; no-Han is
// checked next because a string with no Han cannot contain a Simplified
// Han character, so the third rule would have nothing to say about it.
// Reporting the *first* matching rule is what makes the report's
// per-rule counts add up to the rejection total.
func (g *gate) check(s string) (RejectReason, []rune) {
	if s == "" {
		return ReasonEmpty, nil
	}
	if hasKana(s) {
		return ReasonKana, nil
	}
	if !hasHan(s) {
		return ReasonNoHan, nil
	}
	if bad := g.simplifiedRunes(s); len(bad) > 0 {
		return ReasonSimplified, bad
	}
	return ReasonNone, nil
}
