// Package torrents — mikan_bangumi_test.go
//
// Covers FetchMikanByBangumi, the per-bangumi Mikan feed, and the
// aggregator's runner for it (runMikanBangumi):
//   - parsing a feed shaped like the live one (no xmlns:torrent on <rss>,
//     <guid>/<description> per item, the <torrent> element declaring its
//     own namespace, a real enclosure length), through the same mapping as
//     the keyword search
//   - the size bound: a feed cut at the bound keeps the complete items
//     before the cut, the newest; a cut before the first item, or a feed
//     the upstream itself truncated, is an error
//   - non-2xx, an invalid id (no request sent)
//   - the throttle path: the feed goes through SourceMikan's limiter, and
//     a failed wait is logged and yields nothing without fetching
package torrents

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/time/rate"
)

// mikanBangumiHeader / Footer frame a per-bangumi feed exactly as Mikan
// serves it: one line, no xmlns:torrent on <rss>.
const mikanBangumiHeader = `<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel>` +
	`<title>Mikan Project - 葬送的芙莉莲 第二季</title>` +
	`<link>http://mikanani.me/RSS/Bangumi?bangumiId=3821</link>` +
	`<description>Mikan Project - 葬送的芙莉莲 第二季</description>`

const mikanBangumiFooter = `</channel></rss>`

// mikanBangumiItem renders one <item> the way the live feed does.
func mikanBangumiItem(title, hash, day, pubDate string, size int64) string {
	return fmt.Sprintf(`<item><guid isPermaLink="false">%[1]s</guid>`+
		`<link>https://mikanani.me/Home/Episode/%[2]s</link>`+
		`<title>%[1]s</title>`+
		`<description>%[1]s[%.1[5]f GB]</description>`+
		`<torrent xmlns="https://mikanani.me/0.1/">`+
		`<link>https://mikanani.me/Home/Episode/%[2]s</link>`+
		`<contentLength>%[6]d</contentLength>`+
		`<pubDate>%[4]s</pubDate></torrent>`+
		`<enclosure type="application/x-bittorrent" length="%[6]d" url="https://mikanani.me/Download/%[3]s/%[2]s.torrent" /></item>`,
		title, hash, day, pubDate, float64(size)/(1<<30), size)
}

// Three releases from the live feed for Mikan bangumi 3821, newest first.
var liveShapedTitles = []string{
	"[H-Enc] 葬送的芙莉莲 第二季 / Sousou no Frieren 2nd Season (BDRip 1080p HEVC FLAC)",
	"[Zzz睡不醒][葬送的芙莉莲 第二季][Sousou no Frieren 2nd Season][01-10][BDRip][1080P][HEVC-10bit][简繁日内封][MKV]",
	"[黒ネズミたち] 葬送的芙莉莲 第二季 / Sousou no Frieren 2nd Season - 01 (B-Global 1920x1080 HEVC AAC MKV)",
}

var liveShapedItems = []string{
	mikanBangumiItem(liveShapedTitles[0], "f7f11b17b95b00313ededdeb0d2c2057c13309e9", "20260812", "2026-08-12T06:12:15.638227", 28239409152),
	mikanBangumiItem(liveShapedTitles[1], "1f01b9c6de60857a5ba31a484e583c71956cdf8b", "20260811", "2026-08-11T20:38:49.159419", 12562779136),
	mikanBangumiItem(liveShapedTitles[2], "7030548894099d9e0de029090ddc5921c1e0fe9a", "20260116", "2026-01-16T23:00:51.165589", 494927872),
}

func mikanBangumiFeed(items ...string) string {
	return mikanBangumiHeader + strings.Join(items, "") + mikanBangumiFooter
}

// serveFeed answers every request with body and counts the requests.
func serveFeed(t *testing.T, body string) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		w.Header().Set("Content-Type", "application/xml; charset=utf-8")
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return srv, &hits
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

