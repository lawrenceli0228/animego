package anime

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// The pure half of the 角色 / 制作 tabs: turning a title's credit rows into
// what the endpoints answer.  Everything here runs without a database; the
// handler tests and the _PG test cover the wiring around it.

// castChar builds one anime_characters row as ListAnimeCastCharacters
// returns it.  id 0 is a row with no AniList id (written before 0037).
func castChar(id int32, role, en, ja string) dbgen.ListAnimeCastCharactersRow {
	row := dbgen.ListAnimeCastCharactersRow{NameEn: sptr(en), NameJa: sptr(ja)}
	if id != 0 {
		row.CharacterID = i32(id)
	}
	if role != "" {
		row.Role = sptr(role)
	}
	return row
}

// castVoiceRow builds one anime_character_voices row.
func castVoiceRow(character, staff int32, language, notes, full, native string) dbgen.ListAnimeCastVoicesRow {
	row := dbgen.ListAnimeCastVoicesRow{
		CharacterID: character,
		StaffID:     staff,
		NameFull:    sptr(full),
		NameNative:  sptr(native),
	}
	if language != "" {
		row.Language = sptr(language)
	}
	if notes != "" {
		row.RoleNotes = sptr(notes)
	}
	return row
}

func voiceIDs(vs []castVoice) []int32 {
	out := make([]int32, 0, len(vs))
	for _, v := range vs {
		if v.StaffID != nil {
			out = append(out, *v.StaffID)
		}
	}
	return out
}

func pageIDs(p castPage) []int32 {
	out := make([]int32, 0, len(p.Data))
	for _, c := range p.Data {
		if c.CharacterID != nil {
			out = append(out, *c.CharacterID)
		}
	}
	return out
}

func TestBuildCastList_SortsEachCharactersVoicesByLanguage(t *testing.T) {
	t.Parallel()

	chars := []dbgen.ListAnimeCastCharactersRow{castChar(1, "MAIN", "Frieren", "フリーレン")}
	voices := []dbgen.ListAnimeCastVoicesRow{
		castVoiceRow(1, 11, "Japanese", "", "Atsumi Tanezaki", "種﨑敦美"),
		castVoiceRow(1, 12, "japanese", "Childhood", "Child Voice", "子役"),
		castVoiceRow(1, 13, "Chinese", "", "Zh Voice", "中配"),
		castVoiceRow(1, 14, "Korean", "", "Ko Voice", "한국"),
		// The store keeps one voice outside the three languages only as a
		// character's primary of last resort; the tabs have no switch for it.
		castVoiceRow(1, 15, "English", "", "En Voice", "En Voice"),
		castVoiceRow(1, 16, "", "", "No Language", "No Language"),
	}

	list := buildCastList(nil, chars, voices)
	require.Len(t, list.entries, 1)
	got := list.entries[0].voices
	assert.Equal(t, []int32{11, 12}, voiceIDs(got[castLangJa]), "stored order within a language")
	assert.Equal(t, []int32{13}, voiceIDs(got[castLangZh]))
	assert.Equal(t, []int32{14}, voiceIDs(got[castLangKo]))
	assert.Len(t, got, 3, "no bucket for English or for a voice with no language")
	assert.Equal(t, "Childhood", *got[castLangJa][1].RoleNotes)
}

