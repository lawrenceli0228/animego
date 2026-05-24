# Cloudflare cache rules — P8.1 deploy day

Apply these rules in the Cloudflare dashboard the moment nginx
default.conf is live on the VPS. Without them, two things break:

1. `/_next/static/*` immutable bundle hashes get cached for minutes not
   years — every visitor pays the SSR + bundle download cost on every
   visit, defeating Next 16 standalone's whole point.
2. `/api/*` and `/socket.io/*` get edge-cached, freezing user data and
   killing realtime danmaku.

The dashboard path is **Caching → Cache Rules**. Order matters: rules
evaluate top to bottom; first match wins.

---

## Rule 1 — Next.js immutable assets (cache aggressively)

**Match:**

```
(http.request.uri.path matches "^/_next/static/")
```

**Settings:**

| Field | Value |
|-------|-------|
| Eligible for cache | ✅ Yes |
| Edge TTL | **1 year** (override existing headers) |
| Browser TTL | Respect origin (Next ships `Cache-Control: public, max-age=31536000, immutable`) |
| Cache key | Default |

**Why 1 year override:** Next 16 standalone names chunks with content
hashes (`/_next/static/chunks/[hash].js`), so cache poisoning is
impossible by design. Edge can hold these forever; we cap at 1y just
in case Cloudflare changes its mind about infinite TTLs.

**Why edge-cache origin static:** Next-app container only ships one
copy of these bundles per build. Cloudflare absorbing >95% of static
requests (P8.1-STATUS §5 indicator #2) is what makes the next-app
container's 512MB memory limit survivable.

---

## Rule 2 — API + WebSocket (never cache)

**Match:**

```
(http.request.uri.path matches "^/api/" 
  or http.request.uri.path matches "^/socket.io/")
```

**Settings:**

| Field | Value |
|-------|-------|
| Eligible for cache | ❌ Bypass cache |
| Edge TTL | n/a |
| Browser TTL | Respect origin |

**Why:** `/api/anime/:id` etc are user-scoped over time (rating
counts, recent comments, watching status). `/socket.io/*` is a
WebSocket polling fallback that breaks if edge caches transport
frames.

---

## Rule 3 — Dynamic SSR pages (bypass)

**Match:**

```
(http.request.uri.path matches "^/anime/" 
  or http.request.uri.path matches "^/seasonal" 
  or http.request.uri.path eq "/search")
```

**Settings:**

| Field | Value |
|-------|-------|
| Eligible for cache | ❌ Bypass cache |

**Why:** These are Next 16 ISR pages with their own
`Cache-Control: s-maxage=...` headers that Next manages internally
(stale-while-revalidate, on-demand revalidation via webhook). If
Cloudflare caches them, ISR invalidation has no way to reach the edge
and pages serve stale content forever. Bypass edge, let the next-app
container handle ISR.

Future P8.5 work: once Next ISR is proven stable, flip to edge-cache
with short Edge TTL (e.g. 5min) and rely on Cloudflare's purge API
for invalidation. Not now — premature optimization.

---

## Rule 4 — SEO files (cache short)

**Match:**

```
(http.request.uri.path eq "/sitemap.xml" 
  or http.request.uri.path eq "/robots.txt")
```

**Settings:**

| Field | Value |
|-------|-------|
| Eligible for cache | ✅ Yes |
| Edge TTL | **1 hour** |
| Browser TTL | 1 hour |

**Why:** Crawlers re-fetch these often. 1h edge cache absorbs the
spike without staleness mattering (sitemap content changes on the
order of days, not seconds).

---

## Rule 5 — Legacy SPA + protected pages (bypass)

**Match:**

```
(http.request.uri.path matches "^/(library|player|admin|profile|login|register|forgot-password|reset-password|calendar|faq|u/)")
```

**Settings:**

| Field | Value |
|-------|-------|
| Eligible for cache | ❌ Bypass cache |

**Why:** Auth-gated pages whose response depends on the user's
session cookie. Edge caching by URL alone would leak one user's
admin dashboard to the next visitor.

---

## Rule 6 — Root + welcome (cache short, server-rendered)

**Match:**

```
(http.request.uri.path eq "/" 
  or http.request.uri.path eq "/welcome")
```

**Settings:**

| Field | Value |
|-------|-------|
| Eligible for cache | ✅ Yes |
| Edge TTL | **5 minutes** |
| Browser TTL | Respect origin |

**Why:** Both are anonymous SSR pages (no per-user state). 5min cache
absorbs the homepage spike when a single post hits Bilibili / X
without serving 10min-stale content to organic search visitors.

---

## Verification

After applying, test from a clean Chrome incognito session:

```bash
# Hit each rule, look for cf-cache-status header.
curl -sI https://animegoclub.com/_next/static/css/some.css | grep -i cf-cache-status
# Expected: cf-cache-status: HIT (after first request)

curl -sI https://animegoclub.com/api/anime/1 | grep -i cf-cache-status
# Expected: cf-cache-status: BYPASS or DYNAMIC

curl -sI https://animegoclub.com/anime/1 | grep -i cf-cache-status
# Expected: cf-cache-status: BYPASS or DYNAMIC

curl -sI https://animegoclub.com/sitemap.xml | grep -i cf-cache-status
# Expected: HIT after first request, within 1h window
```

Also check P8.1-STATUS §5 indicator #2 (CF cache hit ratio for
`/_next/static/*` > 95%) hits target within the first 24h.

---

## Rollback

If a Cloudflare rule turns out to break something:

1. Disable the offending rule (toggle in dashboard, no need to delete)
2. Purge cache for the matched path pattern
3. Verify with curl that `cf-cache-status` returns to `BYPASS` /
   `DYNAMIC` for the affected paths

Cloudflare changes propagate in seconds; the blast radius is small.
