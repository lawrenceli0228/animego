**English** | [中文](README.zh.md)

# AnimeGo

A full-stack anime discovery, tracking, and local playback platform. Browse seasonal anime, manage your watchlist, play local video files with matched danmaku (bullet comments), and connect with other fans.

**Live:** [animegoclub.com](https://animegoclub.com)

---

## Project Status

> **The Go + Next.js stack is the canonical production branch.**
> `main` is the stable/production branch — only tested, reviewed code lands here; production deploys from `main`. `feat/go-backend` is the active development branch where new work is staged before merging into `main`.
> The legacy Express + MongoDB + Vite SPA stack was fully retired on 2026-06-01. There is no longer a `client/` or `server/` directory in this repository.

**Status:** Live in production (cut over 2026-05-31; legacy retired 2026-06-01)
**Migration started:** 2026-05-10 (from v2.0.0 baseline)
**Production stack:** Next.js 16 + Bun + Go 1.26 (chi + pgx + sqlc) + PostgreSQL 16 + Node ws-server (Socket.IO)
**Built with:** Claude Code (AI-assisted; product direction, decisions, and deployment by the author)

### Branch model

| Branch | Purpose |
|--------|---------|
| `main` | Stable / production. Deploys from here. Only merges in after testing + review. |
| `feat/go-backend` | Active development. New features and fixes land here first. |

### Known limitations (intentional, not bugs)
- **Danmaku matching** — accuracy is not pursued to 100%; users fall back to the manual per-episode picker for uncommon sequels. See `feedback_danmaku_matching` in the project memory for the reasoning (no LLM/AI matching by design).
- **Bangumi enrichment** — background pipeline; newly released anime may take a cycle before Chinese titles/scores appear.
- **Single-instance WebSocket** — Socket.IO danmaku does not scale horizontally without Redis adapter. See TODO.md item 5.
- **No user privacy toggle** — watchlists at `/u/:username` are publicly visible by design in this phase. See TODO.md item 4.

### Local development
1. Read this README + [CHANGELOG.md](CHANGELOG.md) (most recent 2-3 entries give you the current mental model).
2. Read [TODO.md](TODO.md) to see what was intentionally deferred.
3. `cp .env.example .env && bash scripts/dev.sh` — verify the stack boots locally.
4. SSH to VPS, `docker compose ps` — verify production is healthy.
5. Re-read [DESIGN.md](DESIGN.md) before touching UI.

---

## Features

### Browse & Discover
- **Seasonal anime** — filter by genre, format, status; sort by score/title/format
- **Trending** — top anime ranked by subscriber count
- **Annual rankings** — top rated anime of the current year
- **Completed gems** — highly rated finished series, refreshable
- **Weekly schedule** — airing times for current season
- **Search** — full-text search with genre filters
- **Anime detail** — hero banner, dual scores (AniList + Bangumi), synopsis, characters, staff, relations, recommendations
- **Episode titles** — sourced from Bangumi with automatic offset normalization for sequels

### Track & Watch
- **Subscription system** — watching / completed / plan to watch / dropped
- **Episode progress** — track current episode, highlight watched episodes
- **Continue watching** — homepage section showing in-progress anime with progress bars
- **Torrent search** — aggregate magnet links from ACG.rip RSS, filter by fansub group

### Local Player with Danmaku
- **Drag & drop** — drop an anime folder or select video files (MKV, MP4, AVI, WebM)
- **Automatic danmaku matching** — file hash + filename matching via dandanplay API, with multi-phase fallback (hash match -> keyword match -> per-file match)
- **MKV subtitle extraction** — embedded ASS/SSA/SRT subtitles extracted in-browser via Web Worker, auto-converted to VTT
- **Per-episode danmaku picker** — manually set or change the danmaku source for any episode; search any anime on dandanplay and pick the exact episode
- **Non-blocking playback** — video plays immediately; subtitles and danmaku load asynchronously in the background
- **Episode navigation** — switch episodes without leaving the player

### Community
- **Danmaku** — real-time bullet comments overlaid on episode sections (Socket.IO)
- **Episode comments** — threaded comments per episode with replies and likes
- **Follow system** — follow other users, see their activity in your feed
- **Public profiles** — `/u/:username` with watchlist, anime stats, and follower/following counts
- **Activity feed** — recent subscription updates from followed users
- **Share** — Web Share API with clipboard fallback

### SEO & Social
- **Server-rendered meta** — full crawler HTML with structured data (JSON-LD), OG tags, breadcrumbs
- **Dynamic sitemap** — auto-generated from database, sorted by score, dynamic priority
- **Content-rich pages** — anime detail pages include characters, staff, relations for search indexing
- **Google Search Console** verified

### Admin Dashboard
- **Enrichment monitor** — real-time queue status for Phase 1-3, Phase 4, and V3 pipelines
- **Inline editing** — edit Chinese titles and Bangumi IDs directly
- **V3 self-heal** — batch heal missing Chinese titles with progress bar, pause/resume
- **User management** — create, edit, delete users; view subscriptions and followers

### Internationalization
- Full Chinese/English UI — toggle with persistent preference
- `pickTitle()` selects the best title based on current language

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19 · Next.js 16 (App Router, RSC) · Bun 1.3.x · libass-wasm · artplayer · dandanplay-vi |
| Backend | Go 1.26 · chi router · pgx v5 · sqlc · river queue · ristretto cache |
| Database | PostgreSQL 16 · pg_cron · pg_trgm |
| Realtime | ws-server — standalone Node + socket.io process |
| Auth | JWT (access 15m + refresh 14d) · bcrypt · httpOnly cookies |
| Player | Artplayer · libass-wasm (ASS subtitles) · Web Workers (MD5 hash, MKV parsing) |
| External APIs | AniList GraphQL · Bangumi API · dandanplay API · ACG.rip RSS |
| Deployment | Docker Compose · Nginx reverse proxy · Cloudflare · SSL |
| SEO | Server components on `/anime/:id`, `/seasonal`, `/search` · Dynamic sitemap · JSON-LD · OG tags |

---

## Quick Start

Fresh clone to `http://localhost:3000` should take under 5 minutes on a clean macOS box.

### Prerequisites

Install once:

```bash
# Docker Desktop (Postgres container)
brew install --cask docker

# Bun 1.3+ (Next.js runtime + ws-server)
curl -fsSL https://bun.sh/install | bash

# Go 1.26+ (go-api) and Air (hot reload)
brew install go
go install github.com/cosmtrek/air@latest
```

> `scripts/setup.sh` automates this for Debian 12 VPS bootstrap (Docker + UFW). For local macOS dev, run the three commands above once.

### Install & Run

```bash
# 1. Copy env template and fill secrets (JWT, dandanplay app id/secret)
cp .env.example .env

# 2. One-shot dev loop: brings up Postgres, runs go-api with Air,
#    ws-server (Bun + socket.io), and next-app (Bun + Next.js 16).
bash scripts/dev.sh
```

Open `http://localhost:3000`.

### Local prod stack (`docker compose` HTTPS via nginx)

To exercise the production layout (nginx routing next-app + go-api + ws-server,
self-signed SSL, full docker stack) before deploying to the VPS:

```bash
# 1. Generate the local self-signed cert (one-time per machine).
bash scripts/gen-local-cert.sh

# 2. Copy and fill the prod env template.
cp .env.production.example .env.production
# ⚠️  Required: ALLOWED_HOSTS=animegoclub.com,localhost,app
# ⚠️  Required: DATABASE_URL=postgres://animego:password@postgres:5432/animego

# 3. Build + bring up the full stack (next-app, go-api, ws-server, postgres, nginx).
docker compose --env-file .env.production up -d --build

# 4. Open https://localhost (accept the self-signed cert warning).
```

### Dev Ports

| Port | Service | Notes |
|------|---------|-------|
| 3000 | next-app | App Router frontend (RSC) |
| 3001 | ws-server | socket.io danmaku |
| 8080 | go-api | chi + pgx |
| 5432 | postgres | primary datastore |

### Environment Variables

`.env.example` documents every key with a comment. The required block:

```env
# Shared
JWT_SECRET=fill-with-32-byte-random-hex
JWT_REFRESH_SECRET=fill-with-another-32-byte-random-hex
JWT_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=14d
DANDANPLAY_APP_ID=fill-with-your-app-id
DANDANPLAY_APP_SECRET=fill-with-your-secret

# Postgres (Go API) — matches docker-compose.dev.yml
POSTGRES_PASSWORD=devpassword
DATABASE_URL=postgres://animego:devpassword@localhost:5432/animego?sslmode=disable
PORT_GO=8080
```

> dandanplay API credentials can be obtained at [api.dandanplay.net](https://api.dandanplay.net/).

---

## Docker Deployment

```bash
docker compose --env-file .env.production up -d --build
```

Services: `go-api` · `next-app` · `ws-server` · `postgres` (16) · `nginx`

---

## Architecture

```
Browser
  │  (local video files stay in the browser — bytes never touch the server)
  │
Cloudflare
  │
nginx (reverse proxy + SSL, origin locked to Cloudflare ranges)
  ├── /              → next-app  (Next.js 16 SSR — all user-facing routes)
  ├── /api/          → go-api    (Go 1.26, chi router)
  └── /socket.io/    → ws-server (Node + socket.io — real-time danmaku)

go-api
  ├── PostgreSQL 16  (pg_cron · pg_trgm — cache + user data + danmaku)
  ├── AniList GraphQL
  ├── Bangumi API
  ├── dandanplay API (offline cross-check oracle for enrichment bindings)
  └── ACG.rip RSS
```

next-app serves every user-facing route via SSR: home, `/anime/:id`, `/seasonal`, `/search`, `/login`, `/library`, `/player`, `/admin`, `/u/:username`.

### Data Pipeline

1. **AniList fetch** — seasonal/search/detail queries with 700 ms throttle
2. **PostgreSQL** — single primary datastore; pg_cron handles danmaku TTL cleanup
3. **Bangumi enrichment** — background pipeline via river queue, progressing through four confidence gates:
   - **v0** — raw AniList data, no Chinese title
   - **v1** — bind to the correct Bangumi subject via an authoritative AniList↔Bangumi id-map plus a confidence-gated fuzzy scorer; low-confidence bindings are parked for human review, never auto-guessed ("rather show romaji than a wrong Chinese title")
   - **v2** — Bangumi score, character Chinese names, episode titles
   - **v3** — terminal Chinese-title heal via direct `bgmId` lookup
4. **dandanplay** — independent offline cross-check oracle for binding validation; not on the request hot path
5. **Priority queue** — user-requested anime jumps to the front of the enrichment queue

### Danmaku Matching Flow

1. **File parsing** — extract episode numbers from filenames (supports `[Group] Title - 01.mkv`, `S01E01`, `EP01`, etc.)
2. **Hash computation** — MD5 of first 16 MB via Web Worker (matches dandanplay spec)
3. **Three-phase matching** — hash+filename combined match -> keyword match -> per-file hash fallback
4. **Episode mapping** — dandanplay episode IDs mapped to local files, with OVA/SP support (`O1`, `S1` patterns)
5. **Comment fetch** — danmaku loaded by dandanplay episode ID, rendered via Artplayer danmaku plugin

### Auth Flow

- `accessToken` — JWT, 15 min TTL, stored in memory only (never localStorage)
- `refreshToken` — JWT, 14 day TTL, stored in httpOnly cookie
- SSR-aware silent refresh: Next.js middleware reads the cookie server-side and refreshes before rendering protected pages
- bcrypt for password hashing

---

## API Endpoints

All responses follow: `{ data }` · `{ data, pagination }` · `{ error: { code, message } }`

| Route | Description |
|-------|-------------|
| `POST /api/auth/register` | Register |
| `POST /api/auth/login` | Login |
| `POST /api/auth/refresh` | Refresh access token |
| `POST /api/auth/logout` | Logout |
| `GET /api/auth/me` | Current user |
| `GET /api/anime/seasonal` | Seasonal anime |
| `GET /api/anime/search` | Search anime |
| `GET /api/anime/schedule` | Weekly schedule |
| `GET /api/anime/trending` | Trending (by subscribers) |
| `GET /api/anime/:id` | Anime detail |
| `GET /api/anime/:id/watchers` | Users watching |
| `GET /api/anime/torrents` | Torrent search |
| `GET/POST/PATCH/DELETE /api/subscriptions` | Watchlist CRUD |
| `GET/POST/DELETE /api/comments` | Episode comments |
| `GET/POST/DELETE /api/users/:username/follow` | Follow system |
| `GET /api/feed` | Activity feed |
| `POST /api/dandanplay/match` | Match anime by hash/filename |
| `GET /api/dandanplay/search` | Search anime on dandanplay |
| `GET /api/dandanplay/episodes/:animeId` | Get episode list |
| `GET /api/dandanplay/comments/:episodeId` | Get danmaku comments |
| `WS /` | Socket.IO — danmaku events |

Rate limit: 100 requests / 15 min / IP on all `/api` routes.

---

## Testing

```bash
# Go API tests
cd go-api && go test ./...

# Next.js (next-app) tests — Bun's built-in test runner
cd next-app && bun test
```

---

## Credits

- [AniList](https://anilist.co/) — anime metadata and GraphQL API
- [Bangumi](https://bgm.tv/) — Chinese titles, scores, characters, and episode data
- [dandanplay](https://www.dandanplay.com/) — danmaku matching API and episode comment database. Special thanks to the dandanplay developers for their support.
- [ACG.rip](https://acg.rip/) — torrent RSS feed

---

## Contributing

AnimeGo is open source under the **GNU AGPL-3.0** license, and contributions are welcome. By submitting a pull request you agree to license your contribution under AGPL-3.0 and to sign off on the [Developer Certificate of Origin](DCO) (`git commit -s`). Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR. Note that the torrent/magnet metadata-search subsystem is **out of scope** for external contributions — bug reports via issues are welcome, but code PRs for that area are not accepted. See also our [Code of Conduct](CODE_OF_CONDUCT.md) and [Security Policy](SECURITY.md).

---

## License

AnimeGo is licensed under the **GNU Affero General Public License v3.0** (AGPL-3.0). You may use, study, modify, and redistribute it under the terms of that license; in particular, if you run a modified version as a network service, you must make your modified source available to its users. See [LICENSE](LICENSE) for the full text. © 2026 lawrenceli0228 (AnimeGo · animegoclub.com). This license covers only the original code in this repository, not the third-party data/APIs it integrates (AniList, Bangumi, MyAnimeList, dandanplay, ACG.rip), which remain subject to their owners' terms.
