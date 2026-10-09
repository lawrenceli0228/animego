package edits

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/overlay"
	"github.com/lawrenceli0228/animego/go-api/internal/people"
)

// Every item a diff makes holds, as its old value, what the page reads now
// for that field: the review's staleness check is the comparison of the two,
// so they must agree on an unchanged page -- every field, both kinds.
func TestPageValue_IsEachItemsOldValue(t *testing.T) {
	t.Parallel()
	c := stark()
	c.Profile.Birth = &people.FuzzyDate{Month: ip(4), Day: ip(1)}
	refs := map[int32]people.PersonRef{777: {AnilistID: 777}, 888: {AnilistID: 888}}
	items, err := diffCharacter(c, decodeChanges(t, `{
		"nameCn":"史塔克","nameNative":"シュタルク!","nameFull":"Stark!","aliases":["新别名"],
		"gender":"Female","age":"18","birth":{"year":null,"month":5,"day":2},"bloodType":"O",
		"description":"New.",
		"voices":[{"key":"133507|Japanese|","line":"日配"},{"key":"115100|Japanese|Childhood","remove":true},{"personId":888}],
		"roles":[{"animeId":182255,"role":"SUPPORTING"}]
	}`), refs)
	require.NoError(t, err)
	items = append(items, item{Field: overlay.FieldImage, Old: mustJSON(c.Image)})
	require.Len(t, items, 14)
	value := characterValue(c)
	for _, it := range items {
		cur, ok := value(it.Field, it.Key)
		require.True(t, ok, it.Field+":"+it.Key)
		assert.True(t, sameValue(it.Field, it.Old, cur), "%s:%s: %s vs %s", it.Field, it.Key, it.Old, cur)
	}

	p := &people.Person{
		AnilistID: 133507,
		Name:      people.Name{Full: sp("Chiaki Kobayashi"), Native: sp("小林千晃")},
		Image:     sp("https://s4.anilist.co/file/anilistcdn/staff/large/n133507.jpg"),
		Profile:   &people.PersonProfile{Occupations: []string{"Voice Actor"}, HomeTown: sp("Kanagawa, Japan"), Birth: &people.FuzzyDate{Year: ip(1994), Month: ip(6), Day: ip(4)}},
	}
	items, err = diffPerson(p, decodeChanges(t, `{
		"nameCn":"小林千晃","nameNative":"小林 千晃","nameFull":"Chiaki K.","occupations":["Voice Actor","Singer"],
		"gender":"Male","birth":{"year":1994,"month":6,"day":5},"homeTown":"神奈川县","bloodType":"A"
	}`))
	require.NoError(t, err)
	items = append(items, item{Field: overlay.FieldImage, Old: mustJSON(p.Image)})
	require.Len(t, items, 9)
	value = personValue(p)
	for _, it := range items {
		cur, ok := value(it.Field, it.Key)
		require.True(t, ok, it.Field)
		assert.True(t, sameValue(it.Field, it.Old, cur), "%s: %s vs %s", it.Field, it.Old, cur)
	}

	// A person without a profile: occupations were the empty list.
	bare := &people.Person{AnilistID: 2, Name: people.Name{Full: sp("Y")}}
	items, err = diffPerson(bare, decodeChanges(t, `{"occupations":["Singer"]}`))
	require.NoError(t, err)
	cur, _ := personValue(bare)(items[0].Field, items[0].Key)
	assert.True(t, sameValue(items[0].Field, items[0].Old, cur))
}

// Two readers' submissions on the same page, the first accepted: what the
// second was made against is gone from the fields the first changed, and
// only from those.
func TestStaleness_AfterAnotherEditIsAccepted(t *testing.T) {
	t.Parallel()
	refs := map[int32]people.PersonRef{777: {AnilistID: 777, Name: people.Name{Full: sp("Replacement")}}}
	// B: the line of Kobayashi's row, an alias added, the age.
	b, err := diffCharacter(stark(), decodeChanges(t, `{
		"voices":[{"key":"133507|Japanese|","line":"日配 · 主役"}],
		"aliases":["休塔尔克","史塔克"],
		"age":"18"
	}`), refs)
	require.NoError(t, err)

	// A, accepted first: the row given to 777, another alias.
	now := stark()
	now.Voices[0].Person = refs[777]
	now.AlternativeNames = []string{"休塔尔克", "斯塔克"}
	value := characterValue(now)
	stale := map[string]bool{}
	for _, it := range b {
		cur, ok := value(it.Field, it.Key)
		stale[it.Field] = !ok || !sameValue(it.Field, it.Old, cur)
	}
	assert.Equal(t, map[string]bool{"voice": true, "aliases": true, "age": false}, stale)
}

func TestSameValue(t *testing.T) {
	t.Parallel()
	raw := func(v any) json.RawMessage { return mustJSON(v) }
	// jsonb hands values back with its own key order and spacing.
	assert.True(t, sameValue(overlay.FieldBirth, json.RawMessage(`{"day": 4, "year": 1994, "month": 6}`),
		raw(people.FuzzyDate{Year: ip(1994), Month: ip(6), Day: ip(4)})))
	assert.False(t, sameValue(overlay.FieldBirth, raw(people.FuzzyDate{Month: ip(6)}), raw(nil)))
	assert.True(t, sameValue(overlay.FieldAliases, raw([]string{}), raw(nil)), "no aliases either way")
	assert.False(t, sameValue(overlay.FieldAliases, raw([]string{"a", "b"}), raw([]string{"b", "a"})), "the order is shown")
	assert.True(t, sameValue(overlay.FieldNameCn, raw("修塔尔克"), raw("修塔尔克")))
	assert.False(t, sameValue(overlay.FieldNameCn, raw("修塔尔克"), raw(nil)))

	// A voice row is who and which line: the person being renamed meanwhile
	// (their own page edited, or AniList) leaves the row as it was.
	row := voiceValue{PersonID: 133507, Name: people.Name{Cn: sp("小林千晃")}, Language: sp("Japanese")}
	renamed := row
	renamed.Name = people.Name{Cn: sp("小林 千晃")}
	assert.True(t, sameValue(overlay.FieldVoice, raw(row), raw(renamed)))
	moved := row
	moved.PersonID = 777
	assert.False(t, sameValue(overlay.FieldVoice, raw(row), raw(moved)))
	lined := row
	lined.Line = sp("日配 · 主役")
	assert.False(t, sameValue(overlay.FieldVoice, raw(row), raw(lined)))
	assert.False(t, sameValue(overlay.FieldVoice, raw(nil), raw(row)), "a row added meanwhile")
	assert.True(t, sameValue(overlay.FieldVoice, raw(nil), raw(nil)))
}
