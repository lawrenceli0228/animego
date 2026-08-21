package main

import "testing"

// Every fixture below is a real string out of data/hant/*.json.  A gate
// tested against invented strings proves the gate compiles; a gate tested
// against the strings that actually broke it proves it works.

// Rule 1 — kana.
//
// 957 anilist-chinese titles carrying Han characters are the Japanese
// original passed through untranslated, plus another 350 that are pure
// kana.  Accepting one writes Japanese into a column a zh-Hant reader
// will be shown as Chinese.
func TestGateRejectsKana(t *testing.T) {
	g := testGate(t)

	kana := []string{
		"黒の断章",                  // hiragana の, plus Simplified-flagged 黒/断
		"夜が来る!",                 // hiragana が
		"耳をすませば",                // pure kana + Han, the CGroup join key for Whisper of the Heart
		"ハングリーハート WILD STRIKER", // katakana
		"干物妹！うまるちゃん",            // the Japanese side of a title whose zh_hk value is clean
	}
	for _, s := range kana {
		t.Run(s, func(t *testing.T) {
			if !hasKana(s) {
				t.Fatalf("hasKana(%q) = false, want true", s)
			}
			if reason, _ := g.check(s); reason != reasonKana {
				t.Fatalf("check(%q) = %q, want %q", s, reason, reasonKana)
			}
		})
	}

	// Kana is checked before anything else precisely because a kana
	// string is Japanese whether or not it also has Han characters.
	if reason, _ := g.check("黒の断章"); reason != reasonKana {
		t.Fatalf("a string that is both kana and Simplified must report kana, got %q", reason)
	}
}

func TestGateAcceptsChineseWithoutKana(t *testing.T) {
	g := testGate(t)

	for _, s := range []string{
		"星際牛仔",      // anilist id 1
		"進擊的巨人",     // anilist id 16498
		"星際牛仔：天國之門", // anilist id 5, full-width colon
		"夢幻街少女",     // cgroup zh_hk
	} {
		t.Run(s, func(t *testing.T) {
			if hasKana(s) {
				t.Fatalf("hasKana(%q) = true, want false", s)
			}
			if reason, _ := g.check(s); reason != reasonNone {
				t.Fatalf("check(%q) = %q, want accepted", s, reason)
			}
		})
	}
}

// Rule 2 — Latin-only.
//
// 1,833 of the 8,492 anilist-chinese titles contain no Han character at
// all.  `Akira` is a fine romanisation and a useless zh-Hant title.
func TestGateRejectsLatinOnly(t *testing.T) {
	g := testGate(t)

	for _, s := range []string{
		"Trigun",               // anilist id 6
		"One Piece",            // anilist id 21
		"Hunter x Hunter 2011", // anilist id 11061
		"MONSTER",              // anilist id 19
		".hack//SIGN",
		"ALL YOU NEED IS KILL", // cgroup zh_hk — even the overlay has these
	} {
		t.Run(s, func(t *testing.T) {
			if hasHan(s) {
				t.Fatalf("hasHan(%q) = true, want false", s)
			}
			if reason, _ := g.check(s); reason != reasonNoHan {
				t.Fatalf("check(%q) = %q, want %q", s, reason, reasonNoHan)
			}
		})
	}

	// A mixed string still has Han, so it is not "Latin-only".
	if !hasHan("槍神Trigun") {
		t.Fatal("hasHan(槍神Trigun) = false; a mixed title must count as Han")
	}
	if reason, _ := g.check("槍神Trigun"); reason != reasonNone {
		t.Fatalf("check(槍神Trigun) = %q, want accepted", reason)
	}
}

// Rule 3 — Simplified characters.
//
// The point of the rule is to keep "source='anilist' means a human wrote
// exactly this string" true.  A title carrying 学 or 戯 is either
// Simplified or Japanese shinjitai; either way it is not the Traditional
// name and must fall through.
func TestGateRejectsSimplified(t *testing.T) {
	g := testGate(t)

	cases := []struct {
		title string
		bad   string
	}{
		{"遊戯王 Duel Monsters", "戯"}, // anilist id 481 — shinjitai 戯 for 戲
		{"淫獣学園 La Blue Girl", "学"}, // anilist id 1272
		{"肉体転移", "体"},              // anilist id 1359 — see the shinjitai note below
		{"魔法少女猫", "猫"},             // anilist id 952
		{"新体操（真）", "体"},            // anilist id 1632
	}
	for _, tc := range cases {
		t.Run(tc.title, func(t *testing.T) {
			reason, bad := g.check(tc.title)
			if reason != reasonSimplified {
				t.Fatalf("check(%q) = %q, want %q", tc.title, reason, reasonSimplified)
			}
			if got := string(bad); got != tc.bad {
				t.Fatalf("check(%q) offending runes = %q, want %q", tc.title, got, tc.bad)
			}
		})
	}
}

