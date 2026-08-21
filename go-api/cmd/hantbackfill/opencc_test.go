package main

import (
	"strings"
	"testing"
)

// ─── the algorithm, on a table small enough to reason about ──────────────────

// tinyTable exercises every structural feature the format has: two
// stages, a two-dictionary group, a multi-rune key, and a value with
// space-separated alternatives.
const tinyTable = `# comment lines are ignored

@group
@dict Phrases.txt aaaa
干面包	乾麵包
@dict Chars.txt bbbb
干	幹 乾 干
面	面 麪
包	包
@group
@dict Vocab.txt cccc
乾麵包	吐司
`

func TestConverterChainOrderAndGroupPrecedence(t *testing.T) {
	c, err := parseConverter(strings.NewReader(tinyTable))
	if err != nil {
		t.Fatalf("parseConverter: %v", err)
	}
	if len(c.stages) != 2 {
		t.Fatalf("stages = %d, want 2", len(c.stages))
	}
	if len(c.stages[0].dicts) != 2 {
		t.Fatalf("stage 0 dicts = %d, want 2", len(c.stages[0].dicts))
	}

	// Phrases beats Chars inside the group: 干面包 matches as a phrase, so
	// 干 never reaches the character table's first alternative 幹.  Then
	// stage 2 rewrites the whole phrase.  This is the property that makes
	// OpenCC more than a character map.
	if got := c.Convert("干面包"); got != "吐司" {
		t.Fatalf("Convert(干面包) = %q, want 吐司 (phrase, then vocabulary stage)", got)
	}

	// Without the phrase context the character table applies and takes
	// its first alternative.
	if got := c.Convert("干"); got != "幹" {
		t.Fatalf("Convert(干) = %q, want 幹 (first alternative)", got)
	}

	// Unmatched runes pass through untouched, one at a time.
	if got := c.Convert("干x面"); got != "幹x面" {
		t.Fatalf("Convert(干x面) = %q, want 幹x面", got)
	}
	if got := c.Convert(""); got != "" {
		t.Fatalf("Convert(\"\") = %q", got)
	}
}

// Forward maximum match means the longest key that is a *prefix* of the
// remaining text, not the longest key found anywhere in it.  That is
// upstream OpenCC's rule and it is what distinguishes this from the
// Python reimplementation.
func TestConverterMatchesLongestPrefixNotLongestAnywhere(t *testing.T) {
	c, err := parseConverter(strings.NewReader(`@group
@dict d.txt x
ab	1
abc	2
bc	3
`))
	if err != nil {
		t.Fatalf("parseConverter: %v", err)
	}
	// At position 0 the longest prefix is abc.
	if got := c.Convert("abc"); got != "2" {
		t.Fatalf("Convert(abc) = %q, want 2", got)
	}
	// At position 0 of "abd" the longest prefix is ab; d falls through.
	if got := c.Convert("abd"); got != "1d" {
		t.Fatalf("Convert(abd) = %q, want 1d", got)
	}
	// "zbc" has no match at 0, so z is copied and the scan resumes at 1.
	if got := c.Convert("zbc"); got != "z3" {
		t.Fatalf("Convert(zbc) = %q, want z3", got)
	}
}

func TestParseConverterRejectsMalformedTables(t *testing.T) {
	cases := []struct {
		name, table, want string
	}{
		{"entry before dict", "a\tb\n", "before any @dict"},
		{"dict before group", "@dict d.txt x\n", "before any @group"},
		{"no stages", "# nothing here\n", "no @group"},
		{"empty group", "@group\n", "no @dict"},
		{"missing tab", "@group\n@dict d.txt x\nab\n", "KEY<TAB>VALUE"},
		{"bad dict header", "@group\n@dict d.txt\n", "@dict wants"},
		{"duplicate key", "@group\n@dict d.txt x\na\tb\na\tc\n", "duplicates key"},

		// The value field is non-empty in all three of these, so the
		// coarse `value == ""` check passes them.  Each still yields an
		// alternative that must not reach matchPrefix: alts[0] == "" would
		// silently delete every matched span instead of converting it, and
		// an embedded tab would emit a control character into a title.
		{"leading space makes alts[0] empty", "@group\n@dict d.txt x\n干\t 幹 乾\n", "empty alternative at position 0"},
		{"double space makes an inner alt empty", "@group\n@dict d.txt x\n干\t幹  乾\n", "empty alternative at position 1"},
		{"second tab lands inside an alternative", "@group\n@dict d.txt x\n干\t幹\t乾\n", "tab inside alternative"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := parseConverter(strings.NewReader(tc.table))
			if err == nil {
				t.Fatalf("want an error containing %q, got nil", tc.want)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %v, want it to mention %q", err, tc.want)
			}
		})
	}
}

