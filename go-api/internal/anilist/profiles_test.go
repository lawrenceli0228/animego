package anilist

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// profileDocuments is both profile documents by name.
var profileDocuments = map[string]string{
	"StaffProfilesQuery":     StaffProfilesQuery,
	"CharacterProfilesQuery": CharacterProfilesQuery,
}

// TestProfileDocuments_BatchByID — both documents ask for an explicit id
// list on one page of AniList's maximum size, and say nothing about page
// counts: pageInfo.total is not a number AniList gets right, and with at
// most MaxProfileIDs ids on a page of MaxProfileIDs there is no second
// page to ask about.
func TestProfileDocuments_BatchByID(t *testing.T) {
	assert.Equal(t, 50, MaxProfileIDs, "AniList's page maximum")
	page := fmt.Sprintf("Page(page: 1, perPage: %d)", MaxProfileIDs)

	assert.Contains(t, StaffProfilesQuery, "query StaffProfiles($ids: [Int])")
	assert.Contains(t, StaffProfilesQuery, "staff(id_in: $ids)")
	assert.Contains(t, CharacterProfilesQuery, "query CharacterProfiles($ids: [Int])")
	assert.Contains(t, CharacterProfilesQuery, "characters(id_in: $ids)")

	for name, doc := range profileDocuments {
		assert.Contains(t, doc, page, name)
		assert.Equal(t, 1, strings.Count(doc, "Page("), "%s: one page", name)
		assert.NotContains(t, doc, "pageInfo", "%s: nothing may read AniList's page counts", name)
		assert.NotContains(t, doc, "Media(", "%s: a profile document is not a title document", name)
	}
	assert.NotContains(t, StaffProfilesQuery, "characters(")
	assert.NotContains(t, CharacterProfilesQuery, "staff(")
}

// TestProfileDocuments_SelectEveryField pins the selection field by field:
// what the sweep stores is exactly what these documents ask for, and a
// field dropped from a document would arrive as null and be written over
// the stored value as "AniList no longer says".
func TestProfileDocuments_SelectEveryField(t *testing.T) {
	staff := []string{
		"id",
		"name { full native alternative }",
		"languageV2",
		"image { large medium }",
		"description(asHtml: false)",
		"primaryOccupations",
		"gender",
		"dateOfBirth { year month day }",
		"dateOfDeath { year month day }",
		"age",
		"yearsActive",
		"homeTown",
		"bloodType",
		"favourites",
		"siteUrl",
	}
	characters := []string{
		"id",
		"name { full native alternative alternativeSpoiler }",
		"image { large medium }",
		"description(asHtml: false)",
		"gender",
		"dateOfBirth { year month day }",
		"age",
		"bloodType",
		"favourites",
		"siteUrl",
	}
	for _, f := range staff {
		assert.Regexp(t, `(?m)^\s*`+regexp.QuoteMeta(f)+`\s*$`, StaffProfilesQuery, "staff selects %q on a line of its own", f)
	}
	for _, f := range characters {
		assert.Regexp(t, `(?m)^\s*`+regexp.QuoteMeta(f)+`\s*$`, CharacterProfilesQuery, "characters select %q on a line of its own", f)
	}
	assert.NotContains(t, StaffProfilesQuery, "alternativeSpoiler", "StaffName has no spoiler names")
	assert.NotContains(t, CharacterProfilesQuery, "dateOfDeath", "Character has no date of death")
	assert.NotContains(t, CharacterProfilesQuery, "asHtml: true")
	assert.NotContains(t, StaffProfilesQuery, "asHtml: true")
}

// TestProfileTypes_DecodeOnlyWhatIsSelected ties the Go types to the
// documents: every json tag on StaffProfile / CharacterProfile names a
// field the document selects.  A tag with no selection behind it decodes
// as nil forever and is written as "AniList says nothing".
func TestProfileTypes_DecodeOnlyWhatIsSelected(t *testing.T) {
	for doc, typ := range map[string]reflect.Type{
		StaffProfilesQuery:     reflect.TypeOf(StaffProfile{}),
		CharacterProfilesQuery: reflect.TypeOf(CharacterProfile{}),
	} {
		for _, tag := range jsonTags(typ) {
			assert.Regexp(t, `\b`+regexp.QuoteMeta(tag)+`\b`, doc, "%s.%s is decoded but not selected", typ.Name(), tag)
		}
	}
}

