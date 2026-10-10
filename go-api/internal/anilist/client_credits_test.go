package anilist

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// creditRequest is the POST body a credit document arrives as.
type creditRequest struct {
	Query     string         `json:"query"`
	Variables map[string]any `json:"variables"`
}

func readCreditRequest(t *testing.T, r *http.Request) creditRequest {
	t.Helper()
	body, err := io.ReadAll(r.Body)
	require.NoError(t, err)
	var req creditRequest
	require.NoError(t, json.Unmarshal(body, &req))
	return req
}

// TestClient_CharacterPagesNoWait_DecodesEachAliasInOrder — the response
// is one Media carrying p1, p2 ... as raw fields; each must land in its
// own page, in page order, with the voice roles and page flags intact.
func TestClient_CharacterPagesNoWait_DecodesEachAliasInOrder(t *testing.T) {
	t.Parallel()

	const body = `{"data":{"Media":{
	  "id": 154587,
	  "p2": {"pageInfo":{"hasNextPage":false},"edges":[
	    {"role":"BACKGROUND","node":{"id":3,"name":{"full":"Third"}},"voiceActorRoles":[]}
	  ]},
	  "p1": {"pageInfo":{"hasNextPage":true},"edges":[
	    {"role":"MAIN","node":{"id":1,"name":{"full":"Stark"},"image":{"large":"L","medium":"M"}},
	     "voiceActorRoles":[
	       {"roleNotes":null,"dubGroup":null,"voiceActor":{"id":10,"name":{"full":"Chiaki Kobayashi","native":"小林千晃"},"languageV2":"Japanese"}},
	       {"roleNotes":"Childhood","dubGroup":null,"voiceActor":{"id":11,"name":{"full":"Arisa Kiyoto"},"languageV2":"Japanese"}}
	     ]},
	    {"role":"SUPPORTING","node":{"id":2},"voiceActorRoles":[]}
	  ]}
	}}}`

	var got creditRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = readCreditRequest(t, r)
		writeJSON(w, http.StatusOK, body)
	}))
	defer srv.Close()

	c := testClient(t, srv.URL)
	res, err := c.CharacterPagesNoWait(context.Background(), CreditPagesVars{ID: 154587, FirstPage: 1, LastPage: 2})
	require.NoError(t, err)

	assert.Contains(t, got.Query, "p1: characters(")
	assert.Contains(t, got.Query, "p2: characters(")
	assert.NotContains(t, got.Query, "p3:")
	assert.Equal(t, 2, strings.Count(got.Query, "voiceActorRoles(language: JAPANESE"),
		"what goes over the wire asks for Japanese voices on every page")
	assert.Equal(t, map[string]any{"id": float64(154587)}, got.Variables, "only the id travels as a variable")

	assert.Equal(t, 154587, res.MediaID)
	require.Len(t, res.Pages, 2)

	hasNext, known := res.Pages[0].NextPage()
	assert.True(t, known)
	assert.True(t, hasNext)
	require.Len(t, res.Pages[0].Edges, 2)
	stark := res.Pages[0].Edges[0]
	assert.Equal(t, 1, stark.Node.ID)
	require.Len(t, stark.VoiceActorRoles, 2)
	assert.Nil(t, stark.VoiceActorRoles[0].RoleNotes)
	assert.Equal(t, "Japanese", *stark.VoiceActorRoles[0].VoiceActor.LanguageV2)
	assert.Equal(t, "Childhood", *stark.VoiceActorRoles[1].RoleNotes)
	assert.Equal(t, "L", *stark.Node.Image.Large)
	assert.Equal(t, "M", *stark.Node.Image.Medium)

	hasNext, known = res.Pages[1].NextPage()
	assert.True(t, known)
	assert.False(t, hasNext)
	require.Len(t, res.Pages[1].Edges, 1)
	assert.Equal(t, 3, res.Pages[1].Edges[0].Node.ID)
}

