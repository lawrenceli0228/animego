package bgmnames

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// testArchive is a hand-built Archive: subject 100 is a title's real
// Bangumi subject, 900 an unrelated one, and 950 an unrelated one that
// happens to cast one of the same voice actors.
func testArchive() *Archive {
	return &Archive{
		Persons: map[int32]Entity{
			501: {Name: "和氣あず未", NameCn: "和气杏未"},
			502: {Name: "黒沢ともよ", NameCn: "黑泽朋世"},
			503: {Name: "市ノ瀬加那", NameCn: "市之濑加那"},
			504: {Name: "種﨑敦美", NameCn: "种崎敦美"},
			505: {Name: "田中敦子", NameCn: "田中敦子"}, // （声优） already stripped by the loader
			506: {Name: "田中敦子", NameCn: "田中敦子"}, // a namesake, cast elsewhere
			507: {Name: "斎藤圭一郎", NameCn: "斋藤圭一郎"},
			508: {Name: "名無しの人"},
			901: {Name: "ジョン・ドウ", NameCn: "约翰"},
		},
		Characters: map[int32]Entity{
			601: {Name: "ナツキ", NameCn: "夏树"},
			602: {Name: "エーデル", NameCn: "艾迪露"},
			603: {Name: "フェルン", NameCn: "菲伦"},
			604: {Name: "フリーレン", NameCn: "芙莉莲"},
			605: {Name: "フランメ", NameCn: "伏拉梅"},
			606: {Name: "フェルンの母", NameCn: "菲伦的母亲"},
			609: {Name: "ジョン", NameCn: "约翰"},
		},
		Casts: map[int32][]Cast{
			100: {{501, 601}, {502, 602}, {503, 603}, {503, 606}, {504, 604}, {505, 605}},
			900: {{901, 609}},
			950: {{901, 609}, {506, 609}},
		},
		Staff: map[int32][]int32{
			100: {507, 508},
		},
	}
}

// frierenInput is AniList's side of title 1 (bound to subject 100): six
// voices and a director, with the native names AniList stores.
func frierenInput() Input {
	return Input{
		Titles: []Title{{AnilistID: 1, BgmSubject: 100}},
		Voices: []Voice{
			{AnimeID: 1, CharacterID: 11, CharacterNative: "ナツキ", StaffID: 21, StaffNative: "和氣あず未"},
			{AnimeID: 1, CharacterID: 12, CharacterNative: "エーデル", StaffID: 22, StaffNative: "黒沢ともよ"},
			{AnimeID: 1, CharacterID: 13, CharacterNative: "フェルン", StaffID: 23, StaffNative: "市ノ瀬加那"},
			{AnimeID: 1, CharacterID: 14, CharacterNative: "フリーレン", StaffID: 24, StaffNative: "種﨑敦美"},
			{AnimeID: 1, CharacterID: 15, CharacterNative: "フランメ", StaffID: 25, StaffNative: "田中敦子"},
		},
		Staff: []Credit{
			{AnimeID: 1, StaffID: 31, StaffNative: "斎藤 圭一郎"},
		},
	}
}

func pairsByID(pairs []Pair) map[int32]Pair {
	out := make(map[int32]Pair, len(pairs))
	for _, p := range pairs {
		out[p.AnilistID] = p
	}
	return out
}

// TestMatch_PlanDocExamples — the plan's five voice actors, each matched
// inside the title by native name and given Bangumi's Chinese name, and
// the characters they voice matched through person-characters.
func TestMatch_PlanDocExamples(t *testing.T) {
	res := Match(frierenInput(), testArchive())

	people := pairsByID(res.People)
	for id, want := range map[int32]struct {
		bgm int32
		cn  string
	}{
		21: {501, "和气杏未"},
		22: {502, "黑泽朋世"},
		23: {503, "市之濑加那"},
		24: {504, "种崎敦美"},
		25: {505, "田中敦子"},
		31: {507, "斋藤圭一郎"},
	} {
		require.Contains(t, people, id)
		assert.Equal(t, want.bgm, people[id].BgmID, "AniList %d", id)
		assert.Equal(t, want.cn, people[id].NameCn, "AniList %d", id)
	}
	assert.Len(t, res.People, 6)

	chars := pairsByID(res.Characters)
	assert.Equal(t, int32(601), chars[11].BgmID)
	assert.Equal(t, "菲伦", chars[13].NameCn, "of the two characters 市ノ瀬加那 voices here, the one with Fern's name")
	assert.Equal(t, int32(603), chars[13].BgmID)
	assert.Equal(t, "芙莉莲", chars[14].NameCn)
	assert.Equal(t, "伏拉梅", chars[15].NameCn)
	assert.Len(t, res.Characters, 5)
	assert.Empty(t, res.Conflicts)

	assert.Equal(t, "種﨑敦美", people[24].AniListName)
	assert.Equal(t, "種﨑敦美", people[24].BgmName)
	assert.Equal(t, []int32{1}, people[24].Titles)
}