// jsonTags lists the json names of a struct's fields, and of the struct
// fields it nests, so the name objects are checked too.
func jsonTags(typ reflect.Type) []string {
	var out []string
	for i := 0; i < typ.NumField(); i++ {
		f := typ.Field(i)
		name, _, _ := strings.Cut(f.Tag.Get("json"), ",")
		if name != "" && name != "-" {
			out = append(out, name)
		}
		inner := f.Type
		for inner.Kind() == reflect.Pointer || inner.Kind() == reflect.Slice {
			inner = inner.Elem()
		}
		if inner.Kind() == reflect.Struct && inner.PkgPath() == typ.PkgPath() {
			out = append(out, jsonTags(inner)...)
		}
	}
	return out
}

// TestClient_StaffProfilesNoWait_Decodes — one request, the ids as the
// only variable, every selected field decoded, AniList's nulls kept as
// nils (the normaliser decides what they mean, not the decoder).
func TestClient_StaffProfilesNoWait_Decodes(t *testing.T) {
	t.Parallel()

	const body = `{"data":{"Page":{"staff":[
	  {"id":101,
	   "name":{"full":"Test Person","native":"試験 人物","alternative":["T. Person",null,""]},
	   "languageV2":"Japanese",
	   "image":{"large":"https://img/large/101.png","medium":"https://img/medium/101.png"},
	   "description":"A voice actor.\n\n~!Plays the twist villain.!~",
	   "primaryOccupations":["Voice Actor","Singer"],
	   "gender":"Female",
	   "dateOfBirth":{"year":null,"month":9,"day":27},
	   "dateOfDeath":{"year":null,"month":null,"day":null},
	   "age":38,
	   "yearsActive":[2009],
	   "homeTown":"Oita, Japan",
	   "bloodType":"A",
	   "favourites":1234,
	   "siteUrl":"https://anilist.co/staff/101"},
	  {"id":103,"name":null,"image":null,"description":null,"primaryOccupations":[],"dateOfBirth":null,
	   "dateOfDeath":null,"age":null,"yearsActive":[],"favourites":0}
	]}}}`

	var got creditRequest
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		got = readCreditRequest(t, r)
		writeJSON(w, http.StatusOK, body)
	}))
	defer srv.Close()

	res, err := testClient(t, srv.URL).StaffProfilesNoWait(context.Background(), []int{101, 102, 103})
	require.NoError(t, err)

	assert.Equal(t, int32(1), calls.Load())
	assert.Equal(t, StaffProfilesQuery, got.Query)
	assert.Equal(t, map[string]any{"ids": []any{float64(101), float64(102), float64(103)}}, got.Variables,
		"the ids are the only variable; the page size is in the document")

	require.Len(t, res, 2, "102 did not come back; the caller decides what that means")
	p := res[0]
	assert.Equal(t, 101, p.ID)
	require.NotNil(t, p.Name)
	assert.Equal(t, "Test Person", *p.Name.Full)
	assert.Equal(t, "試験 人物", *p.Name.Native)
	require.Len(t, p.Name.Alternative, 3)
	assert.Equal(t, "T. Person", *p.Name.Alternative[0])
	assert.Nil(t, p.Name.Alternative[1], "a null in a list stays a nil")
	assert.Equal(t, "Japanese", *p.LanguageV2)
	assert.Equal(t, "https://img/large/101.png", *p.Image.Large)
	assert.Equal(t, "https://img/medium/101.png", *p.Image.Medium)
	assert.Equal(t, "A voice actor.\n\n~!Plays the twist villain.!~", *p.Description, "raw, spoiler markup and all")
	require.Len(t, p.PrimaryOccupations, 2)
	assert.Equal(t, "Singer", *p.PrimaryOccupations[1])
	assert.Equal(t, "Female", *p.Gender)
	assert.Nil(t, p.DateOfBirth.Year)
	assert.Equal(t, 9, *p.DateOfBirth.Month)
	assert.Equal(t, 27, *p.DateOfBirth.Day)
	require.NotNil(t, p.DateOfDeath)
	assert.Nil(t, p.DateOfDeath.Year)
	assert.Equal(t, 38, *p.Age)
	require.Len(t, p.YearsActive, 1)
	assert.Equal(t, 2009, *p.YearsActive[0])
	assert.Equal(t, "Oita, Japan", *p.HomeTown)
	assert.Equal(t, "A", *p.BloodType)
	assert.Equal(t, 1234, *p.Favourites)
	assert.Equal(t, "https://anilist.co/staff/101", *p.SiteURL)

	bare := res[1]
	assert.Equal(t, 103, bare.ID)
	assert.Nil(t, bare.Name)
	assert.Nil(t, bare.Image)
	assert.Nil(t, bare.Description)
	assert.Nil(t, bare.Age)
	assert.Equal(t, 0, *bare.Favourites, "zero favourites is a number, not an absence")
}