func TestBuildCastList_TheRowsOwnVoiceStandsInOnlyWhenTheTableHasNone(t *testing.T) {
	t.Parallel()

	legacy := castChar(0, "MAIN", "Old Row", "古い行") // written before 0037: no id
	legacy.VoiceActorID = i32(21)
	legacy.VoiceActorEn = sptr("Old Voice")
	legacy.VoiceActorJa = sptr("古い声")
	legacy.VoiceActorCn = sptr("旧声优")

	beforeVoices := castChar(2, "SUPPORTING", "Pre 0042", "前") // an id, but no voice rows yet
	beforeVoices.VoiceActorEn = sptr("Row Voice")

	both := castChar(3, "SUPPORTING", "Has Rows", "行あり")
	both.VoiceActorID = i32(31)
	both.VoiceActorEn = sptr("Row Copy")

	silent := castChar(4, "BACKGROUND", "Silent", "無言")

	voices := []dbgen.ListAnimeCastVoicesRow{castVoiceRow(3, 31, "Japanese", "", "Table Voice", "表の声")}

	list := buildCastList(nil, []dbgen.ListAnimeCastCharactersRow{legacy, beforeVoices, both, silent}, voices)
	require.Len(t, list.entries, 4)

	// The deployed code before 0042 stored voiceActors(language: JAPANESE)[0]
	// in these columns, so that is the language the stand-in is filed under.
	old := list.entries[0].voices[castLangJa]
	require.Len(t, old, 1)
	assert.Equal(t, int32(21), *old[0].StaffID)
	assert.Equal(t, "Old Voice", *old[0].NameFull)
	assert.Equal(t, "古い声", *old[0].NameNative)
	assert.Equal(t, "旧声优", *old[0].NameCn)

	pre := list.entries[1].voices[castLangJa]
	require.Len(t, pre, 1)
	assert.Nil(t, pre[0].StaffID, "no id on the row, none invented")
	assert.Equal(t, "Row Voice", *pre[0].NameFull)

	// A character the table has voices for is described by the table alone.
	assert.Equal(t, []int32{31}, voiceIDs(list.entries[2].voices[castLangJa]))
	assert.Equal(t, "Table Voice", *list.entries[2].voices[castLangJa][0].NameFull)

	assert.Empty(t, list.entries[3].voices, "no voice anywhere is no voice")
}

func TestBuildCastList_ThePrimaryVoiceKeepsTheRowsChineseName(t *testing.T) {
	t.Parallel()

	// GetAnimeCharactersByID answers COALESCE(Bangumi's name, the row's
	// voice_actor_cn) for the primary voice; the tab says the same thing.
	row := castChar(1, "MAIN", "A", "あ")
	row.VoiceActorID = i32(11)
	row.VoiceActorCn = sptr("行里的名字")
	matched := castVoiceRow(1, 12, "Japanese", "Childhood", "B", "び")
	matched.NameCn = sptr("班固米的名字")

	list := buildCastList(nil, []dbgen.ListAnimeCastCharactersRow{row}, []dbgen.ListAnimeCastVoicesRow{
		castVoiceRow(1, 11, "Japanese", "", "A Voice", "あの声"),
		matched,
	})
	ja := list.entries[0].voices[castLangJa]
	require.Len(t, ja, 2)
	assert.Equal(t, "行里的名字", *ja[0].NameCn, "the row's name for the person the row names")
	assert.Equal(t, "班固米的名字", *ja[1].NameCn, "a match is never overwritten")

	other := castChar(2, "MAIN", "C", "し")
	other.VoiceActorID = i32(99) // a different person from the voice below
	other.VoiceActorCn = sptr("别人")
	list = buildCastList(nil, []dbgen.ListAnimeCastCharactersRow{other}, []dbgen.ListAnimeCastVoicesRow{
		castVoiceRow(2, 21, "Japanese", "", "C Voice", "しの声"),
	})
	assert.Nil(t, list.entries[0].voices[castLangJa][0].NameCn, "another person's name is not borrowed")
}

func TestBuildCastList_RoleIsReadCaseInsensitively(t *testing.T) {
	t.Parallel()

	list := buildCastList(nil, []dbgen.ListAnimeCastCharactersRow{
		castChar(1, "main", "A", "あ"),
		castChar(2, "", "B", "い"),
	}, nil)
	assert.Equal(t, "MAIN", list.entries[0].role)
	assert.Equal(t, "", list.entries[1].role)
	assert.Equal(t, "main", *list.entries[0].character.Role, "the wire keeps what the row says")
}

// fixtureCast is a small title: three main characters, two supporting, one
// background and one row with no role, voiced in Japanese, a little in
// Chinese and not at all in Korean.
func fixtureCast(country *string) *castList {
	chars := []dbgen.ListAnimeCastCharactersRow{
		castChar(1, "MAIN", "Frieren", "フリーレン"),
		castChar(2, "MAIN", "Fern", "フェルン"),
		castChar(3, "MAIN", "Stark", "シュタルク"),
		castChar(4, "SUPPORTING", "Himmel", "ヒンメル"),
		castChar(5, "SUPPORTING", "Heiter", "ハイター"),
		castChar(6, "BACKGROUND", "Villager", "村人"),
		castChar(7, "", "Unknown", "不明"),
	}
	chars[0].NameCn = sptr("芙莉莲")
	voices := []dbgen.ListAnimeCastVoicesRow{
		castVoiceRow(1, 11, "Japanese", "", "Atsumi Tanezaki", "種崎敦美"),
		castVoiceRow(1, 12, "Chinese", "", "Zhong Pei", "中配一"),
		castVoiceRow(2, 21, "Japanese", "", "Kana Ichinose", "市ノ瀬加那"),
		castVoiceRow(3, 31, "Japanese", "", "Chiaki Kobayashi", "小林千晃"),
		castVoiceRow(4, 41, "Japanese", "", "Nobuhiko Okamoto", "岡本信彦"),
		castVoiceRow(4, 42, "Japanese", "Young", "Young Himmel", "若いヒンメル"),
		castVoiceRow(5, 51, "Chinese", "", "Zhong Pei Er", "中配二"),
	}
	return buildCastList(country, chars, voices)
}

