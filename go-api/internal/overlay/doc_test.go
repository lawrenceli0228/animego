package overlay

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestOpt_ThreeStatesSurviveJSON(t *testing.T) {
	t.Parallel()
	var doc Doc
	require.NoError(t, json.Unmarshal([]byte(`{"gender":"Male","age":null}`), &doc))

	assert.True(t, doc.Gender.Set)
	assert.Equal(t, "Male", *doc.Gender.Value)
	assert.True(t, doc.Age.Set, "an explicit null is a cleared value")
	assert.Nil(t, doc.Age.Value)
	assert.False(t, doc.BloodType.Set, "an absent key is no overlay at all")

	raw, err := json.Marshal(doc)
	require.NoError(t, err)
	assert.JSONEq(t, `{"gender":"Male","age":null}`, string(raw), "unset fields are left out, cleared ones kept")
}

func TestDecode_EmptyAndGarbage(t *testing.T) {
	t.Parallel()
	doc, err := Decode(nil)
	require.NoError(t, err)
	assert.True(t, doc.IsEmpty())

	doc, err = Decode(json.RawMessage(`{}`))
	require.NoError(t, err)
	assert.True(t, doc.IsEmpty())

	_, err = Decode(json.RawMessage(`[1,2]`))
	assert.Error(t, err, "an overlay is an object")

	doc, err = Decode(json.RawMessage(`{"nameCn":"修塔尔克","somethingNew":1}`))
	require.NoError(t, err, "a key a newer build wrote is ignored, not fatal")
	assert.Equal(t, "修塔尔克", *doc.NameCn.Value)
}

func TestWith_ScalarsListsAndDates(t *testing.T) {
	t.Parallel()
	base := Doc{NameCn: Of("旧名")}

	next, err := base.With(FieldNameCn, "", json.RawMessage(`"新名"`))
	require.NoError(t, err)
	assert.Equal(t, "新名", *next.NameCn.Value)
	assert.Equal(t, "旧名", *base.NameCn.Value, "With returns a new document; the old one is unchanged")

	next, err = next.With(FieldAliases, "", json.RawMessage(`["休塔尔克","Stark"]`))
	require.NoError(t, err)
	assert.Equal(t, []string{"休塔尔克", "Stark"}, *next.Aliases.Value)

	next, err = next.With(FieldBirth, "", json.RawMessage(`{"year":null,"month":3,"day":2}`))
	require.NoError(t, err)
	assert.Nil(t, next.Birth.Value.Year)
	assert.Equal(t, int32(3), *next.Birth.Value.Month)

	next, err = next.With(FieldGender, "", json.RawMessage(`null`))
	require.NoError(t, err)
	assert.True(t, next.Gender.Set)
	assert.Nil(t, next.Gender.Value)

	_, err = next.With("nonsense", "", json.RawMessage(`"x"`))
	assert.Error(t, err)
	_, err = next.With(FieldNameCn, "", json.RawMessage(`null`))
	assert.Error(t, err, "a name is never cleared")
	_, err = next.With(FieldAliases, "", json.RawMessage(`"not a list"`))
	assert.Error(t, err)
}

func TestWith_ImageStoresTheURL(t *testing.T) {
	t.Parallel()
	next, err := Doc{}.With(FieldImage, "", json.RawMessage(`"https://example.org/api/edit-images/a.jpg"`))
	require.NoError(t, err)
	assert.Equal(t, "https://example.org/api/edit-images/a.jpg", *next.Image.Value)
}

func TestWith_VoicesReplaceByKeyAndKeepOrder(t *testing.T) {
	t.Parallel()
	doc := Doc{}
	doc, err := doc.With(FieldVoice, "201|Japanese|", json.RawMessage(`{"personId":201,"line":"日配 · 主役"}`))
	require.NoError(t, err)
	doc, err = doc.With(FieldVoice, "add:301", json.RawMessage(`{"personId":301,"line":"中配"}`))
	require.NoError(t, err)
	doc, err = doc.With(FieldVoice, "206|Japanese|Childhood", json.RawMessage(`null`))
	require.NoError(t, err)
	// A later edit of the first row replaces its op in place.
	doc, err = doc.With(FieldVoice, "201|Japanese|", json.RawMessage(`{"personId":202,"line":null}`))
	require.NoError(t, err)

	require.Len(t, doc.Voices, 3)
	assert.Equal(t, VoiceOp{Key: "201|Japanese|", PersonID: 202}, doc.Voices[0])
	assert.Equal(t, "add:301", doc.Voices[1].Key)
	assert.Equal(t, int32(301), doc.Voices[1].PersonID)
	assert.Equal(t, VoiceOp{Key: "206|Japanese|Childhood", Remove: true}, doc.Voices[2])

	op, ok := doc.VoiceOp("206|Japanese|Childhood")
	assert.True(t, ok)
	assert.True(t, op.Remove)
	_, ok = doc.VoiceOp("999|Japanese|")
	assert.False(t, ok)

	_, err = doc.With(FieldVoice, "", json.RawMessage(`null`))
	assert.Error(t, err, "a voice op needs its key")
	_, err = doc.With(FieldVoice, "add:5", json.RawMessage(`{"line":"x"}`))
	assert.Error(t, err, "a kept voice names its person")
}

func TestWith_Roles(t *testing.T) {
	t.Parallel()
	doc, err := Doc{}.With(FieldRole, "154587", json.RawMessage(`"SUPPORTING"`))
	require.NoError(t, err)
	role, ok := doc.Role(154587)
	assert.True(t, ok)
	assert.Equal(t, "SUPPORTING", role)
	_, ok = doc.Role(1)
	assert.False(t, ok)

	_, err = doc.With(FieldRole, "154587", json.RawMessage(`"VILLAIN"`))
	assert.Error(t, err)
	_, err = doc.With(FieldRole, "abc", json.RawMessage(`"MAIN"`))
	assert.Error(t, err)
}

func TestVoiceKey(t *testing.T) {
	t.Parallel()
	notes := "Childhood"
	lang := "Japanese"
	assert.Equal(t, "206|Japanese|Childhood", VoiceKey(206, &lang, &notes))
	assert.Equal(t, "201||", VoiceKey(201, nil, nil))
	assert.Equal(t, "add:301", AddedVoiceKey(301))
	id, ok := AddedVoicePerson("add:301")
	assert.True(t, ok)
	assert.Equal(t, int32(301), id)
	_, ok = AddedVoicePerson("301||")
	assert.False(t, ok)
}

func TestValidField(t *testing.T) {
	t.Parallel()
	for _, f := range []string{FieldNameCn, FieldImage, FieldVoice, FieldRole, FieldOccupations} {
		assert.True(t, ValidField(f), f)
	}
	assert.False(t, ValidField("rating"))
}
