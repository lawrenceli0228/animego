package bgmnames

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"golang.org/x/text/unicode/norm"
)

// TestNormalize — the comparison form: NFKC, no spaces of any width, no
// middle dots, the variant kanji folded, Latin letters in one case.
func TestNormalize(t *testing.T) {
	for in, want := range map[string]string{
		"種﨑敦美":     "種崎敦美",
		"種崎敦美":     "種崎敦美",
		"髙橋李依":     "高橋李依",
		"𠮷田有里":     "吉田有里",
		"市ノ瀬 加那":   "市ノ瀬加那",
		"市ノ瀬　加那":   "市ノ瀬加那",
		"ナツキ・スバル":  "ナツキスバル",
		"ﾅﾂｷ･ｽﾊﾞﾙ": "ナツキスバル",
		"Jean·Luc": "jeanluc",
		"ＬｉＳＡ":     "lisa",
		"\t":       "",
		"":         "",
	} {
		assert.Equal(t, want, Normalize(in), "%q", in)
	}
}

// TestNormalize_FoldsOnlyWhatItSays — the normaliser is not a translator:
// Japanese and Chinese forms of a kanji stay apart (黒 is not 黑), so do
// kana spellings (ノ is not の), and so does a disambiguating parenthesis.
// Any of these folded would match names that are not the same name.
func TestNormalize_FoldsOnlyWhatItSays(t *testing.T) {
	for _, pair := range [][2]string{
		{"黒沢ともよ", "黑泽朋世"},
		{"市ノ瀬加那", "市の瀬加那"},
		{"市ノ瀬加那", "市之濑加那"},
		{"エル", "エル（園田エル）"},
		{"渡辺", "渡邊"},
	} {
		assert.NotEqual(t, Normalize(pair[0]), Normalize(pair[1]), "%q vs %q", pair[0], pair[1])
	}
}

// TestVariantKanji_OnlyWhatNFKCLeaves — every entry in the variant table is
// a character NFKC does not already fold (or the entry would be dead), and
// the table stays short: it exists for the few registry variants that both
// AniList and Bangumi spell either way, not as a general kanji map.
func TestVariantKanji_OnlyWhatNFKCLeaves(t *testing.T) {
	assert.LessOrEqual(t, len(variantKanji), 6, "a short, explicit table")
	for variant, standard := range variantKanji {
		assert.Equal(t, variant, norm.NFKC.String(variant), "%q: NFKC leaves the variant alone", variant)
		assert.NotEqual(t, variant, standard)
	}
}

// TestChineseName_FromTheInfobox — the 简体中文名 field of a Bangumi wiki
// infobox, read line by line (the dump uses CRLF), with surrounding space
// trimmed.  It wins over a record's own name_cn.
func TestChineseName_FromTheInfobox(t *testing.T) {
	const fern = "{{Infobox Crt\r\n|简体中文名= 菲伦\r\n|别名={\r\n[第二中文名|]\r\n[英文名|Fern]\r\n}\r\n|性别= 女\r\n}}"
	assert.Equal(t, "菲伦", ChineseName(fern, ""))
	assert.Equal(t, "菲伦", ChineseName(fern, "别的名字"), "the infobox wins")
	assert.Equal(t, "芙莉莲", ChineseName("{{Infobox Crt\n| 简体中文名 =  芙莉莲  \n}}", ""), "spaces around key and value")
	assert.Equal(t, "第一", ChineseName("{{Infobox\n|简体中文名= 第一\n|简体中文名= 第二\n}}", ""), "the first field wins")
}

// TestChineseName_AnEmptyFieldIsEmpty — an empty 简体中文名 is no name: the
// next line (|别名={) must not be read as its value, and the record's own
// name_cn, when there is one, is used instead.
func TestChineseName_AnEmptyFieldIsEmpty(t *testing.T) {
	const empty = "{{Infobox Crt\r\n|简体中文名= \r\n|别名={\r\n[第二中文名|]\r\n}\r\n}}"
	assert.Equal(t, "", ChineseName(empty, ""))
	assert.Equal(t, "海塔", ChineseName(empty, " 海塔 "))
	assert.Equal(t, "海塔", ChineseName("", "海塔"), "no infobox at all")
	assert.Equal(t, "", ChineseName("{{Infobox\n|简体中文名={\n[a]\n}\n}}", ""), "a list is not a name")
	assert.Equal(t, "", ChineseName("{{Infobox\n|性别= 女\n}}", ""))
}

// TestChineseName_StripsATrailingDisambiguation — Bangumi tells homonyms
// apart with a trailing parenthesis (田中敦子（声优）, 田中敦子（动画人）) and
// gives characters an alias the same way (池田由纪（小雪）).  One trailing
// group is removed, full width or half width; a parenthesis anywhere else
// is part of the name, and a value that is nothing but a parenthesis is no
// name at all.
func TestChineseName_StripsATrailingDisambiguation(t *testing.T) {
	for in, want := range map[string]string{
		"田中敦子（声优）":   "田中敦子",
		"高桥伸也（声优）":   "高桥伸也",
		"渡边哲也（CG导演）": "渡边哲也",
		"EMI音乐 (日本)": "EMI音乐",
		"斯卡(刀疤)":     "斯卡",
		"池田由纪（小雪）":   "池田由纪",
		"甲（乙）（丙）":    "甲（乙）",
		"甲（乙）丙":      "甲（乙）丙",
		"（未知）":       "",
		"种崎敦美":       "种崎敦美",
	} {
		assert.Equal(t, want, ChineseName("{{Infobox\n|简体中文名= "+in+"\n}}", ""), "%q", in)
		assert.Equal(t, want, ChineseName("", in), "%q from name_cn", in)
	}
}

// TestChineseName_NeverConverts — what Bangumi wrote is what is stored:
// no traditional-to-simplified mapping and no kana-to-kanji guessing, even
// where the field holds a traditional or a kana name.
func TestChineseName_NeverConverts(t *testing.T) {
	assert.Equal(t, "種﨑敦美", ChineseName("{{Infobox\n|简体中文名= 種﨑敦美\n}}", ""))
	assert.Equal(t, "チョー", ChineseName("{{Infobox\n|简体中文名= チョー\n}}", ""))
	assert.Equal(t, "東地宏樹", ChineseName("{{Infobox\n|简体中文名= 東地宏樹\n}}", ""))
}