func TestCastPage_RoleFilterAndRoleCounts(t *testing.T) {
	t.Parallel()

	list := fixtureCast(nil)
	all := list.page(castQuery{limit: 50})
	assert.Equal(t, []int32{1, 2, 3, 4, 5, 6, 7}, pageIDs(all), "AniList's order, untouched")
	assert.Equal(t, 7, all.Total)
	assert.Equal(t, castRoleCounts{All: 7, Main: 3, Supporting: 2, Background: 1}, all.Counts.Roles,
		"a row with no role is in 全部 and in no role of its own")

	main := list.page(castQuery{role: "MAIN", limit: 50})
	assert.Equal(t, []int32{1, 2, 3}, pageIDs(main))
	assert.Equal(t, 3, main.Total)
	assert.Equal(t, all.Counts, main.Counts, "the role chips count every role whichever is chosen")

	bg := list.page(castQuery{role: "BACKGROUND", limit: 50})
	assert.Equal(t, []int32{6}, pageIDs(bg))
}

func TestCastPage_VoicesAreTheSelectedLanguagesAndNeverNull(t *testing.T) {
	t.Parallel()

	list := fixtureCast(nil)
	ja := list.page(castQuery{lang: castLangJa, limit: 50})
	assert.Equal(t, castLangJa, ja.Language)
	assert.Equal(t, []int32{41, 42}, voiceIDs(ja.Data[3].Voices), "Himmel's main voice, then his young one")
	assert.NotNil(t, ja.Data[5].Voices, "a character with no voice answers [], not null")
	assert.Empty(t, ja.Data[5].Voices)

	zh := list.page(castQuery{lang: castLangZh, limit: 50})
	assert.Equal(t, []int32{12}, voiceIDs(zh.Data[0].Voices))
	assert.Empty(t, zh.Data[1].Voices, "Fern has no Chinese voice: she is still listed")
	assert.Equal(t, 7, zh.Total, "the language switch changes the voices, not the characters")

	body, err := json.Marshal(zh.Data[1])
	require.NoError(t, err)
	assert.Contains(t, string(body), `"voices":[]`)
}

func TestCastPage_LanguageCountsAreTheTitlesInAFixedOrder(t *testing.T) {
	t.Parallel()

	list := fixtureCast(nil)
	got := list.page(castQuery{role: "BACKGROUND", needle: "nothing-matches", limit: 10})
	assert.Equal(t, []castLangCount{{Language: "ja", Count: 4}, {Language: "zh", Count: 2}}, got.Counts.Languages,
		"characters with a voice in each language, over the whole title; no Korean entry at all")
}

func TestCastPage_SearchReadsCharacterNamesAndTheSelectedLanguagesVoices(t *testing.T) {
	t.Parallel()

	list := fixtureCast(nil)
	cases := []struct {
		name string
		lang castLang
		q    string
		want []int32
	}{
		{"romaji, any case", castLangJa, "frieren", []int32{1}},
		{"native name", castLangJa, "フェルン", []int32{2}},
		{"Bangumi's Chinese name", castLangJa, "芙莉莲", []int32{1}},
		{"a voice's romaji, spaces ignored", castLangJa, "chiakikobayashi", []int32{3}},
		{"a voice's native name", castLangJa, "小林", []int32{3}},
		{"a second voice of the character", castLangJa, "若い", []int32{4}},
		{"a Chinese voice is not searched under 日配", castLangJa, "中配二", []int32{}},
		{"but is under 中配", castLangZh, "中配二", []int32{5}},
		{"a substring of several", castLangJa, "ン", []int32{1, 2, 4}},
		{"half-width katakana folds", castLangJa, "ﾌﾘｰﾚﾝ", []int32{1}},
		{"variant kanji folds", castLangJa, "種﨑", []int32{1}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := list.page(castQuery{lang: tc.lang, needle: normalizeCastNeedle(tc.q), limit: 50})
			assert.Equal(t, tc.want, pageIDs(got))
			assert.Equal(t, len(tc.want), got.Total)
		})
	}
}

