package anime

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// GET /api/anime/{id}/watchers takes no auth at all, and the frontend renders
// each username four times per watcher (the /u/{username} href, title,
// aria-label and img alt) into /anime/{id} — an ISR-prerendered,
// Cloudflare-edge-cached, indexable route.
//
// On 2026-08-16 this endpoint was returning live email addresses and phone
// numbers in production, because nothing constrained the shape of
// users.username.  These tests fail if the masking is ever removed.
func TestWatchers_MasksContactShapedUsernames(t *testing.T) {
	t.Parallel()

	// Shapes observed in production (values altered, shapes kept).
	q := &fakeQuerier{
		getWatchersFn: func(_ context.Context, _ int32, _ int32) ([]dbgen.GetWatchersRow, error) {
			return []dbgen.GetWatchersRow{
				{Username: "2548537435@qq.com"},
				{Username: "17566285293"},
				{Username: "alice"},
			}, nil
		},
		countWatchersFn: func(_ context.Context, _ int32) (int64, error) { return 3, nil },
	}

	rec := httptest.NewRecorder()
	watchersRouter(q).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/42/watchers", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	body := rec.Body.String()

	// The whole point: none of it may appear anywhere in the response.
	for _, leak := range []string{"2548537435", "@qq.com", "17566285293", "@"} {
		require.NotContains(t, body, leak,
			"watchers response leaked %q — this reaches an anonymous caller and the CDN-cached detail page", leak)
	}

	var parsed struct {
		Data []struct {
			Username string `json:"username"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal([]byte(body), &parsed))
	require.Len(t, parsed.Data, 3)

	// Masked entries are replaced, not dropped: the watcher count and the
	// avatar row must stay honest.
	require.True(t, strings.HasPrefix(parsed.Data[0].Username, "user-"))
	require.True(t, strings.HasPrefix(parsed.Data[1].Username, "user-"))

	// A normal username is untouched — a false positive here would rename
	// real users and break their /u/ links.
	require.Equal(t, "alice", parsed.Data[2].Username)
}

// The slug has to be stable, or the same watcher would appear as a different
// person on every request and /u/{slug} could never resolve.
func TestWatchers_MaskIsStableAcrossRequests(t *testing.T) {
	t.Parallel()

	q := &fakeQuerier{
		getWatchersFn: func(_ context.Context, _ int32, _ int32) ([]dbgen.GetWatchersRow, error) {
			return []dbgen.GetWatchersRow{{Username: "2548537435@qq.com"}}, nil
		},
		countWatchersFn: func(_ context.Context, _ int32) (int64, error) { return 1, nil },
	}

	get := func() string {
		rec := httptest.NewRecorder()
		watchersRouter(q).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/42/watchers", nil))
		var parsed struct {
			Data []struct {
				Username string `json:"username"`
			} `json:"data"`
		}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &parsed))
		require.Len(t, parsed.Data, 1)
		return parsed.Data[0].Username
	}

	require.Equal(t, get(), get())
}
