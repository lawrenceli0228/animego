// Package torrents — garden_test.go
//
// Covers:
//   - happy path (valid JSON → parsed items, ordered as upstream returned)
//   - empty resources for non-empty query → empty slice + zero-result log
//   - non-2xx upstream status → empty slice + error
//   - transport / network error → empty slice + error
//   - fansub fallback to ParseFansub when r.fansub is missing
//   - non-magnet protocol items dropped from result
//   - FormatBinaryBytes / ParseFansub helpers (bundled here per
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
				"size": 3460300800,
				"createdAt": "2026-01-01T00:00:00Z",
				"fansub": {"name": "SubsPlease"}
			},
			{
				"id": 2,
				"provider": "moe",
				"title": "[喵萌奶茶屋] Other Show - 02",
				"magnet": "magnet:?xt=urn:btih:def",
				"size": 40448000,
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
	assert.Equal(t, "3.2 GiB", items[0].Size) // 3460300800 / 1024^3 = 3.22
	require.NotNil(t, items[0].Date)
	assert.Equal(t, "2026-01-01T00:00:00Z", *items[0].Date)

	// Second item: fansub missing in upstream → falls back to bracket parse.
	require.NotNil(t, items[1].Fansub)
	assert.Equal(t, "喵萌奶茶屋", *items[1].Fansub)
	assert.Equal(t, "38.6 MiB", items[1].Size) // 40448000 / 1024^2 = 38.57

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
// FetchGarden — size unit
// ---------------------------------------------------------------------------

// TestMapGardenResources_SizeIsBytes pins garden's size unit with values
// observed on 2026-10-31: the same torrents (matched by infohash) read from
// api.animes.garden/resources?search=Sousou+no+Frieren+2nd+Season and from
// Nyaa's RSS for the same search.  Garden's raw number is the byte count —
// Nyaa's GiB/MiB figure times 1024^3 / 1024^2 — so formatting it as KB
// printed a 568 MiB episode as "595.6 GB".  Formatted in binary units, the
// garden row now reads exactly like Nyaa's row for the same infohash.
func TestMapGardenResources_SizeIsBytes(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		rawSize string // garden's size field, verbatim
		nyaa    string // Nyaa's <nyaa:size> for the same infohash
	}{
		{"BDRip batch", "28239409152", "26.3 GiB"},
		{"1080p HEVC episode", "595591168", "568.0 MiB"},
		{"1080p HEVC episode, other group", "673710080", "642.5 MiB"},
	}
	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			items := mapGardenResources([]gardenResource{{
				Title:  "[X] Show - 01",
				Magnet: "magnet:?xt=urn:btih:abc",
				Size:   []byte(tc.rawSize),
			}})
			require.Len(t, items, 1)
			assert.Equal(t, tc.nyaa, items[0].Size, "garden %s bytes must read as Nyaa's %s", tc.rawSize, tc.nyaa)
		})
	}
}

// ---------------------------------------------------------------------------
// Format helpers + ParseFansub — bundled here per task brief
// ---------------------------------------------------------------------------

func TestFormatBinaryBytes(t *testing.T) {
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
		{"dmhy's placeholder length 1 is unknown", "1", ""},
		{"just under 1 KiB is unknown", "1023", ""},
		{"exactly 1 KiB", "1024", "1.0 KiB"},
		{"KiB with a decimal", "5000", "4.9 KiB"},
		{"just under 1 MiB stays KiB", "1048575", "1024.0 KiB"},
		{"exactly 1 MiB", "1048576", "1.0 MiB"},
		{"Nyaa 568.0 MiB", "595591168", "568.0 MiB"},
		{"exactly 1 GiB", "1073741824", "1.0 GiB"},
		{"Nyaa 26.3 GiB", "28239409152", "26.3 GiB"},
		{"exactly 1 TiB", "1099511627776", "1.0 TiB"},
		{"TiB is the last unit", "1125899906842624", "1024.0 TiB"},
		{"1234567abc parses as 1234567", "1234567abc", "1.2 MiB"},
	}
	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			assert.Equal(t, tc.want, FormatBinaryBytes(tc.in))
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
		{"no bracket, no scene ending → nil", "Show - 01 [1080p]", nil},
		{"empty title → nil", "", nil},
		{"only bracket prefix", "[OnlyMe]", strPtr("OnlyMe")},
		{"cross-bracket type still parses", "[FooBar】rest", strPtr("FooBar")},

		// Scene-style names carry the group at the end instead.  Titles as
		// Nyaa listed them, 2026-10-31.
		{"scene: codec-group, notes after", "Frieren Beyond Journeys End S02E10 MULTi AD 1080p CR WEB-DL AAC2.0 x264-Tsundere-Raws (VF, FRENCH, VOSTFR)", strPtr("Tsundere-Raws")},
		{"scene: space then -group, two notes", "Frieren Beyond Journey's End S02E09 VOSTFR 1080p WEB x264 AAC -Tsundere-Raws (CR) (Sousou no Frieren 2nd Season)", strPtr("Tsundere-Raws")},
		{"scene: H.264-group", "Re ZERO Starting Life in Another World S04E18 Ram 1080p CR WEB-DL MULTi AAC2.0 H.264-VARYG (Re:Zero kara Hajimeru Isekai Seikatsu 4th Season, Multi-Audio, Multi-Subs)", strPtr("VARYG")},
		{"scene: H 264-group", "SPY x FAMILY S03E12 Battle to the Death in the Sewers 1080p CR WEB-DL DUAL AAC2.0 H 264-VARYG (SPY×FAMILY Season 3, Dual-Audio, Multi-Subs)", strPtr("VARYG")},
		{"scene: dotted name", "The.Apothecary.Diaries.S03E02.MULTi.AD.1080p.WEBRiP.x265-KAF", strPtr("KAF")},
		{"scene: channels-group", "The Demon Girl Next Door S00 (Machikado Mazoku Mini) 1080p BluRay REMUX AVC FLAC 2.0-StaFer", strPtr("StaFer")},
		{"scene: dotted channels-group", "Inukami!.The.Movie.2007.REPACK.1080p.BluRay.Remux.AVC.DTS-HD.MA.5.1-Headpatter", strPtr("Headpatter")},
		{"scene: language-group", "Bubblegum.Crisis.OVA.1987-1991.BDrip.1080p.x264.AC3.Opus.MULTi.VOSTFR-Tinosoft", strPtr("Tinosoft")},
		{"scene: file extension", "Show.S01E01.1080p.WEB.H264-GRP.mkv", strPtr("GRP")},

		// What ends a name after a hyphen without being a group.
		{"WEB-DL is not a group", "Show S01E01 1080p WEB-DL", nil},
		{"Blu-ray is not a group", "Show Season 1 Blu-ray", nil},
		{"a hyphenated title word is not a group", "Kaguya-sama Love is War - Ultra-Romantic", nil},
		{"an episode dash is not a group", "Aikatsu! Encore - 004 (TVer 1920x1080 AVC AAC)", nil},
		{"a range is not a group", "Goldfish Warning 1-36 (Bluray 480p)", nil},
		// A leading bracket group wins over a scene ending.
		{"bracket group first", "[Erai-raws] Show - 01 [1080p CR WEB-DL AVC AAC] x264-NotThis", strPtr("Erai-raws")},
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