func TestCastPage_RoleCountsFollowTheSearch(t *testing.T) {
	t.Parallel()

	list := fixtureCast(nil)
	got := list.page(castQuery{lang: castLangJa, needle: normalizeCastNeedle("ン"), limit: 50})
	// フリーレン and フェルン (main), ヒンメル (supporting).
	assert.Equal(t, castRoleCounts{All: 3, Main: 2, Supporting: 1}, got.Counts.Roles)
}

func TestCastPage_Pagination(t *testing.T) {
	t.Parallel()

	list := fixtureCast(nil)
	first := list.page(castQuery{limit: 3})
	assert.Equal(t, []int32{1, 2, 3}, pageIDs(first))
	assert.True(t, first.HasMore)
	assert.Equal(t, 0, first.Offset)
	assert.Equal(t, 3, first.Limit)

	last := list.page(castQuery{offset: 6, limit: 3})
	assert.Equal(t, []int32{7}, pageIDs(last))
	assert.False(t, last.HasMore)
	assert.Equal(t, 7, last.Total)

	past := list.page(castQuery{offset: 40, limit: 3})
	assert.NotNil(t, past.Data, "past the end is an empty page, not null")
	assert.Empty(t, past.Data)
	assert.False(t, past.HasMore)
	assert.Equal(t, 7, past.Total)
}

func TestCastPage_DefaultLanguage(t *testing.T) {
	t.Parallel()

	cn := sptr("CN")
	jp := sptr("JP")

	assert.Equal(t, castLangJa, fixtureCast(jp).page(castQuery{limit: 1}).Language, "a Japanese title: 日配")
	assert.Equal(t, castLangJa, fixtureCast(nil).page(castQuery{limit: 1}).Language, "no country reads as Japanese")
	assert.Equal(t, castLangZh, fixtureCast(cn).page(castQuery{limit: 1}).Language, "a donghua: 中配")

	// A donghua AniList only has a Japanese cast for: the language that exists.
	onlyJa := buildCastList(cn, []dbgen.ListAnimeCastCharactersRow{castChar(1, "MAIN", "A", "あ")},
		[]dbgen.ListAnimeCastVoicesRow{castVoiceRow(1, 11, "Japanese", "", "V", "ぶい")})
	assert.Equal(t, castLangJa, onlyJa.page(castQuery{limit: 1}).Language)

	// The most-voiced language wins when the title's own has none.
	kr := buildCastList(sptr("TW"), []dbgen.ListAnimeCastCharactersRow{
		castChar(1, "MAIN", "A", "あ"), castChar(2, "MAIN", "B", "い"),
	}, []dbgen.ListAnimeCastVoicesRow{
		castVoiceRow(1, 11, "Japanese", "", "V", "ぶい"),
		castVoiceRow(1, 12, "Korean", "", "K1", "케이1"),
		castVoiceRow(2, 21, "Korean", "", "K2", "케이2"),
	})
	assert.Equal(t, castLangKo, kr.page(castQuery{limit: 1}).Language)

	// Nothing voiced at all: the title's own language, with nothing to list.
	none := buildCastList(cn, []dbgen.ListAnimeCastCharactersRow{castChar(1, "MAIN", "A", "あ")}, nil)
	got := none.page(castQuery{limit: 1})
	assert.Equal(t, castLangZh, got.Language)
	assert.NotNil(t, got.Counts.Languages)
	assert.Empty(t, got.Counts.Languages)

	// A language asked for by name is the one answered, even an empty one.
	asked := fixtureCast(jp).page(castQuery{lang: castLangKo, limit: 50})
	assert.Equal(t, castLangKo, asked.Language)
	assert.Equal(t, 7, asked.Total)
	for _, c := range asked.Data {
		assert.Empty(t, c.Voices)
	}
}