// TestClient_CharacterProfilesNoWait_Decodes is the character twin: the
// spoiler names, and an age that is free text on AniList.
func TestClient_CharacterProfilesNoWait_Decodes(t *testing.T) {
	t.Parallel()

	const body = `{"data":{"Page":{"characters":[
	  {"id":201,
	   "name":{"full":"Test Hero","native":"テスト","alternative":["The Hero"],"alternativeSpoiler":["The Demon King"]},
	   "image":{"large":"https://img/large/201.png","medium":"https://img/medium/201.png"},
	   "description":"__Height:__ 160 cm\n~!Was the king all along.!~",
	   "gender":"Male",
	   "dateOfBirth":{"year":null,"month":12,"day":24},
	   "age":"16-17",
	   "bloodType":"O",
	   "favourites":42,
	   "siteUrl":"https://anilist.co/character/201"}
	]}}}`

	var got creditRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = readCreditRequest(t, r)
		writeJSON(w, http.StatusOK, body)
	}))
	defer srv.Close()

	res, err := testClient(t, srv.URL).CharacterProfilesNoWait(context.Background(), []int{201})
	require.NoError(t, err)

	assert.Equal(t, CharacterProfilesQuery, got.Query)
	assert.Equal(t, map[string]any{"ids": []any{float64(201)}}, got.Variables)
	require.Len(t, res, 1)
	c := res[0]
	assert.Equal(t, 201, c.ID)
	assert.Equal(t, "Test Hero", *c.Name.Full)
	assert.Equal(t, "テスト", *c.Name.Native)
	assert.Equal(t, "The Hero", *c.Name.Alternative[0])
	assert.Equal(t, "The Demon King", *c.Name.AlternativeSpoiler[0])
	assert.Equal(t, "https://img/medium/201.png", *c.Image.Medium)
	assert.Equal(t, "__Height:__ 160 cm\n~!Was the king all along.!~", *c.Description)
	assert.Equal(t, "Male", *c.Gender)
	assert.Equal(t, 12, *c.DateOfBirth.Month)
	assert.Equal(t, "16-17", *c.Age, "AniList's Character.age is a string")
	assert.Equal(t, "O", *c.BloodType)
	assert.Equal(t, 42, *c.Favourites)
	assert.Equal(t, "https://anilist.co/character/201", *c.SiteURL)
}

// TestClient_Profiles_AnswerWithoutAListIsAnError — "AniList returned
// these" and "AniList did not answer" must stay apart: the sweep stamps
// every id missing from a list as deleted upstream, so a null page or a
// null list has to fail rather than read as an empty one.  An empty list
// is an answer.
func TestClient_Profiles_AnswerWithoutAListIsAnError(t *testing.T) {
	t.Parallel()

	for name, tc := range map[string]struct {
		body    string
		staff   bool
		wantErr bool
	}{
		"null page, staff":          {body: `{"data":{"Page":null}}`, staff: true, wantErr: true},
		"null list, staff":          {body: `{"data":{"Page":{"staff":null}}}`, staff: true, wantErr: true},
		"no list, staff":            {body: `{"data":{"Page":{}}}`, staff: true, wantErr: true},
		"empty list, staff":         {body: `{"data":{"Page":{"staff":[]}}}`, staff: true},
		"null page, characters":     {body: `{"data":{"Page":null}}`, wantErr: true},
		"null list, characters":     {body: `{"data":{"Page":{"characters":null}}}`, wantErr: true},
		"no list, characters":       {body: `{"data":{"Page":{}}}`, wantErr: true},
		"empty list, characters":    {body: `{"data":{"Page":{"characters":[]}}}`},
		"the other kind's list":     {body: `{"data":{"Page":{"characters":[{"id":1}]}}}`, staff: true, wantErr: true},
		"field error, characters":   {body: `{"data":{"Page":null},"errors":[{"message":"Internal Server Error"}]}`, wantErr: true},
		"field error, partial page": {body: `{"data":{"Page":{"staff":[{"id":1}]}},"errors":[{"message":"boom"}]}`, staff: true, wantErr: true},
	} {
		t.Run(name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				writeJSON(w, http.StatusOK, tc.body)
			}))
			defer srv.Close()
			c := testClient(t, srv.URL)

			var n int
			var err error
			if tc.staff {
				var res []StaffProfile
				res, err = c.StaffProfilesNoWait(context.Background(), []int{1, 2})
				n = len(res)
			} else {
				var res []CharacterProfile
				res, err = c.CharacterProfilesNoWait(context.Background(), []int{1, 2})
				n = len(res)
			}
			if !tc.wantErr {
				require.NoError(t, err)
				assert.Zero(t, n)
				return
			}
			var up *ErrUpstream
			require.True(t, errors.As(err, &up), "got %v", err)
			assert.Equal(t, http.StatusBadGateway, up.Status)
		})
	}
}