// TestMatch_VariantKanjiOnOneSide — 﨑 on AniList and 崎 on Bangumi (or the
// other way round) are the same name.
func TestMatch_VariantKanjiOnOneSide(t *testing.T) {
	a := testArchive()
	a.Persons[504] = Entity{Name: "種崎敦美", NameCn: "种崎敦美"}
	res := Match(frierenInput(), a)
	assert.Equal(t, "种崎敦美", pairsByID(res.People)[24].NameCn)
	assert.Equal(t, "芙莉莲", pairsByID(res.Characters)[14].NameCn)
}

// TestMatch_CharacterNeedsBothSignals — a character is matched only when
// its voice actor is (person-characters then names the characters that
// person voices in the subject) and its native name equals one of them.
// Either signal alone is not enough: a voice actor voices several
// characters in one subject, and the same character name recurs across
// unrelated works.
func TestMatch_CharacterNeedsBothSignals(t *testing.T) {
	in := frierenInput()
	in.Voices = append(in.Voices,
		// The voice matches, the character's name is none of hers here.
		Voice{AnimeID: 1, CharacterID: 16, CharacterNative: "シュタルク", StaffID: 23, StaffNative: "市ノ瀬加那"},
		// The character's name matches, the voice is not in the cast.
		Voice{AnimeID: 1, CharacterID: 17, CharacterNative: "フェルン", StaffID: 27, StaffNative: "誰でもない"},
	)
	res := Match(in, testArchive())

	chars := pairsByID(res.Characters)
	assert.NotContains(t, chars, int32(16))
	assert.NotContains(t, chars, int32(17))
	assert.Contains(t, pairsByID(res.People), int32(23), "the voice actor is still matched")
	assert.NotContains(t, pairsByID(res.People), int32(27))
}

// TestMatch_WrongBindingWritesNothing — a title bound to an unrelated
// subject meets a cast with none of its names: nothing matches.
func TestMatch_WrongBindingWritesNothing(t *testing.T) {
	in := frierenInput()
	in.Titles = []Title{{AnilistID: 1, BgmSubject: 900}}
	res := Match(in, testArchive())

	assert.Empty(t, res.People)
	assert.Empty(t, res.Characters)
	assert.Empty(t, res.Conflicts)
	assert.Equal(t, 0, res.Stats.TitlesMatched)
	assert.Equal(t, 6, res.Stats.PeopleConsidered)
	assert.Equal(t, 0, res.Stats.PeopleMatched)
}

// TestMatch_WrongBindingThatSharesAVoiceActor — an unrelated subject that
// happens to cast the same voice actor still matches that person (the
// same name in the same subject's cast is the same person), but none of
// her characters: their names differ.
func TestMatch_WrongBindingThatSharesAVoiceActor(t *testing.T) {
	in := frierenInput()
	in.Titles = []Title{{AnilistID: 1, BgmSubject: 950}}
	in.Voices = []Voice{{AnimeID: 1, CharacterID: 15, CharacterNative: "フランメ", StaffID: 25, StaffNative: "田中敦子"}}
	in.Staff = nil
	res := Match(in, testArchive())

	require.Len(t, res.People, 1)
	assert.Equal(t, int32(506), res.People[0].BgmID)
	assert.Empty(t, res.Characters)
}

// TestMatch_ConflictsWriteNeither — one AniList id that would map to two
// Bangumi ids, or one Bangumi id that two AniList ids would map to, is a
// conflict: neither pair is kept, and the conflict is reported.
func TestMatch_ConflictsWriteNeither(t *testing.T) {
	t.Run("one AniList id, two Bangumi ids, from two titles", func(t *testing.T) {
		a := testArchive()
		a.Casts[200] = []Cast{{506, 605}}
		in := frierenInput()
		in.Titles = append(in.Titles, Title{AnilistID: 2, BgmSubject: 200})
		in.Voices = append(in.Voices, Voice{AnimeID: 2, CharacterID: 15, CharacterNative: "フランメ", StaffID: 25, StaffNative: "田中敦子"})
		res := Match(in, a)

		assert.NotContains(t, pairsByID(res.People), int32(25))
		assert.NotContains(t, pairsByID(res.Characters), int32(15), "a character is matched only through an accepted voice")
		assert.Equal(t, []Conflict{{Kind: "people", AnilistIDs: []int32{25}, BgmIDs: []int32{505, 506}, Titles: []int32{1, 2}}}, res.Conflicts)
		assert.Equal(t, 1, res.Stats.PeopleConflicted)
		assert.Contains(t, pairsByID(res.People), int32(24), "the rest of the cast is unaffected")
	})
	t.Run("one Bangumi id, two AniList ids", func(t *testing.T) {
		in := frierenInput()
		in.Voices = append(in.Voices, Voice{AnimeID: 1, CharacterID: 18, CharacterNative: "ナツキ", StaffID: 29, StaffNative: "和氣 あず未"})
		res := Match(in, testArchive())

		assert.NotContains(t, pairsByID(res.People), int32(21))
		assert.NotContains(t, pairsByID(res.People), int32(29))
		assert.NotContains(t, pairsByID(res.Characters), int32(11))
		assert.NotContains(t, pairsByID(res.Characters), int32(18))
		assert.Equal(t, []Conflict{{Kind: "people", AnilistIDs: []int32{21, 29}, BgmIDs: []int32{501}, Titles: []int32{1}}}, res.Conflicts)
	})
	t.Run("two namesakes in one cast", func(t *testing.T) {
		a := testArchive()
		a.Casts[100] = append(a.Casts[100], Cast{506, 606})
		res := Match(frierenInput(), a)

		assert.NotContains(t, pairsByID(res.People), int32(25))
		assert.NotContains(t, pairsByID(res.Characters), int32(15), "the character of an ambiguous voice is not matched either")
		assert.Contains(t, res.Conflicts, Conflict{Kind: "people", AnilistIDs: []int32{25}, BgmIDs: []int32{505, 506}, Titles: []int32{1}})
	})
	t.Run("the staff route and the voice route disagree", func(t *testing.T) {
		in := frierenInput()
		in.Staff = append(in.Staff, Credit{AnimeID: 1, StaffID: 24, StaffNative: "斎藤圭一郎"})
		res := Match(in, testArchive())
		assert.NotContains(t, pairsByID(res.People), int32(24))
		assert.NotContains(t, pairsByID(res.People), int32(31), "507 is claimed twice")
	})
}

