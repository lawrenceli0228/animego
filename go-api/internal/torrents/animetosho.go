// Package torrents — animetosho.go
//
// AnimeTosho (feed.animetosho.org) JSON fetcher.  AnimeTosho is a
// mirror/index that, uniquely among this package's sources, reports a
// live seeders/leechers count — so it is the one source that can feed the
// ranker a real "best copy" signal instead of nil.  It also exposes an
// AniDB-id feed, letting a later handler pull a show's entire release
// history by ID rather than fuzzy keyword matching.
//
// Endpoint shape (JSON, no Cloudflare — HK can dial it directly):
//
//	GET https://feed.animetosho.org/json?q=<keyword>&only_tor=1
//	GET https://feed.animetosho.org/json?aid=<AniDB-id>&only_tor=1
//
//	[
//	  {
//	    "title": "[SubsPlease] ... (1080p) [HASH].mkv",
//	    "magnet_uri": "magnet:?xt=urn:btih:...&tr=...",   // ready to use
//	    "info_hash": "0123...abcdef",
//	    "seeders": 42,
//	    "leechers": 3,
//	    "total_size": 1500000000,                          // bytes
//	    "timestamp": 1735689600,                           // unix seconds
//	    "anidb_aid": 17389
//	  }
//	]
//
// only_tor=1 restricts the feed to torrent rows (the only kind we map).
//
// Mapping:
//   - title    → title
//   - magnet   → magnet_uri (verbatim; already a usable magnet — rows
//     without a "magnet:" scheme are dropped, same filter as every source)
//   - infohash → info_hash
//   - seeders  → &seeders (the one source that populates this)
//   - size     → FormatBytes(total_size)   (bytes → "X.X GB")
//   - date     → RFC3339(timestamp)         (so rank.go's RFC3339 layout
//     parses it for date ordering; 0 / negative → nil)
//   - source   → SourceTosho
//
// Unlike the RSS scrapes this source DOES implement Capable
// (SupportsSeeders) and advertises a positive Priority so its
// seeder-bearing rows win ranker tie-breaks over the seeder-less sources.
package torrents

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// SourceTosho is feed.animetosho.org — JSON index that reports seeders
// and exposes an AniDB-id feed.  Declared here (not types.go) because
// AnimeTosho is this file's source.
const SourceTosho Source = "tosho"

// toshoEndpoint is AnimeTosho's JSON feed.  Both the keyword search
// (?q=) and the AniDB-id feed (?aid=) ride on this path.
const toshoEndpoint = "https://feed.animetosho.org/json"

// toshoPriority is the ranker Priority AnimeTosho advertises via
// Capabilities.  It is a modest positive value: every other source in
// this package advertises 0 (the neutral default), so any positive
// number makes Tosho's rows win the source tie-break in dedup/rank — the
// intent being "when the same torrent is surfaced by Tosho and a
// seeder-less source, prefer the copy that carries a real seeder count".
const toshoPriority = 10

// animeToshoSource is the Fetcher adapter for feed.animetosho.org.  Thin
// struct in the gardenSource mould: it binds the shared *http.Client +
// optional Logger and delegates to FetchAnimeTosho.
//
// It carries a logger (like gardenSource, unlike the RSS scrapes) so the
// JSON silent-failure tripwire (200 OK + zero rows for a non-empty query)
// is searchable.  It also implements Capable — see Capabilities below.
type animeToshoSource struct {
	client *http.Client
	logger Logger
}

func (s animeToshoSource) Name() Source { return SourceTosho }

func (s animeToshoSource) Fetch(ctx context.Context, q string) ([]TorrentItem, error) {
	return FetchAnimeTosho(ctx, s.client, s.logger, q)
}

// Capabilities advertises that AnimeTosho can populate a seeder count and
// that its rows should outrank the seeder-less sources on a tie.  This is
// the only Capable implementation in the package — the RSS scrapes and
// garden deliberately stay on the zero default.
func (s animeToshoSource) Capabilities() Capabilities {
	return Capabilities{
		SupportsSeeders: true,
		Priority:        toshoPriority,
	}
}

// toshoEntry is the minimal field set decoded from each object in the
// AnimeTosho JSON array.  Unknown fields are dropped by encoding/json —
// AnimeTosho carries many more columns we don't need, and new ones must
// not break the decode.
type toshoEntry struct {
	Title     string `json:"title"`
	MagnetURI string `json:"magnet_uri"`
	InfoHash  string `json:"info_hash"`
	Seeders   *int   `json:"seeders"`
	TotalSize int64  `json:"total_size"`
	Timestamp int64  `json:"timestamp"`
	AnidbAID  int    `json:"anidb_aid"`
}

// FetchAnimeTosho hits AnimeTosho's JSON feed for a keyword search,
// decodes the array, maps each entry to a TorrentItem, and returns the
// filtered slice.
//
// Error behaviour matches the other fetchers:
//   - Network / transport error → (nil, err)
//   - Non-2xx status            → (nil, err) carrying the status
//   - Decode failure            → (nil, wrapped json error)
//   - Rows without a magnet: prefix are filtered out (silent drop)
//
// Silent-failure tripwire: a 200 with zero mapped rows for a non-empty
// query is the "tosho quietly broke" signal (schema change, route moved);
// it is logged via the optional Logger (nil skips logging), mirroring
// FetchGarden.
func FetchAnimeTosho(ctx context.Context, httpClient *http.Client, log Logger, q string) ([]TorrentItem, error) {
	endpoint, err := buildToshoSearchURL(q)
	if err != nil {
		return nil, fmt.Errorf("tosho: build url: %w", err)
	}

	items, err := fetchTosho(ctx, httpClient, endpoint)
	if err != nil {
		return nil, err
	}

	// Silent-failure tripwire — same shape as FetchGarden's.
	if len(items) == 0 && strings.TrimSpace(q) != "" && log != nil {
		log.Warn("tosho: zero-result for non-empty query", "query", q)
	}

	return items, nil
}

