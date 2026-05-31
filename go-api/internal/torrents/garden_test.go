// Package torrents — garden_test.go
//
// Covers:
//   - happy path (valid JSON → parsed items, ordered as upstream returned)
//   - empty resources for non-empty query → empty slice + zero-result log
//   - non-2xx upstream status → empty slice + error
//   - transport / network error → empty slice + error
//   - fansub fallback to ParseFansub when r.fansub is missing
//   - non-magnet protocol items dropped from result
//   - FormatBytes / FormatKb / ParseFansub helpers (bundled here per
//     task brief — separate format_test.go would also be fine; keeping
//     them together so the test file is self-contained)
package torrents

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// testLogger captures Warn() calls so tests can assert the silent-failure
// tripwire fires (or doesn't).  Safe for concurrent use because the
// aggregator may invoke Warn from any goroutine.
type testLogger struct {
	mu      sync.Mutex
	entries []logEntry
}

type logEntry struct {
	msg  string
	args []any
}

func (l *testLogger) Warn(msg string, args ...any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.entries = append(l.entries, logEntry{msg: msg, args: args})
}

// findEntry returns the first captured entry whose message contains substr,
// or zero-value if none.  Used to assert "the warning we expected fired"
// without locking on exact message strings.
func (l *testLogger) findEntry(substr string) (logEntry, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, e := range l.entries {
		if strings.Contains(e.msg, substr) {
			return e, true
		}
	}
	return logEntry{}, false
}

func (l *testLogger) count() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.entries)
}

// ---------------------------------------------------------------------------
// FetchGarden — happy path
// ---------------------------------------------------------------------------

func TestFetchGarden_HappyPath(t *testing.T) {
	t.Parallel()

	const body = `{
		"resources": [
			{
				"id": 1,
				"provider": "dmhy",
				"title": "[SubsPlease] Show - 01",
				"magnet": "magnet:?xt=urn:btih:abc",
				"size": 3460300,
				"createdAt": "2026-01-01T00:00:00Z",
				"fansub": {"name": "SubsPlease"}
			},
			{
				"id": 2,
				"provider": "moe",
				"title": "[喵萌奶茶屋] Other Show - 02",
				"magnet": "magnet:?xt=urn:btih:def",
				"size": 40448,
				"createdAt": "2026-01-02T00:00:00Z",
				"fansub": null
			}
		],
		"pagination": {"total": 2}
	}`

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Sanity: verify the query string we sent.
		assert.Equal(t, "naruto", r.URL.Query().Get("search"))
		assert.Equal(t, "动画", r.URL.Query().Get("type"))
		assert.Equal(t, "80", r.URL.Query().Get("pageSize"))
		assert.Equal(t, "AnimeGo/1.0", r.Header.Get("User-Agent"))
		assert.Equal(t, "application/json", r.Header.Get("Accept"))
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	httpClient, restore := redirectGarden(srv.URL)
	defer restore()

	log := &testLogger{}
	items, err := FetchGarden(context.Background(), httpClient, log, "naruto")

	require.NoError(t, err)
	require.Len(t, items, 2)
	assert.Equal(t, "[SubsPlease] Show - 01", items[0].Title)
	assert.Equal(t, "magnet:?xt=urn:btih:abc", items[0].Magnet)
	assert.Equal(t, SourceGarden, items[0].Source)
	require.NotNil(t, items[0].Fansub)
	assert.Equal(t, "SubsPlease", *items[0].Fansub)
	require.NotNil(t, items[0].Provider)
	assert.Equal(t, "dmhy", *items[0].Provider)
	assert.Equal(t, "3.5 GB", items[0].Size) // 3460300 KB → 3.46... → 3.5 GB
	require.NotNil(t, items[0].Date)
	assert.Equal(t, "2026-01-01T00:00:00Z", *items[0].Date)

	// Second item: fansub missing in upstream → falls back to bracket parse.
	require.NotNil(t, items[1].Fansub)
	assert.Equal(t, "喵萌奶茶屋", *items[1].Fansub)
	assert.Equal(t, "40 MB", items[1].Size) // 40448 KB → 40.448 MB → 40 MB

	assert.Equal(t, 0, log.count(), "no warnings on happy path with results")
}

// ---------------------------------------------------------------------------
// FetchGarden — empty resources triggers zero-result tripwire
// ---------------------------------------------------------------------------