func TestNormalizeCastNeedle(t *testing.T) {
	t.Parallel()

	assert.Equal(t, "atsumitanezaki", normalizeCastNeedle("  Atsumi  Tanezaki "))
	assert.Equal(t, "ナツキスバル", normalizeCastNeedle("ナツキ・スバル"))
	assert.Equal(t, "", normalizeCastNeedle(" ・ "), "nothing left to search for is no search")
	assert.Equal(t, "ab", normalizeCastNeedle("a\x00b"), "the separator the index joins names with cannot be typed")
}

func TestBuildStaffList_KeepsTheOrderAndCountsPeople(t *testing.T) {
	t.Parallel()

	rows := []dbgen.ListAnimeStaffCreditsRow{
		{StaffID: i32(1), Role: sptr("Director"), NameEn: sptr("Keiichirou Saitou"), NameJa: sptr("斎藤圭一郎")},
		{StaffID: i32(2), Role: sptr("Series Composition"), NameEn: sptr("Tomohiro Suzuki"), NameJa: sptr("鈴木智尋"), NameCn: sptr("铃木智寻")},
		{StaffID: i32(1), Role: sptr("Storyboard (eps 1, 2)"), NameEn: sptr("Keiichirou Saitou"), NameJa: sptr("斎藤圭一郎")},
		// Rows written before 0037 carry no id: one person per name.
		{Role: sptr("Key Animation"), NameEn: sptr("No Id"), NameJa: sptr("無番号")},
		{Role: sptr("In-Between Animation"), NameEn: sptr("No Id"), NameJa: sptr("無番号")},
		{Role: sptr("Key Animation"), NameEn: sptr("Other"), NameJa: sptr("別人")},
	}
	list := buildStaffList(rows)
	assert.Equal(t, 6, len(list.credits), "one entry per credit")
	assert.Equal(t, 4, list.people)
	assert.Equal(t, "Director", *list.credits[0].Role)
	assert.Equal(t, "铃木智寻", *list.credits[1].NameCn)
	assert.Equal(t, "Storyboard (eps 1, 2)", *list.credits[2].Role, "the role exactly as stored")

	assert.Equal(t, 0, buildStaffList(nil).people)
	assert.NotNil(t, buildStaffList(nil).credits)
}

func TestBuildCastList_TheStandInVoiceTakesTheTitlesLanguageOnceTheTitleHasVoiceRows(t *testing.T) {
	t.Parallel()

	// A donghua written since 0042: its character rows carry the Chinese
	// voice (credits.PrimaryLanguage), and a character the voice table has
	// nothing for -- one with no AniList id, or a refresh caught between
	// pruning and rewriting its voices -- is standing in a Chinese voice.
	noID := castChar(0, "SUPPORTING", "No Id", "无号")
	noID.VoiceActorEn = sptr("Zh Voice")
	noID.VoiceActorJa = sptr("中文声优")
	chars := []dbgen.ListAnimeCastCharactersRow{castChar(1, "MAIN", "Wei Ying", "魏婴"), noID}
	voices := []dbgen.ListAnimeCastVoicesRow{castVoiceRow(1, 11, "Chinese", "", "Ajie", "阿杰")}

	cn := buildCastList(sptr("CN"), chars, voices)
	assert.Equal(t, "中文声优", *cn.entries[1].voices[castLangZh][0].NameNative)
	assert.Empty(t, cn.entries[1].voices[castLangJa])

	// The same donghua before 0042, with nothing in the voice table: the
	// deployed code stored voiceActors(language: JAPANESE)[0] on the row.
	old := buildCastList(sptr("CN"), chars, nil)
	assert.Equal(t, "中文声优", *old.entries[1].voices[castLangJa][0].NameNative)
	assert.Empty(t, old.entries[1].voices[castLangZh])
}

func TestBuildCastList_SharedSlicesHaveNoSpareCapacity(t *testing.T) {
	t.Parallel()

	// The list is cached and every request hands its slices to the encoder;
	// an append on one of them must copy rather than write into the cache.
	list := fixtureCast(nil)
	for _, e := range list.entries {
		for _, vs := range e.voices {
			assert.Equal(t, len(vs), cap(vs))
		}
	}
	assert.Equal(t, len(list.langCounts), cap(list.langCounts))
	staff := buildStaffList([]dbgen.ListAnimeStaffCreditsRow{{StaffID: i32(1), Role: sptr("Director")}})
	assert.Equal(t, len(staff.credits), cap(staff.credits))
}
