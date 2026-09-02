package dandanplay

// episode_title_text_test.go — NormalizeDandanEpisodeTitle.
//
// The first block of cases is verbatim feed data, kept as such: the shape of
// `episodeTitle` is not documented anywhere by dandanplay, it was measured,
// and a table of invented strings would only test the assumptions rather than
// the input.  The blocks after it are the edges those values imply — the two
// other ordinal characters, full-width digits, an absent separator, an absent
// prefix — plus the classification boundaries the doc comment claims to hold.
//
// Every case also asserts the invariant that at most one column comes back
// non-empty.  A row with a name in both columns would render the same title
// twice under two different labels, and nothing downstream checks for it.

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestNormalizeDandanEpisodeTitle(t *testing.T) {
	tests := []struct {
		name       string
		raw        string
		wantNameCn string
		wantName   string
	}{
		// ---- values observed on the live feed ----
		{"feed: chinese body", "第1话 燃烧吧，狂犬", "燃烧吧，狂犬", ""},
		{"feed: katakana body", "第2话 サムライ・ジュニア", "", "サムライ・ジュニア"},
		{"feed: japanese body carrying han", "第3话 宇宙は数学という言語で書かれている", "", "宇宙は数学という言語で書かれている"},
		{"feed: chinese body with an html entity", "第1话 慢郎中跟急惊风 &amp; 大雄的新娘", "慢郎中跟急惊风 & 大雄的新娘", ""},
		{"feed: latin body", "第2话 FIRE", "", "FIRE"},
		{"feed: chinese body opening with a kanji numeral", "第16话 第十六次星月相交之日", "第十六次星月相交之日", ""},

		// ---- prefix variants ----
		{"full-width digit prefix", "第１话 燃烧吧，狂犬", "燃烧吧，狂犬", ""},
		{"traditional 話 prefix", "第10話 タイトル", "", "タイトル"},
		{"集 prefix", "第10集 标题", "标题", ""},
		{"prefix with no trailing space", "第4话标题", "标题", ""},
		{"prefix followed by an ideographic space", "第9话　标题", "标题", ""},
		{"surrounding whitespace is trimmed", "  第5话 标题  ", "标题", ""},

		// ---- nothing to store ----
		{"prefix only", "第10话", "", ""},
		{"full-width prefix only, trailing space", "第１０话  ", "", ""},
		{"empty string", "", "", ""},
		{"whitespace only", "   ", "", ""},

		// ---- no prefix at all ----
		{"no prefix, latin", "FUTURE ENGINE", "", "FUTURE ENGINE"},
		{"no prefix, chinese", "燃烧吧，狂犬", "燃烧吧，狂犬", ""},

		// ---- classification boundaries ----
		// Han is present here too; kana is what decides, and it decides
		// against nameCn.  This is the case a "has Han" test would misfile.
		{"mixed han and kana lands in name", "第8话 魔法少女まどか", "", "魔法少女まどか"},
		{"kana only lands in name", "第7话 ひとり", "", "ひとり"},
		// Halfwidth katakana is script=Katakana but sits outside U+3040–U+30FF,
		// so a literal range test would call this Chinese-eligible.  It has no
		// Han, so it would still land in name — the case is here to pin the
		// signal, not just the outcome.
		{"halfwidth katakana counts as kana", "第6话 ｻﾑﾗｲ", "", "ｻﾑﾗｲ"},
		// ・ (U+30FB) is script=Common despite living in the katakana block.
		// A literal range test would read this Chinese title as Japanese.
		{"middle dot does not make a chinese title japanese", "第5话 少年・少女", "少年・少女", ""},
		// Unescaping has to precede classification: read raw, "&#12354;宇宙"
		// has Han and no kana and would be filed as Chinese; decoded, its
		// leading rune is あ.
		{"numeric entity decoding to kana is classified after unescaping", "第1话 &#12354;宇宙", "", "あ宇宙"},
		// No Han, no kana, still non-empty — the rule sends anything that is
		// not demonstrably Chinese to the original-language column.
		{"punctuation-only body lands in name", "第9话 ？！", "", "？！"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			gotNameCn, gotName := NormalizeDandanEpisodeTitle(tc.raw)
			assert.Equal(t, tc.wantNameCn, gotNameCn, "nameCn for %q", tc.raw)
			assert.Equal(t, tc.wantName, gotName, "name for %q", tc.raw)
			assert.False(t, gotNameCn != "" && gotName != "",
				"both columns filled for %q — a title belongs to exactly one language column", tc.raw)
		})
	}
}
