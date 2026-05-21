// Package torrents — garden.go
//
// animes.garden JSON fetcher.  Port of fetchAnimeGarden from
// server/controllers/anime.controller.js:216-253.
//
// animes.garden is a JSON aggregator that already covers 动漫花园
// (dmhy) + bangumi.moe + others, with structured fansub objects and
// direct magnet URLs.  Replaces the legacy direct-RSS dmhy scrape.
//
// Endpoint shape (minimal required fields):
//
//	GET https://api.animes.garden/resources?search=<term>&type=动画&pageSize=80
//
//	{
//	  "resources": [
//	    {
//	      "id": 123,
//	      "provider": "dmhy",
//	      "title": "[SubsPlease] ...",
//	      "magnet": "magnet:?xt=...",
//	      "size": 1234567,        // KB (verified upstream behaviour)
//	      "createdAt": "2026-01-01T00:00:00Z",
//	      "fansub": { "name": "SubsPlease" }
//	    }
//	  ]
//	}
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
)

// gardenEndpoint is the production animes.garden resources URL.  Kept
// as a package-level var (not const) so tests can override it via the
// fetcher's httptest URL through the public FetchGarden signature.
const gardenEndpoint = "https://api.animes.garden/resources"

// gardenPageSize matches Express's ANIME_GARDEN_PAGE_SIZE (80).  This
// is high enough that one query covers an entire season's worth of
// releases for most shows without paginating.
const gardenPageSize = 80

// gardenType is the resource-type filter sent to animes.garden.  The
// literal "动画" (Chinese: "anime") is required by the upstream — using
// the romanised "anime" returns zero rows.
const gardenType = "动画"

// userAgent is the User-Agent header sent to every upstream.  Express
// uses "AnimeGo/1.0" exactly; we mirror it for parity in upstream logs.
const userAgent = "AnimeGo/1.0"

// gardenResource is the minimal field set we decode from each item in
// the upstream resources array.  Unknown fields are silently dropped by
// encoding/json — animes.garden adds new fields freely and we don't
// want the decoder to fail when it does.
type gardenResource struct {
	ID        int             `json:"id"`
	Provider  string          `json:"provider"`
	Title     string          `json:"title"`
	Magnet    string          `json:"magnet"`
	Size      json.RawMessage `json:"size"` // raw so we can accept number or string
	CreatedAt string          `json:"createdAt"`
	Fansub    *gardenFansub   `json:"fansub"`
}

// gardenFansub is the structured fansub object some upstream submitters
// provide.  When absent, fetchGarden falls back to bracket parsing on
// the title — matches Express's `r.fansub?.name ?? parseFansub(...)`.
type gardenFansub struct {
	Name string `json:"name"`
}

// gardenResponse is the top-level shape of /resources.
type gardenResponse struct {
	Resources []gardenResource `json:"resources"`
}

// FetchGarden hits the animes.garden /resources endpoint with the
// given search term, decodes the JSON response, maps each resource to
// a TorrentItem, and returns the filtered slice.
//
// Error behaviour (matches Express semantics):
//   - Network or transport error → returns (nil, err) so the aggregator
//     can log the failure.  Aggregator turns this into an empty slice
//     for that source — other sources' results still flow through.
//   - Non-2xx status → returns (nil, ErrUpstream) carrying the status.
//   - Decode failure → returns (nil, wrapped json error).
//   - Items without a magnet: prefix are filtered out (silent drop).
//
// Silent-failure tripwire: when the upstream returns 200 with an empty
// resources array AND the query is non-empty, log a warning via the
// optional Logger.  This is the shape of "garden quietly broke"
// (schema change, route moved, global filter regression) — Express
// emits `console.warn` here.  Pass nil to skip logging.
func FetchGarden(ctx context.Context, httpClient *http.Client, log Logger, q string) ([]TorrentItem, error) {
	if httpClient == nil {
		httpClient = http.DefaultClient
	}

	endpoint, err := buildGardenURL(q)
	if err != nil {
		return nil, fmt.Errorf("garden: build url: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("garden: build request: %w", err)
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept", "application/json")

	res, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("garden: http do: %w", err)
	}
	defer func() {
		_, _ = io.Copy(io.Discard, res.Body)
		_ = res.Body.Close()
	}()

	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("garden: upstream status %d", res.StatusCode)
	}

	var body gardenResponse
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		return nil, fmt.Errorf("garden: decode response: %w", err)
	}

	items := mapGardenResources(body.Resources)

	// Silent-failure tripwire: 200 OK + zero items for a non-empty
	// query is the "garden quietly broke" signal.  Logging it lets an
	// oncall grep spot the pattern before users complain.
	if len(items) == 0 && strings.TrimSpace(q) != "" && log != nil {
		log.Warn("garden: zero-result for non-empty query", "query", q)
	}

	return items, nil
}

// buildGardenURL composes the request URL with proper query-string
// escaping.  url.Values.Encode handles the percent-encoding so the
// Chinese "动画" type filter survives intact, and any user-supplied
// search term with spaces / brackets / CJK characters is escaped
// correctly.
func buildGardenURL(q string) (string, error) {
	u, err := url.Parse(gardenEndpoint)
	if err != nil {
		return "", err
	}
	vals := u.Query()
	vals.Set("search", q)
	vals.Set("type", gardenType)
	vals.Set("pageSize", strconv.Itoa(gardenPageSize))
	u.RawQuery = vals.Encode()
	return u.String(), nil
}

// mapGardenResources converts upstream resources to TorrentItems and
// filters out entries without a usable magnet URI.  Extracted so the
// filtering logic is unit-testable independently of the HTTP plumbing.
func mapGardenResources(rs []gardenResource) []TorrentItem {
	out := make([]TorrentItem, 0, len(rs))
	for _, r := range rs {
		if r.Title == "" || !hasMagnetScheme(r.Magnet) {
			continue
		}

		fansub := pickGardenFansub(r)
		date := stringPtr(r.CreatedAt)
		provider := stringPtr(r.Provider)

		out = append(out, TorrentItem{
			Title:    r.Title,
			Magnet:   r.Magnet,
			Size:     FormatKb(string(r.Size)),
			Fansub:   fansub,
			Date:     date,
			Source:   SourceGarden,
			Provider: provider,
		})
	}
	return out
}

// pickGardenFansub mirrors `r.fansub?.name ?? parseFansub(r.title ?? '')`.
// If the upstream provided a structured fansub object with a non-empty
// name, use it.  Otherwise fall back to bracket parsing on the title.
func pickGardenFansub(r gardenResource) *string {
	if r.Fansub != nil && r.Fansub.Name != "" {
		name := r.Fansub.Name
		return &name
	}
	return ParseFansub(r.Title)
}
