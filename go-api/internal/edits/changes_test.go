package edits

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/overlay"
	"github.com/lawrenceli0228/animego/go-api/internal/people"
)

func sp(s string) *string { return &s }
func ip(n int32) *int32   { return &n }
func lp(n int64) *int64   { return &n }

// decodeChanges reads a "changes" object the way the handler does.
func decodeChanges(t *testing.T, raw string) changeSet {
	t.Helper()
	var ch changeSet
	dec := json.NewDecoder(strings.NewReader(raw))
	dec.DisallowUnknownFields()
	require.NoError(t, dec.Decode(&ch), raw)
	return ch
}

func stark() *people.Character {
	frieren := people.Work{AnilistID: 154587, TitleChinese: sp("葬送的芙莉莲"), Popularity: ip(480000)}
	sequel := people.Work{AnilistID: 182255, TitleChinese: sp("葬送的芙莉莲 第二季"), Popularity: ip(150000)}
	return &people.Character{
		AnilistID:        184313,
		Name:             people.Name{Full: sp("Stark"), Native: sp("シュタルク"), Cn: sp("修塔尔克")},
		AlternativeNames: []string{"休塔尔克"},
		Image:            sp("https://s4.anilist.co/file/anilistcdn/character/large/b184313.jpg"),
		Profile:          &people.CharacterProfile{Gender: sp("Male"), Description: sp("A warrior.\nAnd more.")},
		Voices: []people.CharacterVoice{
			{Key: "133507|Japanese|", Person: people.PersonRef{AnilistID: 133507, Name: people.Name{Cn: sp("小林千晃")}}, Language: sp("Japanese")},
			{Key: "115100|Japanese|Childhood", Person: people.PersonRef{AnilistID: 115100}, Language: sp("Japanese"), RoleNotes: sp("Childhood")},
		},
		Appearances: []people.Appearance{{Anime: frieren, Role: sp("MAIN")}, {Anime: sequel, Role: sp("MAIN")}},
	}
}

func fields(items []item) []string {
	out := []string{}
	for _, it := range items {
		f := it.Field
		if it.Key != "" {
			f += ":" + it.Key
		}
		out = append(out, f)
	}
	return out
}

func TestDiffCharacter_OnlyWhatChanges(t *testing.T) {
	t.Parallel()
	ch := decodeChanges(t, `{
		"nameCn": " 修塔尔克 ",
		"nameNative": "シュタルク",
		"nameFull": "Stark (warrior)",
		"aliases": ["休塔尔克"],
		"gender": "Male",
		"age": "18",
		"bloodType": null,
		"description": "A warrior.\r\nAnd more.",
		"roles": [{"animeId": 154587, "role": "MAIN"}, {"animeId": 182255, "role": "SUPPORTING"}]
	}`)
	items, err := diffCharacter(stark(), ch, nil)
	require.NoError(t, err)
	assert.Equal(t, []string{"nameFull", "age", "role:182255"}, fields(items),
		"a value equal to the page's is no change: spaces, CRLF, an already-empty fact")

	assert.JSONEq(t, `"Stark"`, string(items[0].Old))
	assert.JSONEq(t, `"Stark (warrior)"`, string(items[0].New))
	assert.JSONEq(t, `null`, string(items[1].Old))
	assert.JSONEq(t, `"18"`, string(items[1].New))
	assert.JSONEq(t, `"MAIN"`, string(items[2].Old))
	assert.JSONEq(t, `"SUPPORTING"`, string(items[2].New))
	assert.Contains(t, string(items[2].Meta), `"titleChinese":"葬送的芙莉莲 第二季"`, "the review shows which title")
}

func TestDiffCharacter_NothingChanged(t *testing.T) {
	t.Parallel()
	items, err := diffCharacter(stark(), decodeChanges(t, `{"nameCn":"修塔尔克","aliases":[" 休塔尔克 ",""]}`), nil)
	require.NoError(t, err)
	assert.Empty(t, items)
}

func TestDiffCharacter_ClearingAndLists(t *testing.T) {
	t.Parallel()
	items, err := diffCharacter(stark(), decodeChanges(t, `{"gender":null,"description":"   ","aliases":[]}`), nil)
	require.NoError(t, err)
	assert.Equal(t, []string{"aliases", "gender", "description"}, fields(items))
	assert.JSONEq(t, `[]`, string(items[0].New))
	assert.JSONEq(t, `null`, string(items[1].New))
	assert.JSONEq(t, `null`, string(items[2].New), "a blank description clears it")
}