func TestFetchMikanByBangumi_ParsesTheFeed(t *testing.T) {
	t.Parallel()

	body := mikanBangumiFeed(liveShapedItems...)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "/RSS/Bangumi", r.URL.Path)
		assert.Equal(t, "3821", r.URL.Query().Get("bangumiId"))
		assert.Equal(t, "AnimeGo/1.0", r.Header.Get("User-Agent"))
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	items, err := FetchMikanByBangumi(context.Background(), newRewriteClient(srv.URL), 3821)
	require.NoError(t, err)
	require.Len(t, items, 3)

	first := items[0]
	assert.Equal(t, liveShapedTitles[0], first.Title)
	assert.Equal(t, SourceMikan, first.Source, "per-bangumi rows are Mikan rows, ranked and deduped as such")
	assert.True(t, strings.HasPrefix(first.Magnet, "magnet:?xt=urn:btih:f7f11b17b95b00313ededdeb0d2c2057c13309e9&dn="),
		"magnet synthesised from the hash in the .torrent URL, as for the keyword feed")
	// Size from <torrent><contentLength> through FormatBytes, which counts
	// in decimal units (Mikan's own <description> says "26.3 GB", binary).
	assert.Equal(t, "28.2 GB", first.Size)
	require.NotNil(t, first.Date)
	assert.Equal(t, "2026-08-12T06:12:15.638227", *first.Date, "no channel pubDate → the namespaced torrent pubDate")
	require.NotNil(t, first.Fansub)
	assert.Equal(t, "H-Enc", *first.Fansub)
	assert.Nil(t, first.Seeders)
	assert.Nil(t, first.Provider)

	require.NotNil(t, items[1].Fansub)
	assert.Equal(t, "Zzz睡不醒", *items[1].Fansub)
	assert.Equal(t, "495 MB", items[2].Size)
	assert.True(t, strings.HasPrefix(items[2].Magnet, "magnet:?xt=urn:btih:7030548894099d9e0de029090ddc5921c1e0fe9a"))
}

func TestBuildMikanBangumiURL(t *testing.T) {
	t.Parallel()

	got, err := buildMikanBangumiURL(3821)
	require.NoError(t, err)
	assert.Equal(t, "https://mikanani.me/RSS/Bangumi?bangumiId=3821", got)
}

// ---------------------------------------------------------------------------
// Size bound
// ---------------------------------------------------------------------------

// The cut is exact: complete items before it are kept, the one it splits
// is dropped, and a cut before the first item fails the fetch.
func TestFetchMikanBangumi_CutsAtTheByteBound(t *testing.T) {
	t.Parallel()

	body := mikanBangumiFeed(liveShapedItems...)
	srv, _ := serveFeed(t, body)
	client := newRewriteClient(srv.URL)

	endOfSecond := int64(len(mikanBangumiHeader) + len(liveShapedItems[0]) + len(liveShapedItems[1]))
	cases := []struct {
		name      string
		maxBytes  int64
		wantItems int
	}{
		{"the whole feed fits", int64(len(body)), 3},
		{"cut inside the third item", endOfSecond + 100, 2},
		{"cut right after the second item", endOfSecond, 2},
		{"cut inside the first item", int64(len(mikanBangumiHeader)) + 50, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			items, err := fetchMikanBangumi(context.Background(), client, 3821, tc.maxBytes)
			if tc.wantItems == 0 {
				require.Error(t, err, "a cut that leaves no complete item is a failure, not an empty feed")
				assert.Contains(t, err.Error(), "mikan")
				return
			}
			require.NoError(t, err)
			require.Len(t, items, tc.wantItems)
			for i, it := range items {
				assert.Equal(t, liveShapedTitles[i], it.Title, "item %d is the feed's item %d, in order", i, i)
			}
		})
	}
}