// TestMatch_TheSameMatchFromTwoTitlesIsOne — sequels share casts; the same
// pair found in two titles is one pair with both titles as evidence.
func TestMatch_TheSameMatchFromTwoTitlesIsOne(t *testing.T) {
	in := frierenInput()
	in.Titles = append(in.Titles, Title{AnilistID: 2, BgmSubject: 100})
	in.Voices = append(in.Voices, Voice{AnimeID: 2, CharacterID: 14, CharacterNative: "フリーレン", StaffID: 24, StaffNative: "種﨑敦美"})
	res := Match(in, testArchive())

	assert.Empty(t, res.Conflicts)
	assert.Equal(t, []int32{1, 2}, pairsByID(res.People)[24].Titles)
	assert.Equal(t, []int32{1, 2}, pairsByID(res.Characters)[14].Titles)
	assert.Equal(t, 2, res.Stats.TitlesMatched)
}

// TestMatch_StaffRoute — staff who voice nothing are matched by native name
// among the persons the subject credits; a match Bangumi gives no Chinese
// name for is kept as a mapping with an empty name.
func TestMatch_StaffRoute(t *testing.T) {
	in := frierenInput()
	in.Staff = append(in.Staff, Credit{AnimeID: 1, StaffID: 32, StaffNative: "名無しの人"})
	res := Match(in, testArchive())

	people := pairsByID(res.People)
	assert.Equal(t, "斋藤圭一郎", people[31].NameCn, "the space in AniList's native name is not part of the name")
	assert.Equal(t, int32(508), people[32].BgmID)
	assert.Equal(t, "", people[32].NameCn)
	assert.Equal(t, 2, res.Stats.ByStaff)
	assert.Equal(t, 5, res.Stats.ByVoice)
	assert.Equal(t, 6, res.Stats.PeopleNamed)
}

// TestMatch_SkipsWhatCannotBeCompared — a title whose subject is not in the
// dump, and names AniList does not state, match nothing and fail nothing.
func TestMatch_SkipsWhatCannotBeCompared(t *testing.T) {
	in := frierenInput()
	in.Titles = append(in.Titles, Title{AnilistID: 3, BgmSubject: 777})
	in.Voices = append(in.Voices,
		Voice{AnimeID: 3, CharacterID: 40, CharacterNative: "フリーレン", StaffID: 24, StaffNative: "種﨑敦美"},
		Voice{AnimeID: 1, CharacterID: 41, CharacterNative: "", StaffID: 41, StaffNative: ""},
	)
	res := Match(in, testArchive())

	assert.Equal(t, 2, res.Stats.Titles)
	assert.Equal(t, 1, res.Stats.TitlesNotInDump)
	assert.Equal(t, 1, res.Stats.TitlesMatched)
	assert.NotContains(t, pairsByID(res.People), int32(41))
	assert.Equal(t, []int32{1}, pairsByID(res.People)[24].Titles)
}

// TestMatch_Stats — the counts the dry run prints add up.
func TestMatch_Stats(t *testing.T) {
	res := Match(frierenInput(), testArchive())
	assert.Equal(t, Stats{
		Titles: 1, TitlesMatched: 1,
		PeopleConsidered: 6, PeopleMatched: 6, PeopleNamed: 6, ByVoice: 5, ByStaff: 1,
		CharactersConsidered: 5, CharactersMatched: 5, CharactersNamed: 5,
	}, res.Stats)
}