func TestDiffCharacter_Refusals(t *testing.T) {
	t.Parallel()
	long := strings.Repeat("长", maxNameLen+1)
	for name, raw := range map[string]string{
		"a name cleared":          `{"nameCn":null}`,
		"a blank name":            `{"nameCn":"  "}`,
		"a long name":             `{"nameCn":"` + long + `"}`,
		"a control character":     `{"nameFull":"Sta\u0007rk"}`,
		"too many aliases":        `{"aliases":[` + aliasList(maxAliases+1) + `]}`,
		"a person's field":        `{"occupations":["Singer"]}`,
		"another person's field":  `{"homeTown":"Tokyo"}`,
		"a long description":      `{"description":"` + strings.Repeat("x", maxDescriptionLen+1) + `"}`,
		"a day without its month": `{"birth":{"year":null,"month":null,"day":3}}`,
		"30 February":             `{"birth":{"year":null,"month":2,"day":30}}`,
		"29 February 2023":        `{"birth":{"year":2023,"month":2,"day":29}}`,
		"month 13":                `{"birth":{"year":null,"month":13,"day":null}}`,
		"an unknown role":         `{"roles":[{"animeId":154587,"role":"VILLAIN"}]}`,
		"a title it is not on":    `{"roles":[{"animeId":1,"role":"MAIN"}]}`,
		"a title twice":           `{"roles":[{"animeId":154587,"role":"BACKGROUND"},{"animeId":154587,"role":"SUPPORTING"}]}`,
		"an unknown voice row":    `{"voices":[{"key":"1|Japanese|","remove":true}]}`,
		"an unknown person":       `{"voices":[{"key":"133507|Japanese|","personId":42}]}`,
		"adding nobody":           `{"voices":[{"line":"中配"}]}`,
		"removing an added row":   `{"voices":[{"remove":true,"personId":99}]}`,
		"a long line":             `{"voices":[{"key":"133507|Japanese|","line":"` + strings.Repeat("x", maxLineLen+1) + `"}]}`,
	} {
		_, err := diffCharacter(stark(), decodeChanges(t, raw), map[int32]people.PersonRef{99: {AnilistID: 99}})
		var ce *changeError
		assert.ErrorAs(t, err, &ce, name)
	}
}

func aliasList(n int) string {
	parts := make([]string, n)
	for i := range parts {
		parts[i] = `"alias` + strings.Repeat("x", i) + `"`
	}
	return strings.Join(parts, ",")
}

func TestDiffCharacter_Birthdays(t *testing.T) {
	t.Parallel()
	items, err := diffCharacter(stark(), decodeChanges(t, `{"birth":{"year":null,"month":2,"day":29}}`), nil)
	require.NoError(t, err, "29 February with no year")
	require.Len(t, items, 1)
	assert.JSONEq(t, `{"year":null,"month":2,"day":29}`, string(items[0].New))

	items, err = diffCharacter(stark(), decodeChanges(t, `{"birth":{"year":null,"month":null,"day":null}}`), nil)
	require.NoError(t, err)
	assert.Empty(t, items, "an empty date is no date, which is what the page has")
}

func TestDiffCharacter_Voices(t *testing.T) {
	t.Parallel()
	refs := map[int32]people.PersonRef{
		777: {AnilistID: 777, Name: people.Name{Full: sp("Replacement")}},
		888: {AnilistID: 888, Name: people.Name{Cn: sp("中文声优")}},
	}
	items, err := diffCharacter(stark(), decodeChanges(t, `{"voices":[
		{"key":"133507|Japanese|","line":"日配 · 主役"},
		{"key":"115100|Japanese|Childhood","personId":777},
		{"personId":888,"line":"中配"}
	]}`), refs)
	require.NoError(t, err)
	assert.Equal(t, []string{"voice:133507|Japanese|", "voice:115100|Japanese|Childhood", "voice:add:888"}, fields(items))

	var next voiceValue
	require.NoError(t, json.Unmarshal(items[1].New, &next))
	assert.Equal(t, int32(777), next.PersonID)
	assert.Equal(t, "Replacement", *next.Name.Full)
	assert.Equal(t, "Childhood", *next.RoleNotes, "the row keeps its notes")
	assert.JSONEq(t, `null`, string(items[2].Old), "an added row had no value")

	// The value the review merges is what the overlay reads.
	doc, err := overlay.Doc{}.With(items[1].Field, items[1].Key, items[1].New)
	require.NoError(t, err)
	op, _ := doc.VoiceOp("115100|Japanese|Childhood")
	assert.Equal(t, int32(777), op.PersonID)

	items, err = diffCharacter(stark(), decodeChanges(t, `{"voices":[
		{"key":"115100|Japanese|Childhood","remove":true},
		{"key":"133507|Japanese|","personId":133507,"line":null}
	]}`), refs)
	require.NoError(t, err)
	assert.Equal(t, []string{"voice:115100|Japanese|Childhood"}, fields(items), "same person, no line: no change")
	assert.JSONEq(t, `null`, string(items[0].New), "removed")
}

