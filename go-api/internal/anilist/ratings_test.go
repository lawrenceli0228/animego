// Package anilist — ratings_test.go
//
// Covers MediaRatingsQuery and the Ratings method: the sum that turns a
// histogram into a rater count, the nil/zero distinction that decides
// whether a row gets written at all, and the two batch-size refusals
// that stop a silent truncation being read as "AniList dropped these".
package anilist

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestMediaRatingsQuerySelectsWhatScoreVotesReads is the link between
// the query text and the method that depends on it.
//
// ScoreVotes returns nil when Stats is nil, and its caller reads that as
// "the document did not ask" and skips the row.  Delete
// `stats { scoreDistribution ... }` from this query for payload reasons
// and every batch would come back with nil Stats: the sweep would log a
// warning per row, write nothing, stamp nothing, and re-read the same
// 2,000 rows every hour forever — with no compile error and no other
// test failing.  This is the test that fails instead.
func TestMediaRatingsQuerySelectsWhatScoreVotesReads(t *testing.T) {
	assert.Contains(t, MediaRatingsQuery, "scoreDistribution",
		"ScoreVotes returns nil without this selection, and its caller reads nil as 'never asked'")
	assert.Contains(t, MediaRatingsQuery, "averageScore",
		"UpdateAnilistRating writes this column; without the selection every row would COALESCE to its old value")
	assert.Contains(t, MediaRatingsQuery, "id",
		"the batch is attributed by id; without it no response row can be matched to a request row")

	// The narrowness is a property, not an accident: this document must
	// not grow into a cache warm.  A field added here is a field the
	// sweep will silently not write, because UpdateAnilistRating touches
	// three columns and nothing else.
	for _, forbidden := range []string{"coverImage", "title", "description", "trailer", "genres"} {
		assert.NotContains(t, MediaRatingsQuery, forbidden,
			"MediaRatingsQuery selects %s but the ratings sweep writes only score columns", forbidden)
	}
}

// TestScoreVotes_SumsTheDistribution is the core claim of the feature:
// AniList has no rater-count scalar, and this sum is what stands in for
// Bangumi's "N 人评分".
func TestScoreVotes_SumsTheDistribution(t *testing.T) {
	m := Media{Stats: &MediaStats{ScoreDistribution: []ScoreDistributionBucket{
		{Score: 10, Amount: 3},
		{Score: 50, Amount: 120},
		{Score: 90, Amount: 17900},
	}}}
	got := m.ScoreVotes()
	require.NotNil(t, got)
	assert.Equal(t, 18023, *got)
}

// TestScoreVotes_NilStatsIsNotZero pins the distinction the whole
// column depends on.
//
// A Media from a document that did not select `stats` has no opinion
// about how many people rated it.  Returning 0 there would let a future
// caller on any other query write "asked, nobody rated it" over a real
// count.
func TestScoreVotes_NilStatsIsNotZero(t *testing.T) {
	assert.Nil(t, Media{}.ScoreVotes(),
		"a Media from a query that did not select stats must not claim a count")
}

// TestScoreVotes_EmptyDistributionIsZero is the other half of that
// distinction.  We asked, and nobody has scored it — which is an answer,
// and the one the stamp exists to let us store.
func TestScoreVotes_EmptyDistributionIsZero(t *testing.T) {
	for _, tc := range []struct {
		name string
		dist []ScoreDistributionBucket
	}{
		{"empty slice", []ScoreDistributionBucket{}},
		{"null distribution", nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := Media{Stats: &MediaStats{ScoreDistribution: tc.dist}}.ScoreVotes()
			require.NotNil(t, got, "stats was selected, so there is an answer")
			assert.Equal(t, 0, *got)
		})
	}
}

// TestScoreVotes_IgnoresNegativeAmounts guards the column's CHECK from
// the one direction it cannot defend itself: the per-row update error is
// swallowed by the sweep, so a refused write shows up as a row that
// quietly stops refreshing rather than as anything anyone sees.
func TestScoreVotes_IgnoresNegativeAmounts(t *testing.T) {
	m := Media{Stats: &MediaStats{ScoreDistribution: []ScoreDistributionBucket{
		{Score: 10, Amount: -5},
		{Score: 90, Amount: 7},
	}}}
	got := m.ScoreVotes()
	require.NotNil(t, got)
	assert.Equal(t, 7, *got)
}