// TestClient_Profiles_BatchBounds — an empty batch would post `id_in: []`,
// which AniList reads as no filter at all; a batch past the page maximum
// would be truncated silently and the overflow read as deleted.  Both are
// refused before a token is taken.
func TestClient_Profiles_BatchBounds(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
	}))
	defer srv.Close()

	c, _ := noWaitClient(t, srv.URL)
	tooMany := make([]int, MaxProfileIDs+1)
	for i := range tooMany {
		tooMany[i] = i + 1
	}

	_, err := c.StaffProfilesNoWait(context.Background(), nil)
	assert.ErrorIs(t, err, ErrNoProfileIDs)
	_, err = c.CharacterProfilesNoWait(context.Background(), []int{})
	assert.ErrorIs(t, err, ErrNoProfileIDs)
	_, err = c.StaffProfilesNoWait(context.Background(), tooMany)
	assert.ErrorIs(t, err, ErrProfileBatchTooLarge)
	_, err = c.CharacterProfilesNoWait(context.Background(), tooMany)
	assert.ErrorIs(t, err, ErrProfileBatchTooLarge)

	assert.Equal(t, int32(0), calls.Load())
	assert.True(t, c.limiter.Allow(), "no token was spent on a refused batch")
}

// TestClient_Profiles_NoToken_BudgetBusy — the sweep's requests never
// queue: with the bucket empty they answer ErrBudgetBusy without sending
// anything and without touching the breaker.
func TestClient_Profiles_NoToken_BudgetBusy(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		writeJSON(w, http.StatusOK, `{"data":{"Page":{"staff":[],"characters":[]}}}`)
	}))
	defer srv.Close()

	c, slept := noWaitClient(t, srv.URL)
	require.True(t, c.limiter.Allow(), "drain the single token")

	_, err := c.StaffProfilesNoWait(context.Background(), []int{1})
	require.ErrorIs(t, err, ErrBudgetBusy)
	_, err = c.CharacterProfilesNoWait(context.Background(), []int{1})
	require.ErrorIs(t, err, ErrBudgetBusy)
	assert.Equal(t, int32(0), calls.Load())
	assert.Empty(t, *slept, "no-wait never sleeps")
	assert.False(t, c.breakerOpen())
}

// TestClient_Profiles_429_NoRetry — a 429 is final in no-wait mode: one
// HTTP call, no sleep, the breaker opens for every caller.
func TestClient_Profiles_429_NoRetry(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Retry-After", "1")
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer srv.Close()

	c, slept := noWaitClient(t, srv.URL)
	_, err := c.CharacterProfilesNoWait(context.Background(), []int{1, 2})

	require.ErrorIs(t, err, ErrRateLimited)
	assert.Equal(t, int32(1), calls.Load())
	assert.Empty(t, *slept)
	assert.True(t, c.breakerOpen())

	_, err = c.StaffProfilesNoWait(context.Background(), []int{1})
	require.ErrorIs(t, err, ErrRateLimited, "the open breaker answers without a request")
	assert.Equal(t, int32(1), calls.Load())
}
