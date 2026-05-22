# Byte-parity fixtures

Each test case is two files:

- `<name>.json` — metadata (path, expected status, etc.)
- `<name>.body` — raw response body bytes

Run the suite with:

    make byteparity

Or directly:

    BYTEPARITY_BASE_URL=http://localhost:8080 \
      go test -tags=byteparity ./test/byteparity/... -v

The server must be running at the base URL before the test fires.
The harness does NOT bootstrap postgres or the server.

## Adding a fixture

1. Boot the server (see go-api/README.md).
2. `curl -sS '<baseurl>/<path>' -o testdata/<name>.body`
3. Create `testdata/<name>.json` with the metadata block.
4. Re-run the suite to confirm it passes.

## Express parity capture (future Phase 8.5)

When Phase 8.5 shadow comparison kicks in, replace each `<name>.body`
with the capture from the live Express prod server at the SAME path
+ params.  The harness will then gate Go's byte-exact parity with
the legacy backend.

Capture command:

    curl -sS 'https://animegoclub.com/<path>' -o testdata/<name>.body

(Verify the prod URL doesn't have any rate limit / auth gates first.)

## What can vary across captures (avoid these in fixtures)

- Anything with `cachedAt` or other timestamps → use deterministic
  endpoints OR strip timestamps before compare (the harness doesn't
  strip; capture endpoints that don't carry server-time fields).
- `/completed-gems` — random sample, will mismatch on every call.
- `/api/anime/{id}` detail bodies that include `cachedAt`.
- Anything with rate-limit-driven response variation.

## Endpoints suitable for byte parity (P2.1.9 inventory)

Deterministic-ish (cache-served or compile-time deterministic):
- `/api/anime/yearly-top?year=YYYY&limit=N` — 1h cache + ORDER BY score
- `/api/anime/trending?limit=N` — 1h cache + ORDER BY subscriber count
- `/api/anime/seasonal?season=X&year=Y&page=1&perPage=N` — sorted by score
- `/api/anime/schedule` — 30min cache; subject to AniList shape changes
- Error envelopes — `/api/anime/abc/watchers` → 400 byte-exact Chinese msg

Not deterministic:
- `/api/anime/completed-gems` — ORDER BY random()
- `/api/anime/search?q=...` — depends on AniList freshness

P8.5 strategy: use the deterministic ones as parity gates, accept
the random ones as best-effort regression coverage of envelope shape.