// With the production bound: a feed far longer than mikanBangumiMaxBytes
// comes back as its newest items, in feed order, with no error.
func TestFetchMikanByBangumi_KeepsTheNewestItemsOfAnOversizedFeed(t *testing.T) {
	t.Parallel()

	var items []string
	size := len(mikanBangumiHeader) + len(mikanBangumiFooter)
	for i := 0; size <= mikanBangumiMaxBytes+mikanBangumiMaxBytes/4; i++ {
		item := mikanBangumiItem(fmt.Sprintf("[Group] Long Show - %04d [1080p]", i),
			fmt.Sprintf("%040x", i+1), "20260101", "2026-01-01T00:00:00", 1<<30)
		items = append(items, item)
		size += len(item)
	}
	srv, _ := serveFeed(t, mikanBangumiFeed(items...))

	got, err := FetchMikanByBangumi(context.Background(), newRewriteClient(srv.URL), 228)
	require.NoError(t, err, "an oversized feed is cut, not failed")
	require.NotEmpty(t, got)
	assert.Less(t, len(got), len(items), "the items past the bound are not read")
	for i, it := range got {
		require.Equal(t, fmt.Sprintf("[Group] Long Show - %04d [1080p]", i), it.Title,
			"the kept items are the feed's first (newest) ones, in order")
	}
}

// stalledFeed serves the first two items, then holds the response open
// until the client gives up, as a slow upstream does mid-feed.
func stalledFeed(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(mikanBangumiHeader + liveShapedItems[0] + liveShapedItems[1]))
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	t.Cleanup(srv.Close)
	return srv
}

// The request's deadline is the other budget a long feed can run into.  It
// cuts the feed like the size bound does: the complete items read by then,
// the newest, come back without an error.
func TestFetchMikanByBangumi_DeadlineKeepsTheItemsReadSoFar(t *testing.T) {
	t.Parallel()

	srv := stalledFeed(t)
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()

	items, err := FetchMikanByBangumi(ctx, newRewriteClient(srv.URL), 3821)
	require.NoError(t, err)
	require.Len(t, items, 2)
	assert.Equal(t, liveShapedTitles[0], items[0].Title)
	assert.Equal(t, liveShapedTitles[1], items[1].Title)
}

// The keyword search keeps its old contract on the same stall: an error.
func TestFetchMikan_KeywordSearchStillFailsOnADeadline(t *testing.T) {
	t.Parallel()

	srv := stalledFeed(t)
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()

	items, err := FetchMikan(ctx, newRewriteClient(srv.URL), "frieren")
	require.Error(t, err)
	assert.Empty(t, items)
}

// The size bound is the per-bangumi feed's alone: a keyword search reads
// its whole response, however long, as it always has.
func TestFetchMikan_KeywordSearchIsNotBounded(t *testing.T) {
	t.Parallel()

	var items []string
	size := 0
	for i := 0; size <= 2*mikanBangumiMaxBytes; i++ {
		item := mikanBangumiItem(fmt.Sprintf("[Group] Long Show - %04d [1080p]", i),
			fmt.Sprintf("%040x", i+1), "20260101", "2026-01-01T00:00:00", 1<<30)
		items = append(items, item)
		size += len(item)
	}
	srv, _ := serveFeed(t, mikanBangumiFeed(items...))

	got, err := FetchMikan(context.Background(), newRewriteClient(srv.URL), "long show")
	require.NoError(t, err)
	assert.Len(t, got, len(items))
}

// A feed the upstream itself cut short (the connection dropped mid-item)
// is an error even though complete items precede the break: only the
// bound and the deadline we impose turn a cut into a shorter result.
func TestFetchMikanByBangumi_UpstreamTruncationIsAnError(t *testing.T) {
	t.Parallel()

	half := liveShapedItems[1][:len(liveShapedItems[1])/2]
	srv, _ := serveFeed(t, mikanBangumiHeader+liveShapedItems[0]+half)

	items, err := FetchMikanByBangumi(context.Background(), newRewriteClient(srv.URL), 3821)
	require.Error(t, err)
	assert.Empty(t, items)
	assert.Contains(t, err.Error(), "decode")
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

func TestFetchMikanByBangumi_Non2xxStatus(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte("<html>busy</html>"))
	}))
	defer srv.Close()

	items, err := FetchMikanByBangumi(context.Background(), newRewriteClient(srv.URL), 3821)
	require.Error(t, err)
	assert.Empty(t, items)
	assert.Contains(t, err.Error(), "mikan")
	assert.Contains(t, err.Error(), "503")
}