// charDict finds the character table by shape, not by filename, so the
// Simplified gate survives an upstream rename.  It must also refuse to
// guess when the shape is ambiguous.
func TestCharDictSelectsBySingleRuneKeys(t *testing.T) {
	c, err := parseConverter(strings.NewReader(tinyTable))
	if err != nil {
		t.Fatalf("parseConverter: %v", err)
	}
	d, err := c.charDict()
	if err != nil {
		t.Fatalf("charDict: %v", err)
	}
	if d.name != "Chars.txt" {
		t.Fatalf("charDict = %q, want Chars.txt", d.name)
	}

	ambiguous, err := parseConverter(strings.NewReader("@group\n@dict a.txt x\n干\t幹\n@dict b.txt y\n面\t麪\n"))
	if err != nil {
		t.Fatalf("parseConverter: %v", err)
	}
	if _, err := ambiguous.charDict(); err == nil {
		t.Fatal("two single-rune dictionaries in one stage must be an error, not a coin flip")
	}
}

// ─── the vendored table ──────────────────────────────────────────────────────

// The shape assertions guard against a truncated or half-regenerated
// file, which would otherwise surface as quietly worse conversions.
func TestVendoredTableShape(t *testing.T) {
	c := testConverter(t)
	if len(c.stages) != 3 {
		t.Fatalf("s2twp has %d stages, want 3", len(c.stages))
	}
	want := [][]string{
		{"STPhrases.txt", "STCharacters.txt"},
		{"TWPhrases.txt"},
		{"TWVariants.txt"},
	}
	for i, names := range want {
		if len(c.stages[i].dicts) != len(names) {
			t.Fatalf("stage %d has %d dicts, want %d", i, len(c.stages[i].dicts), len(names))
		}
		for j, name := range names {
			if got := c.stages[i].dicts[j].name; got != name {
				t.Fatalf("stage %d dict %d = %q, want %q", i, j, got, name)
			}
		}
	}
	// STPhrases carries no single-rune keys — the property charDict
	// relies on.  If a future OpenCC release adds one, this fails here
	// rather than silently corrupting the Simplified gate.
	for k := range c.stages[0].dicts[0].entries {
		if len([]rune(k)) == 1 {
			t.Fatalf("STPhrases gained a single-rune key %q; charDict's selection rule no longer holds", k)
		}
	}
}

// Real conversions, all of them titles or phrases the site actually
// serves.
func TestVendoredTableConverts(t *testing.T) {
	c := testConverter(t)
	cases := []struct{ in, want string }{
		{"进击的巨人", "進擊的巨人"},
		{"鬼灭之刃", "鬼滅之刃"},
		{"星际牛仔", "星際牛仔"},
		{"海贼王", "海賊王"},
		// The vocabulary stage, which is what the "p" in s2twp buys over
		// plain s2t.
		{"软件", "軟體"},
		{"程序", "程式"},
		// Already-Traditional text is a fixed point.
		{"進擊的巨人", "進擊的巨人"},
		// Latin and punctuation pass through untouched.
		{".hack//SIGN", ".hack//SIGN"},
	}
	for _, tc := range cases {
		t.Run(tc.in, func(t *testing.T) {
			if got := c.Convert(tc.in); got != tc.want {
				t.Fatalf("Convert(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// Determinism is the property the whole opencc tier rests on: the same
// input must produce the same bytes on every run, or the source hash
// means nothing.
func TestConvertIsDeterministic(t *testing.T) {
	c := testConverter(t)
	const in = "2021年，随着超光速航行技术的实现，人类得以在太阳系范围内方便的自由移动。"
	first := c.Convert(in)
	for i := 0; i < 20; i++ {
		if got := c.Convert(in); got != first {
			t.Fatalf("run %d produced %q, first run produced %q", i, got, first)
		}
	}
	if first == in {
		t.Fatal("a Simplified sentence converted to itself; the table is not being applied")
	}
}
