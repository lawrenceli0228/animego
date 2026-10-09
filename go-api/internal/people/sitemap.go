package people

import (
	"context"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/lawrenceli0228/animego/go-api/internal/httpx"
)

// maxSitemapShards bounds `shards`, as /api/anime/sitemap does: each shard
// is a scan, so an unbounded count is an unbounded number of them.
const maxSitemapShards = 64

// SitemapTTL is how long a listing is reused.  next-app reads each shard
// behind an hour's revalidate window, so an hour here costs it nothing; it is
// what keeps the aggregate behind a listing -- every credit row, grouped --
// from running more than once an hour per shard whoever asks.
const SitemapTTL = time.Hour

// SitemapCache keeps each listing for SitemapTTL.  A map behind a mutex: a
// handful of keys (kind x shard layout), read a few times an hour.
type SitemapCache struct {
	ttl time.Duration
	now func() time.Time

	mu      sync.Mutex
	entries map[string]sitemapCacheEntry
}

type sitemapCacheEntry struct {
	rows    []SitemapEntry
	expires time.Time
}

// NewSitemapCache returns an empty cache whose entries live for ttl.
func NewSitemapCache(ttl time.Duration) *SitemapCache {
	return &SitemapCache{ttl: ttl, now: time.Now, entries: map[string]sitemapCacheEntry{}}
}

func (c *SitemapCache) get(key string) ([]SitemapEntry, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[key]
	if !ok || !c.now().Before(e.expires) {
		return nil, false
	}
	return e.rows, true
}

func (c *SitemapCache) set(key string, rows []SitemapEntry) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries[key] = sitemapCacheEntry{rows: rows, expires: c.now().Add(c.ttl)}
}

// PeopleSitemap implements GET /api/people/sitemap?shards=N&shard=K — the
// indexed person pages in one `anilist_id % N` shard, with the time the data
// behind each last changed:
//
//	{"data":[{"anilistId":133507,"updatedAt":"2026-10-08T19:24:30Z"}, ...]}
//
// Indexed means the threshold buildPerson applies (MinIndexedVoiceWorks,
// MinIndexedStaffWorks), passed to the query from the same constants.
// Parameters are validated, never clamped, for the reason
// anime.SitemapShard gives: a corrected shard number returns another
// shard's rows.
func PeopleSitemap(db SitemapDB, cache *SitemapCache) http.HandlerFunc {
	return sitemapHandler("people", cache, func(ctx context.Context, shards, shard int32) ([]SitemapEntry, error) {
		rows, err := db.ListPeopleSitemapShard(ctx, MinIndexedVoiceWorks, MinIndexedStaffWorks, shards, shard)
		if err != nil {
			return nil, err
		}
		out := make([]SitemapEntry, 0, len(rows))
		for _, r := range rows {
			out = append(out, SitemapEntry{AnilistID: r.AnilistID, UpdatedAt: timestamp(r.UpdatedAt)})
		}
		return out, nil
	})
}

// CharactersSitemap implements GET /api/characters/sitemap?shards=N&shard=K
// — the indexed character pages (characterIndexable's rule), as
// PeopleSitemap.
func CharactersSitemap(db SitemapDB, cache *SitemapCache) http.HandlerFunc {
	return sitemapHandler("characters", cache, func(ctx context.Context, shards, shard int32) ([]SitemapEntry, error) {
		rows, err := db.ListCharactersSitemapShard(ctx, shards, shard)
		if err != nil {
			return nil, err
		}
		out := make([]SitemapEntry, 0, len(rows))
		for _, r := range rows {
			out = append(out, SitemapEntry{AnilistID: r.AnilistID, UpdatedAt: timestamp(r.UpdatedAt)})
		}
		return out, nil
	})
}

func sitemapHandler(kind string, cache *SitemapCache, list func(ctx context.Context, shards, shard int32) ([]SitemapEntry, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		qs := req.URL.Query()
		shards, err := optionalInt(qs.Get("shards"), 1)
		if err != nil || shards < 1 || shards > maxSitemapShards {
			httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeValidationError,
				"shards must be an integer in 1.."+strconv.Itoa(maxSitemapShards)))
			return
		}
		shard, err := optionalInt(qs.Get("shard"), 0)
		if err != nil || shard < 0 || shard >= shards {
			httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeValidationError,
				"shard must be an integer in 0.."+strconv.Itoa(shards-1)))
			return
		}

		key := kind + ":" + strconv.Itoa(shards) + ":" + strconv.Itoa(shard)
		if rows, ok := cache.get(key); ok {
			httpx.Data(w, http.StatusOK, rows)
			return
		}
		ctx, cancel := context.WithTimeout(req.Context(), queryTimeout)
		defer cancel()
		rows, err := list(ctx, int32(shards), int32(shard))
		if err != nil {
			httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "query failed"))
			return
		}
		cache.set(key, rows)
		httpx.Data(w, http.StatusOK, rows)
	}
}

// optionalInt reads an optional integer query parameter: absent is def,
// present and unparseable is an error.
func optionalInt(s string, def int) (int, error) {
	if s == "" {
		return def, nil
	}
	return strconv.Atoi(s)
}

// timestamp is a timestamptz as a time, the zero time for NULL (which the
// queries never return: every listed id has a credited title, and a title
// row always has updated_at).
func timestamp(t pgtype.Timestamptz) time.Time {
	if !t.Valid {
		return time.Time{}
	}
	return t.Time.UTC()
}