// FetchAnimeToshoByAniDB hits AnimeTosho's JSON feed for a show's full
// AniDB-id feed (?aid=<aid>), decodes the array, and returns the mapped
// TorrentItems.  This is the ID-keyed counterpart to FetchAnimeTosho's
// keyword search — a later handler can use it to list a show's entire
// release history without fuzzy title matching.
//
// Exported for that future handler; nothing wires it into the aggregator
// in this change (the aggregator fan-out is keyword-only).  Error
// behaviour matches FetchAnimeTosho minus the zero-result tripwire (an
// empty aid feed is a legitimate "no releases for this id", not a
// breakage signal).
func FetchAnimeToshoByAniDB(ctx context.Context, httpClient *http.Client, aid int) ([]TorrentItem, error) {
	endpoint, err := buildToshoAniDBURL(aid)
	if err != nil {
		return nil, fmt.Errorf("tosho: build aid url: %w", err)
	}
	return fetchTosho(ctx, httpClient, endpoint)
}

// fetchTosho performs the shared HTTP GET + JSON decode + mapping for both
// the keyword and AniDB-id endpoints.  Centralised so the two public entry
// points share one transport/error path (the only difference between them
// is the URL and the keyword-only tripwire layered on top by the caller).
func fetchTosho(ctx context.Context, httpClient *http.Client, endpoint string) ([]TorrentItem, error) {
	if httpClient == nil {
		httpClient = http.DefaultClient
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("tosho: build request: %w", err)
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept", "application/json")

	res, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("tosho: http do: %w", err)
	}
	defer func() {
		_, _ = io.Copy(io.Discard, res.Body)
		_ = res.Body.Close()
	}()

	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("tosho: upstream status %d", res.StatusCode)
	}

	var entries []toshoEntry
	if err := json.NewDecoder(res.Body).Decode(&entries); err != nil {
		return nil, fmt.Errorf("tosho: decode response: %w", err)
	}

	return mapToshoEntries(entries), nil
}

// buildToshoSearchURL composes the keyword-search URL: ?q=<q>&only_tor=1.
// url.Values handles escaping so spaces / brackets / CJK survive intact.
func buildToshoSearchURL(q string) (string, error) {
	u, err := url.Parse(toshoEndpoint)
	if err != nil {
		return "", err
	}
	vals := u.Query()
	vals.Set("q", q)
	vals.Set("only_tor", "1")
	u.RawQuery = vals.Encode()
	return u.String(), nil
}

// buildToshoAniDBURL composes the AniDB-id feed URL: ?aid=<aid>&only_tor=1.
func buildToshoAniDBURL(aid int) (string, error) {
	u, err := url.Parse(toshoEndpoint)
	if err != nil {
		return "", err
	}
	vals := u.Query()
	vals.Set("aid", strconv.Itoa(aid))
	vals.Set("only_tor", "1")
	u.RawQuery = vals.Encode()
	return u.String(), nil
}

// mapToshoEntries converts decoded AnimeTosho entries into TorrentItems
// and filters out rows without a usable magnet URI.  Extracted so the
// field-mapping (especially the seeders + timestamp handling) is unit
// testable independently of the HTTP plumbing.
func mapToshoEntries(entries []toshoEntry) []TorrentItem {
	out := make([]TorrentItem, 0, len(entries))
	for _, e := range entries {
		if e.Title == "" || !hasMagnetScheme(e.MagnetURI) {
			continue
		}

		out = append(out, TorrentItem{
			Title:    e.Title,
			Magnet:   e.MagnetURI,
			Size:     FormatBytes(strconv.FormatInt(e.TotalSize, 10)),
			Date:     toshoDate(e.Timestamp),
			Source:   SourceTosho,
			Seeders:  copySeeders(e.Seeders),
			Infohash: strings.ToLower(strings.TrimSpace(e.InfoHash)),
		})
	}
	return out
}

// toshoDate formats a unix-seconds timestamp as RFC3339 (UTC) so rank.go's
// RFC3339 layout can parse it for date ordering.  A non-positive timestamp
// (absent / zero) yields nil → JSON null, matching the "no date" signal the
// other sources produce via stringPtr("").
func toshoDate(ts int64) *string {
	if ts <= 0 {
		return nil
	}
	s := time.Unix(ts, 0).UTC().Format(time.RFC3339)
	return &s
}

// copySeeders returns a fresh *int copy of the decoded seeders pointer so
// the TorrentItem never aliases the decoder's storage.  nil (the source
// omitted seeders) stays nil — the ranker treats that as "unknown" and
// sinks it, distinct from a genuine 0.
func copySeeders(s *int) *int {
	if s == nil {
		return nil
	}
	v := *s
	return &v
}