func TestFetchGarden_EmptyResourcesLogsTripwire(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"resources": []}`))
	}))
	defer srv.Close()

	httpClient, restore := redirectGarden(srv.URL)
	defer restore()

	log := &testLogger{}
	items, err := FetchGarden(context.Background(), httpClient, log, "rare-show")

	require.NoError(t, err)
	assert.Empty(t, items)

	entry, ok := log.findEntry("zero-result")
	require.True(t, ok, "expected zero-result warning to fire, got %d entries", log.count())
	// Verify keyword args carry the query.
	require.GreaterOrEqual(t, len(entry.args), 2)
	assert.Equal(t, "query", entry.args[0])
	assert.Equal(t, "rare-show", entry.args[1])
}

// TestFetchGarden_EmptyResourcesWithBlankQueryNoLog verifies the tripwire
// is GATED on a non-empty query.  An aggregator with an empty query
// should be short-circuited upstream, but if FetchGarden is called
// directly with an empty term we don't want to spam logs.
func TestFetchGarden_EmptyResourcesBlankQueryNoLog(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"resources": []}`))
	}))
	defer srv.Close()

	httpClient, restore := redirectGarden(srv.URL)
	defer restore()

	log := &testLogger{}
	items, err := FetchGarden(context.Background(), httpClient, log, "   ")

	require.NoError(t, err)
	assert.Empty(t, items)
	assert.Equal(t, 0, log.count(), "blank query should not trigger tripwire")
}

// ---------------------------------------------------------------------------
// FetchGarden — error paths
// ---------------------------------------------------------------------------

func TestFetchGarden_Non2xxStatus(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		status int
	}{
		{"500", http.StatusInternalServerError},
		{"502", http.StatusBadGateway},
		{"503", http.StatusServiceUnavailable},
		{"400", http.StatusBadRequest},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.status)
			}))
			defer srv.Close()

			httpClient, restore := redirectGarden(srv.URL)
			defer restore()

			items, err := FetchGarden(context.Background(), httpClient, nil, "x")
			require.Error(t, err)
			assert.Empty(t, items)
			assert.Contains(t, err.Error(), "garden")
		})
	}
}

func TestFetchGarden_TransportError(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	url := srv.URL
	srv.Close()

	httpClient, restore := redirectGarden(url)
	defer restore()

	items, err := FetchGarden(context.Background(), httpClient, nil, "x")
	require.Error(t, err)
	assert.Empty(t, items)
	assert.Contains(t, err.Error(), "garden")
}

func TestFetchGarden_DecodeError(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`not json at all`))
	}))
	defer srv.Close()

	httpClient, restore := redirectGarden(srv.URL)
	defer restore()

	_, err := FetchGarden(context.Background(), httpClient, nil, "x")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "decode")
}

// ---------------------------------------------------------------------------
// FetchGarden — filter behaviour
// ---------------------------------------------------------------------------

func TestFetchGarden_NonMagnetItemsFiltered(t *testing.T) {
	t.Parallel()

	const body = `{
		"resources": [
			{"id": 1, "title": "[X] Real", "magnet": "magnet:?xt=urn:btih:abc", "size": 100, "createdAt": "t", "fansub": null},
			{"id": 2, "title": "[Y] No Magnet", "magnet": "https://example.com/torrent", "size": 100, "createdAt": "t", "fansub": null},
			{"id": 3, "title": "[Z] Empty Magnet", "magnet": "", "size": 100, "createdAt": "t", "fansub": null},
			{"id": 4, "title": "", "magnet": "magnet:?xt=urn:btih:def", "size": 100, "createdAt": "t", "fansub": null}
		]
	}`

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	httpClient, restore := redirectGarden(srv.URL)
	defer restore()

	items, err := FetchGarden(context.Background(), httpClient, nil, "x")
	require.NoError(t, err)
	require.Len(t, items, 1, "expected only the magnet-prefix + non-empty-title item")
	assert.Equal(t, "[X] Real", items[0].Title)
}