// TestRatings_DecodesTheWireShape drives a response in AniList's
// documented format through the real client.
func TestRatings_DecodesTheWireShape(t *testing.T) {
	var gotVars map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var req struct {
			Query     string         `json:"query"`
			Variables map[string]any `json:"variables"`
		}
		require.NoError(t, json.Unmarshal(body, &req))
		gotVars = req.Variables
		writeJSON(w, http.StatusOK, `{"data":{"Page":{"media":[
		  {"id":21,"averageScore":86,"stats":{"scoreDistribution":[
		    {"score":70,"amount":1000},{"score":80,"amount":2500}]}},
		  {"id":22,"averageScore":null,"stats":{"scoreDistribution":[]}}
		]}}}`)
	}))
	defer srv.Close()

	resp, err := testClient(t, srv.URL).Ratings(context.Background(), RatingsVars{IDs: []int{21, 22, 23}})
	require.NoError(t, err)
	require.Len(t, resp.Page.Media, 2, "AniList omitted 23; the caller has to notice")

	require.NotNil(t, resp.Page.Media[0].AverageScore)
	assert.Equal(t, 86, *resp.Page.Media[0].AverageScore)
	require.NotNil(t, resp.Page.Media[0].ScoreVotes())
	assert.Equal(t, 3500, *resp.Page.Media[0].ScoreVotes())

	assert.Nil(t, resp.Page.Media[1].AverageScore, "no score is not a zero score")
	require.NotNil(t, resp.Page.Media[1].ScoreVotes())
	assert.Equal(t, 0, *resp.Page.Media[1].ScoreVotes(), "asked, and nobody has rated it")

	// perPage must equal the batch size.  AniList defaults a page to far
	// fewer than 50, so sending the ids without it would truncate every
	// batch and the missing rows would be stamped as absent upstream.
	assert.EqualValues(t, 3, gotVars["perPage"])
}

// TestRatings_RefusesBatchesThatWouldBeTruncated covers both guards.
//
// A truncated page is indistinguishable at the wire from ids AniList
// declines to serve, and the caller stamps those as checked — so an
// oversized batch would write "asked, no rating" over rows nobody asked
// about.  An empty batch posts `id_in: []`, which AniList reads as no
// filter and answers with arbitrary anime.
func TestRatings_RefusesBatchesThatWouldBeTruncated(t *testing.T) {
	var called bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called = true
		writeJSON(w, http.StatusOK, `{"data":{"Page":{"media":[]}}}`)
	}))
	defer srv.Close()
	c := testClient(t, srv.URL)

	_, err := c.Ratings(context.Background(), RatingsVars{})
	assert.ErrorIs(t, err, ErrNoRatingIDs)

	oversized := make([]int, MaxRatingIDs+1)
	_, err = c.Ratings(context.Background(), RatingsVars{IDs: oversized})
	assert.ErrorIs(t, err, ErrRatingBatchTooLarge)

	assert.False(t, called, "neither refusal may reach AniList")
}

// TestRatings_PropagatesUpstreamErrors pins that the sweep sees a
// failure as a failure.  It leaves the whole batch unstamped on error,
// which is only correct if the error actually arrives.
func TestRatings_PropagatesUpstreamErrors(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusForbidden, `{"errors":[{"message":"The AniList API has been temporarily disabled due to severe stability issues.","status":403}],"data":null}`)
	}))
	defer srv.Close()

	_, err := testClient(t, srv.URL).Ratings(context.Background(), RatingsVars{IDs: []int{21}})
	require.Error(t, err)
	var upstream *ErrUpstream
	require.ErrorAs(t, err, &upstream)
	assert.Equal(t, http.StatusForbidden, upstream.Status)
	assert.True(t, strings.Contains(upstream.Message, "temporarily disabled") || upstream.Message != "",
		"the upstream message is what a pass logs; losing it makes a 403 outage indistinguishable from a bad query")
}
