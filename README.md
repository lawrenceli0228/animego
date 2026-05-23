**English** | [中文](README.zh.md)

# AnimeGo

A full-stack anime discovery, tracking, and local playback platform. Browse seasonal anime, manage your watchlist, play local video files with matched danmaku (bullet comments), and connect with other fans.

**Live:** [animegoclub.com](https://animegoclub.com)

---

## Project Status

> ⚠️ **Active rewrite in progress** — backend is moving to Go + PostgreSQL, frontend to Next.js 16.
> Current `main` and the live site at [animegoclub.com](https://animegoclub.com) continue to run the v2.0.x Vite SPA + Express + MongoDB stack.
> Rewrite work happens on branch **`feat/go-backend`**.
> Full plan: [`docs/migration/MIGRATION_PLAN.md`](docs/migration/MIGRATION_PLAN.md) · Phase 2 progress: [`docs/migration/P2-PROGRESS.md`](docs/migration/P2-PROGRESS.md) · Status snapshot: [`docs/migration/P2.1-STATUS.html`](docs/migration/P2.1-STATUS.html)

**Status:** Active rewrite — Phase 2.1 (`/api/anime/*`) feature-complete on `feat/go-backend`
**Migration started:** 2026-05-10 (from v2.0.0 baseline)
**Current milestone (2026-05-22):** P2.1.8 — 9/9 anime endpoints in Go (chi + pgx + sqlc) with envelope byte parity vs Express; Bangumi V1+V2+V3 enrichment workers running on river queue; 1h ristretto cache wraps for trending/yearly-top; AniList Detail re-fetch on stale `/:anilistId`
**Target stack:** Next.js 16 + Bun + Go 1.26 (chi + pgx + sqlc) + PostgreSQL 16 + Node ws-server (socket.io)
**Built with:** Claude Code (AI-assisted; product direction, decisions, and deployment by the author)

### Current rewrite
The codebase is moving from Vite SPA + Express + MongoDB to a polyglot stack: Next.js 16 RSC frontend + Go HTTP backend + Postgres. Goals:
- Server-side rendering on SEO-relevant routes (`/anime/:id`, `/seasonal`, `/search`)
- Type-safe SQL via sqlc → pgx v5; no ORM runtime overhead
- Single big-bang cutover with 24h rollback window
- 48 HTTP endpoints in Go, danmaku websocket as separate `ws-server` microservice
- Nightly Postgres pg_dump → Cloudflare R2 (30-day retention)

The live site at [animegoclub.com](https://animegoclub.com) continues to run the v2.0.x stack during the rewrite. See the migration plan for phase-by-phase progress.

### Known limitations (intentional, not bugs)
- **Danmaku matching** — accuracy is not pursued to 100%; users fall back to the manual per-episode picker for uncommon sequels. See `feedback_danmaku_matching` in the project memory for the reasoning (no LLM/AI matching by design).
- **Bangumi enrichment** — background pipeline; newly released anime may take a cycle before Chinese titles/scores appear.
- **Single-instance WebSocket** — Socket.IO danmaku does not scale horizontally without Redis adapter. See TODO.md item 5.
- **No user privacy toggle** — watchlists at `/u/:username` are publicly visible by design in this phase. See TODO.md item 4.

### Local development
1. Read this README + [CHANGELOG.md](CHANGELOG.md) (most recent 2-3 entries give you the current mental model).
2. Read [TODO.md](TODO.md) to see what was intentionally deferred.
3. `cp .env.example .env && bash scripts/dev.sh` — verify the new stack boots locally.
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

Phase 3.0 has landed — the polyglot stack below now coexists with the v2.0.x legacy stack on `feat/go-backend`. Legacy services keep running until P9-P10 cutover.

| Layer | Technology |
|-------|-----------|
| Frontend | React 19 · Next.js 16 (App Router, RSC) · Bun 1.3.x · libass-wasm · artplayer · dandanplay-vi |
| Backend | Go 1.23 · chi router · pgx v5 · sqlc · river queue · ristretto cache |
| Database | PostgreSQL 16 · pg_cron · pg_trgm |
| Realtime | ws-server — standalone Node + socket.io process (extracted in P2.8) |
| Auth | JWT (access 15m + refresh 7d) · bcrypt · httpOnly cookies |
| Player | Artplayer · libass-wasm (ASS subtitles) · Web Workers (MD5 hash, MKV parsing) |
| External APIs | AniList GraphQL · Bangumi API · dandanplay API · ACG.rip RSS |
| Deployment | Docker Compose · Nginx reverse proxy · SSL |
| SEO | Server components on `/anime/:id`, `/seasonal`, `/search` · Dynamic sitemap · JSON-LD · OG tags |
| Legacy (retiring) | Express + Mongoose + Socket.IO (`server/`, retires at P9) · Vite + React Router v7 (`client/`, retires at P10) · MongoDB (drops at P9) |

---

## Quick Start

Fresh clone to `http://localhost:3000` should take under 5 minutes on a clean macOS box.

### Prerequisites

Install once:

```bash
# Docker Desktop (Postgres + Mongo containers)
brew install --cask docker

# Bun 1.3+ (Next.js runtime + ws-server)
curl -fsSL https://bun.sh/install | bash

# Go 1.23+ (go-api) and Air (hot reload)
brew install go
go install github.com/cosmtrek/air@latest
```

> `scripts/setup.sh` automates this for Debian 12 VPS bootstrap (Docker + UFW). For local macOS dev, run the three commands above once.

### Install & Run

```bash
# 1. Copy env template and fill secrets (JWT, dandanplay app id/secret)
cp .env.example .env

# 2. One-shot dev loop: brings up Postgres + Mongo, runs go-api with Air,
#    ws-server (Bun + socket.io), and next-app (Bun + Next.js 16).
bash scripts/dev.sh
```

Open `http://localhost:3000`.

### Dev Ports

| Port | Service | Notes |
|------|---------|-------|
| 3000 | next-app | new App Router frontend (RSC) |
| 3001 | ws-server | socket.io danmaku |
| 8080 | go-api | chi + pgx |
| 5432 | postgres | new primary store |
| 27017 | mongo | legacy, retires at P9 |
| 5001 | server (Express) | legacy, retires at P9; `dev.sh` does not start it |
| 5173 | client (Vite) | legacy, retires at P10; `dev.sh` does not start it |

### Environment Variables

`.env.example` documents every key with a comment. The required block:

```env
# Shared across all stacks
JWT_SECRET=fill-with-32-byte-random-hex
JWT_REFRESH_SECRET=fill-with-another-32-byte-random-hex
JWT_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d
DANDANPLAY_APP_ID=fill-with-your-app-id
DANDANPLAY_APP_SECRET=fill-with-your-secret

# Postgres (Go API) — matches docker-compose.dev.yml
POSTGRES_PASSWORD=devpassword
DATABASE_URL=postgres://animego:devpassword@localhost:5432/animego?sslmode=disable
PORT_GO=8080

# Legacy Mongo + Express — still wired during cutover
MONGODB_URI=mongodb://localhost:27017/animego
PORT=5001
CLIENT_ORIGIN=http://localhost:3000
```

> dandanplay API credentials can be obtained at [api.dandanplay.net](https://api.dandanplay.net/).

### Legacy Scripts (during cutover)

Both legacy stacks remain runnable for parity verification and the cutover rollback window. They are intentionally **not** started by `scripts/dev.sh`:

```bash
npm run dev:server   # Express on :5001 (retires at P9)
npm run dev:client   # Vite on :5173   (retires at P10)
npm run dev:next     # Next.js on :3000 (same as scripts/dev.sh path)
```

---

## Docker Deployment

```bash
docker compose up -d --build
```

Services: `app` (Node.js) · `mongodb` (Mongo 7) · `nginx` (reverse proxy with SSL)

---

## Architecture

```
Client (React SPA)
  | /api/*
Express API -> Controllers -> Services
  |                             |
MongoDB (cache + user data)   AniList GraphQL API
                                | (background enrichment)
                               Bangumi API (Chinese titles, scores, characters, episodes)
                                | (on-demand)
                               dandanplay API (danmaku matching, episode mapping, comments)
                                | (real-time)
                               Socket.IO (live danmaku)
```

### Data Pipeline

1. **AniList fetch** — seasonal/search/detail queries with 700ms throttle
2. **MongoDB cache** — 24h TTL, auto-refresh on expiry
3. **Bangumi enrichment** — 4-phase background pipeline:
   - Phase 1-3: keyword search -> `titleChinese` + `bgmId`
   - Phase 4: scores, character Chinese names, episode titles
   - V3: self-heal missing Chinese titles via direct `bgmId` lookup
4. **Priority queue** — user-requested anime jumps to front of enrichment queue
5. **Cache warming** — current season pre-populated on server start

### Danmaku Matching Flow

1. **File parsing** — extract episode numbers from filenames (supports `[Group] Title - 01.mkv`, `S01E01`, `EP01`, etc.)
2. **Hash computation** — MD5 of first 16MB via Web Worker (matches dandanplay spec)
3. **Three-phase matching** — hash+filename combined match -> AnimeCache keyword match -> per-file hash fallback
4. **Episode mapping** — dandanplay episode IDs mapped to local files, with OVA/SP support (`O1`, `S1` patterns)
5. **Comment fetch** — danmaku loaded by dandanplay episode ID, rendered via Artplayer danmaku plugin

### Auth Flow

- `accessToken` in React memory only (never localStorage)
- `refreshToken` in httpOnly cookie
- Automatic 401 -> refresh -> retry via Axios interceptor
- `auth:expired` event triggers logout

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
# Client tests (Vitest + jsdom)
npm run test --workspace=client

# Server tests (Jest)
npm run test --workspace=server
```

---

## Credits

- [AniList](https://anilist.co/) — anime metadata and GraphQL API
- [Bangumi](https://bgm.tv/) — Chinese titles, scores, characters, and episode data
- [dandanplay](https://www.dandanplay.com/) — danmaku matching API and episode comment database. Special thanks to the dandanplay developers for their support.
- [ACG.rip](https://acg.rip/) — torrent RSS feed

---

## License

MIT