func TestDiffPerson(t *testing.T) {
	t.Parallel()
	p := &people.Person{
		AnilistID: 133507,
		Name:      people.Name{Full: sp("Chiaki Kobayashi"), Native: sp("小林千晃"), Cn: sp("小林千晃")},
		Profile:   &people.PersonProfile{Occupations: []string{"Voice Actor"}, HomeTown: sp("Kanagawa, Japan"), Birth: &people.FuzzyDate{Year: ip(1994), Month: ip(6), Day: ip(4)}},
	}
	items, err := diffPerson(p, decodeChanges(t, `{
		"occupations":["Voice Actor","Singer","Voice Actor"],
		"homeTown":"神奈川县",
		"birth":{"year":1994,"month":6,"day":4}
	}`))
	require.NoError(t, err)
	assert.Equal(t, []string{"occupations", "homeTown"}, fields(items))
	assert.JSONEq(t, `["Voice Actor","Singer"]`, string(items[0].New))

	for _, raw := range []string{`{"aliases":["x"]}`, `{"description":"x"}`, `{"age":"3"}`, `{"roles":[{"animeId":1,"role":"MAIN"}]}`, `{"voices":[{"personId":1}]}`} {
		_, err := diffPerson(p, decodeChanges(t, raw))
		var ce *changeError
		assert.ErrorAs(t, err, &ce, raw)
	}

	items, err = diffPerson(&people.Person{AnilistID: 1, Name: people.Name{Full: sp("X")}}, decodeChanges(t, `{"gender":"Female"}`))
	require.NoError(t, err)
	assert.Equal(t, []string{"gender"}, fields(items), "a person without a profile can be given facts")
}

func TestCleanSourceAndNote(t *testing.T) {
	t.Parallel()
	for _, ok := range []string{"https://frieren-anime.jp/character/", "http://example.org/a?b=c"} {
		got, err := cleanSource(" " + ok + " ")
		assert.NoError(t, err, ok)
		assert.Equal(t, ok, got)
	}
	_, err := cleanSource("   ")
	assert.ErrorIs(t, err, errSourceRequired)
	for _, bad := range []string{"javascript:alert(1)", "frieren-anime.jp", "https://", "ftp://x.org", "https://u:p@x.org", "data:text/html,x"} {
		_, err := cleanSource(bad)
		assert.Error(t, err, bad)
	}
	_, err = cleanSource("https://x.org/" + strings.Repeat("a", maxSourceLen))
	assert.Error(t, err)

	note, err := cleanNote(sp("  "))
	assert.NoError(t, err)
	assert.Nil(t, note)
	note, err = cleanNote(sp("官网角色页\r\n第二段"))
	require.NoError(t, err)
	assert.Equal(t, "官网角色页\n第二段", *note)
	_, err = cleanNote(sp(strings.Repeat("长", maxNoteLen+1)))
	assert.Error(t, err)
}

func TestCheckImage(t *testing.T) {
	t.Parallel()
	assert.NoError(t, checkImage(nil))
	assert.NoError(t, checkImage(&imageChange{URL: "https://example.org/a.jpg"}))
	assert.NoError(t, checkImage(&imageChange{DataURL: "data:image/jpeg;base64,AAAA"}))
	assert.Error(t, checkImage(&imageChange{}))
	assert.Error(t, checkImage(&imageChange{URL: "https://example.org/a.jpg", DataURL: "data:image/jpeg;base64,AAAA"}))
	assert.Error(t, checkImage(&imageChange{URL: "https://example.org/" + strings.Repeat("a", maxImageURLLen)}))
}

func TestChangeSet_UnknownFieldsAreRefused(t *testing.T) {
	t.Parallel()
	var ch changeSet
	dec := json.NewDecoder(strings.NewReader(`{"nameCn":"x","score":10}`))
	dec.DisallowUnknownFields()
	assert.Error(t, dec.Decode(&ch))
}