func TestFetchGarden_EmptyFansubObjectFallsBackToBracket(t *testing.T) {
	t.Parallel()

	const body = `{
		"resources": [
			{"id": 1, "title": "[SubsPlease] Show", "magnet": "magnet:?xt=abc", "size": 100, "createdAt": "t", "fansub": {"name": ""}}
		]
	}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	httpClient, restore := redirectGarden(srv.URL)
	defer restore()

	items, err := FetchGarden(context.Background(), httpClient, nil, "x")
	require.NoError(t, err)
	require.Len(t, items, 1)
	require.NotNil(t, items[0].Fansub)
	assert.Equal(t, "SubsPlease", *items[0].Fansub,
		"empty fansub.name should fall back to bracket parser")
}

// ---------------------------------------------------------------------------
// Format helpers + ParseFansub — bundled here per task brief
// ---------------------------------------------------------------------------

func TestFormatBytes(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		in   string
		want string
	}{
		{"empty", "", ""},
		{"zero", "0", ""},
		{"negative", "-100", ""},
		{"non-numeric", "abc", ""},
		{"small KB", "5000", "5 KB"},
		{"500 bytes → 1 KB rounded", "500", "1 KB"},
		{"exactly 1MB", "1000000", "1 MB"},
		{"1.5 MB → 2 MB rounded", "1500000", "2 MB"}, // toFixed(0) rounds half-to-even-ish; JS Math.round + toFixed(0)
		{"1 GB", "1000000000", "1.0 GB"},
		{"1.5 GB", "1500000000", "1.5 GB"},
		{"1234abc parses as 1234", "1234abc", "1 KB"},
	}
	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			assert.Equal(t, tc.want, FormatBytes(tc.in))
		})
	}
}

func TestFormatKb(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		in   string
		want string
	}{
		{"empty", "", ""},
		{"zero", "0", ""},
		{"negative", "-100", ""},
		{"500 raw KB", "500", "500 KB"},
		{"exactly 1000 KB → 1 MB", "1000", "1 MB"},
		{"40448 KB → 40 MB (AOT clip case)", "40448", "40 MB"},
		{"3460300 KB → 3.5 GB (AOT movie case)", "3460300", "3.5 GB"},
		{"1000000 KB → 1.0 GB", "1000000", "1.0 GB"},
	}
	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			assert.Equal(t, tc.want, FormatKb(tc.in))
		})
	}
}

func TestParseFansub(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		title string
		want  *string
	}{
		{"ASCII brackets", "[SubsPlease] Show - 01", strPtr("SubsPlease")},
		{"CJK brackets", "【喵萌奶茶屋】Show - 01", strPtr("喵萌奶茶屋")},
		{"no bracket → nil", "Show - 01 [1080p]", nil},
		{"empty title → nil", "", nil},
		{"only bracket prefix", "[OnlyMe]", strPtr("OnlyMe")},
		{"cross-bracket type still parses", "[FooBar】rest", strPtr("FooBar")},
	}
	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := ParseFansub(tc.title)
			if tc.want == nil {
				assert.Nil(t, got)
			} else {
				require.NotNil(t, got)
				assert.Equal(t, *tc.want, *got)
			}
		})
	}
}

// strPtr is a tiny helper for table-driven ParseFansub cases.  Keeps
// the want column readable without a per-case `s := "..."; &s` dance.
func strPtr(s string) *string { return &s }

// ---------------------------------------------------------------------------
// Helpers — package-level endpoint redirect
// ---------------------------------------------------------------------------

// redirectGarden swaps the package-level gardenEndpoint to the test
// server URL for the duration of one test, then restores the
// production value via the returned closure.  Avoids each test needing
// to thread a custom endpoint through FetchGarden's signature.
//
// We also return a *http.Client with no Timeout — the per-request ctx
// is authoritative.
func redirectGarden(url string) (*http.Client, func()) {
	// Monkey-patch via the package-level var.  gardenEndpoint is a
	// const in production for safety, so we use a small redirector
	// at the test layer: a transport that rewrites api.animes.garden
	// URLs to the test server's host.
	transport := &rewriteTransport{
		base:   http.DefaultTransport,
		target: url,
	}
	client := &http.Client{Transport: transport}
	return client, func() {}
}

// rewriteTransport rewrites every outgoing request's URL to point at
// the test server while preserving path + query.  This is the
// "swap-the-endpoint-without-changing-the-package-const" trick that
// keeps gardenEndpoint as a compile-time constant in production but
// still lets tests inject an httptest URL.
type rewriteTransport struct {
	base   http.RoundTripper
	target string // e.g. "http://127.0.0.1:53281"
}

func (t *rewriteTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	parsed, err := parseTarget(t.target)
	if err != nil {
		return nil, err
	}
	// Rewrite scheme + host, preserve everything else.
	req.URL.Scheme = parsed.scheme
	req.URL.Host = parsed.host
	req.Host = parsed.host
	return t.base.RoundTrip(req)
}

type parsedTarget struct {
	scheme string
	host   string
}

func parseTarget(s string) (parsedTarget, error) {
	// httptest URLs are always "http://<host>:<port>" — minimal
	// parsing keeps the helper one stdlib call deep.
	i := strings.Index(s, "://")
	if i < 0 {
		return parsedTarget{}, &urlParseErr{s: s}
	}
	return parsedTarget{scheme: s[:i], host: s[i+3:]}, nil
}

type urlParseErr struct{ s string }

func (e *urlParseErr) Error() string { return "test: bad target url: " + e.s }