// The Simplified rule is a Simplified rule, not a Japanese rule, and the
// difference is visible in 肉体転移: 体 is flagged because the Simplified
// and shinjitai forms coincide and STCharacters carries 体→體, but 転 is
// not, because it is shinjitai only and Simplified Chinese writes 转.
// The kana rule is what catches Japanese titles; this one catches them
// only by coincidence.  A kana-free Japanese title built entirely out of
// Japanese-only shinjitai would pass both — none is known in the current
// dataset, and the tier below (opencc) would not have done better anyway.
func TestGateDoesNotClaimToDetectJapanese(t *testing.T) {
	g := testGate(t)
	if _, ok := g.simplified['転']; ok {
		t.Error("転 is shinjitai-only; STCharacters has no entry for it, so it cannot be in the set")
	}
	if _, ok := g.simplified['体']; !ok {
		t.Error("体 is both shinjitai and Simplified; STCharacters carries 体→體, so it must be in the set")
	}
}

// The false-positive guard, and the reason the rule is not "convert each
// character and compare".
//
// STCharacters is one-to-many: 里 maps to [裏 里], 谷 to [谷 穀], 干 to
// [幹 乾 干].  Taking the first alternative and comparing would rewrite
// 里 to 裏 and reject every Traditional title containing it.  These are
// all real Hong Kong titles out of cgroup-hk.json and all of them must
// pass.
func TestGateAcceptsCharactersValidInBothScripts(t *testing.T) {
	g := testGate(t)

	for _, s := range []string{
		"心之谷",    // 谷 -> [谷 穀]
		"只想告訴你",  // 只 -> [只 隻 祇]
		"干物妹！小埋", // 干 -> [幹 乾 干]
		"玻璃面具",   // 面 -> [面 麪]
		"東島丹三郎想成為幪面超人",
	} {
		t.Run(s, func(t *testing.T) {
			if bad := g.simplifiedRunes(s); len(bad) > 0 {
				t.Fatalf("simplifiedRunes(%q) = %q, want none — these characters exist in Traditional too", s, string(bad))
			}
			if reason, _ := g.check(s); reason != reasonNone {
				t.Fatalf("check(%q) = %q, want accepted", s, reason)
			}
		})
	}
}

// The set is derived from the conversion table, not hand-written, which
// is the property that makes it track the vendored OpenCC release.  These
// two assertions pin the derivation rule itself.
func TestSimplifiedSetIsDerivedFromTheTable(t *testing.T) {
	g := testGate(t)

	// A rune with no Traditional reading of itself is in the set.
	for _, r := range []rune{'学', '国', '断', '发'} {
		if _, ok := g.simplified[r]; !ok {
			t.Errorf("%q should be in the Simplified set", string(r))
		}
	}
	// A rune that is among its own alternatives is not.
	for _, r := range []rune{'里', '后', '干', '面', '松', '几', '只', '谷', '丰'} {
		if _, ok := g.simplified[r]; ok {
			t.Errorf("%q must NOT be in the Simplified set — it is valid Traditional", string(r))
		}
	}
	// Sanity: the derivation found roughly the whole character table
	// rather than a handful of entries.
	if len(g.simplified) < 3000 {
		t.Errorf("Simplified set has %d runes, expected the bulk of STCharacters", len(g.simplified))
	}
}

func TestGateRejectsEmpty(t *testing.T) {
	if reason, _ := testGate(t).check(""); reason != reasonEmpty {
		t.Fatalf("check(\"\") = %q, want %q", reason, reasonEmpty)
	}
}

// simplifiedRunes reports each offender once, in first-appearance order,
// because the report shows them to a human deciding what to fix.
func TestSimplifiedRunesAreDedupedAndOrdered(t *testing.T) {
	got := string(testGate(t).simplifiedRunes("学国学断国"))
	if got != "学国断" {
		t.Fatalf("simplifiedRunes = %q, want %q", got, "学国断")
	}
}