func TestFetchMikanByBangumi_InvalidIDSendsNoRequest(t *testing.T) {
	t.Parallel()

	srv, hits := serveFeed(t, mikanBangumiFeed(liveShapedItems...))
	for _, id := range []int{0, -1} {
		_, err := FetchMikanByBangumi(context.Background(), newRewriteClient(srv.URL), id)
		require.Error(t, err, "id %d", id)
	}
	assert.Zero(t, hits.Load(), "an invalid id must not reach the upstream")
}

// ---------------------------------------------------------------------------
// Throttle path (runMikanBangumi)
// ---------------------------------------------------------------------------

// The feed goes through SourceMikan's limiter, the one Mikan's keyword
// search uses, and no other source's.
func TestRunMikanBangumi_DrawsOnMikansBucket(t *testing.T) {
	t.Parallel()

	var fetched atomic.Int32
	a := &Aggregator{mikanBangumiFn: func(_ context.Context, id int) ([]TorrentItem, error) {
		fetched.Add(1)
		return []TorrentItem{stubItem(SourceMikan)}, nil
	}}
	WithSourceRate(rate.Every(time.Hour), 1)(a) // one token per source, no refill in test time

	out := a.runMikanBangumi(context.Background(), 3821)
	require.Len(t, out, 1)
	assert.Equal(t, int32(1), fetched.Load())

	assert.False(t, a.limiterFor(SourceMikan).Allow(), "the feed must have spent Mikan's token")
	assert.True(t, a.limiterFor(SourceTosho).Allow(), "other sources' buckets are untouched")
}

// With Mikan's bucket empty and a deadline the refill cannot meet, the wait
// fails: nothing is fetched, the result is empty, and the abort is logged.
func TestRunMikanBangumi_WaitAborted_GracefulEmptyAndLogged(t *testing.T) {
	t.Parallel()

	log := &testLogger{}
	var fetched atomic.Int32
	a := &Aggregator{logger: log, mikanBangumiFn: func(_ context.Context, _ int) ([]TorrentItem, error) {
		fetched.Add(1)
		return []TorrentItem{stubItem(SourceMikan)}, nil
	}}
	WithSourceRate(rate.Every(time.Hour), 1)(a)
	require.True(t, a.limiterFor(SourceMikan).Allow(), "drain Mikan's only token, as a keyword search would")

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	var out []TorrentItem
	require.NotPanics(t, func() { out = a.runMikanBangumi(ctx, 3821) })

	assert.Empty(t, out)
	assert.Zero(t, fetched.Load(), "the feed must not be fetched once the throttle wait has failed")
	entry, found := log.findEntry("mikan bangumi-feed rate-limit wait aborted")
	require.True(t, found)
	assert.Equal(t, []any{"mikan_id", 3821}, entry.args[:2])
}

// A feed cut by the deadline still returns its items, and says so in the
// log, so a short Mikan list can be traced to it.
func TestRunMikanBangumi_LogsADeadlineCut(t *testing.T) {
	t.Parallel()

	log := &testLogger{}
	a := &Aggregator{logger: log, mikanBangumiFn: func(ctx context.Context, _ int) ([]TorrentItem, error) {
		<-ctx.Done()
		return []TorrentItem{stubItem(SourceMikan)}, nil
	}}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	out := a.runMikanBangumi(ctx, 3821)
	require.Len(t, out, 1)
	entry, found := log.findEntry("mikan bangumi-feed stopped at its deadline")
	require.True(t, found)
	assert.Equal(t, []any{"mikan_id", 3821, "kept", 1}, entry.args)
}

func TestRunMikanBangumi_FetchErrorIsLoggedAndEmpty(t *testing.T) {
	t.Parallel()

	log := &testLogger{}
	a := &Aggregator{logger: log, mikanBangumiFn: func(_ context.Context, _ int) ([]TorrentItem, error) {
		return nil, fmt.Errorf("mikan: upstream status 503")
	}}

	out := a.runMikanBangumi(context.Background(), 3821)
	assert.Empty(t, out)
	_, found := log.findEntry("mikan bangumi-feed failed")
	assert.True(t, found)
}