// TestClient_StaffPagesNoWait_DecodesEachAlias is the staff twin, on a
// second-request range so the page-numbered aliases are exercised.
func TestClient_StaffPagesNoWait_DecodesEachAlias(t *testing.T) {
	t.Parallel()

	const body = `{"data":{"Media":{"id":7,
	  "p9":  {"pageInfo":{"hasNextPage":true},"edges":[{"role":"Director","node":{"id":95000,"name":{"full":"A"}}}]},
	  "p10": {"pageInfo":{"hasNextPage":false},"edges":[]}
	}}}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, body)
	}))
	defer srv.Close()

	res, err := testClient(t, srv.URL).StaffPagesNoWait(context.Background(), CreditPagesVars{ID: 7, FirstPage: 9, LastPage: 10})
	require.NoError(t, err)
	assert.Equal(t, 7, res.MediaID)
	require.Len(t, res.Pages, 2)
	require.Len(t, res.Pages[0].Edges, 1)
	assert.Equal(t, 95000, res.Pages[0].Edges[0].Node.ID)
	assert.Empty(t, res.Pages[1].Edges)
}

// TestClient_CreditPages_AbsentMediaIsNotFound — AniList answers a title
// it does not serve either with HTTP 404 or with `Media: null`; both
// reach the caller as the same ErrUpstream 404.
func TestClient_CreditPages_AbsentMediaIsNotFound(t *testing.T) {
	t.Parallel()

	for name, respond := range map[string]func(http.ResponseWriter){
		"media null": func(w http.ResponseWriter) { writeJSON(w, http.StatusOK, `{"data":{"Media":null}}`) },
		"http 404": func(w http.ResponseWriter) {
			writeJSON(w, http.StatusNotFound, `{"data":{"Media":null},"errors":[{"message":"Not Found.","status":404}]}`)
		},
	} {
		t.Run(name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { respond(w) }))
			defer srv.Close()

			_, err := testClient(t, srv.URL).CharacterPagesNoWait(context.Background(), CreditPagesVars{ID: 1, FirstPage: 1, LastPage: 8})
			var up *ErrUpstream
			require.True(t, errors.As(err, &up), "got %v", err)
			assert.Equal(t, http.StatusNotFound, up.Status)
		})
	}
}

// TestClient_CreditPages_OmittedPageIsAnError — an empty page means "the
// list ended"; a page the document asked for and the response left out
// must not be read that way, or a truncated list would be stored as the
// whole one.
func TestClient_CreditPages_OmittedPageIsAnError(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, `{"data":{"Media":{"id":1,"p1":{"pageInfo":{"hasNextPage":true},"edges":[]},"p2":null}}}`)
	}))
	defer srv.Close()

	_, err := testClient(t, srv.URL).CharacterPagesNoWait(context.Background(), CreditPagesVars{ID: 1, FirstPage: 1, LastPage: 3})
	var up *ErrUpstream
	require.True(t, errors.As(err, &up), "got %v", err)
	assert.Equal(t, http.StatusBadGateway, up.Status)
}

// TestClient_CreditPages_NoToken_BudgetBusy — the sweep's requests never
// queue: with the bucket empty they answer ErrBudgetBusy without sending
// anything and without touching the breaker.
func TestClient_CreditPages_NoToken_BudgetBusy(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		writeJSON(w, http.StatusOK, `{"data":{"Media":{"id":1}}}`)
	}))
	defer srv.Close()

	c, _ := noWaitClient(t, srv.URL)
	require.True(t, c.limiter.Allow(), "drain the single token")

	_, err := c.CharacterPagesNoWait(context.Background(), CreditPagesVars{ID: 1, FirstPage: 1, LastPage: 8})
	require.ErrorIs(t, err, ErrBudgetBusy)
	_, err = c.StaffPagesNoWait(context.Background(), CreditPagesVars{ID: 1, FirstPage: 1, LastPage: 8})
	require.ErrorIs(t, err, ErrBudgetBusy)
	assert.Equal(t, int32(0), calls.Load())
	assert.False(t, c.breakerOpen())
}

// TestClient_CreditPages_BadRangeSendsNothing — a range no document can
// carry is refused before a token is taken.
func TestClient_CreditPages_BadRangeSendsNothing(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
	}))
	defer srv.Close()

	c, _ := noWaitClient(t, srv.URL)
	_, err := c.CharacterPagesNoWait(context.Background(), CreditPagesVars{ID: 1, FirstPage: 1, LastPage: 9})
	require.ErrorIs(t, err, ErrCreditPageRange)
	assert.Equal(t, int32(0), calls.Load())
	assert.True(t, c.limiter.Allow(), "the token was not spent on a refused range")
}
