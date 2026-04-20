**English** | [中文](README.zh.md)

# AnimeGo

A full-stack anime discovery, tracking, and local playback platform. Browse seasonal anime, manage your watchlist, play local video files with matched danmaku (bullet comments), and connect with other fans.

**Live:** [animegoclub.com](https://animegoclub.com)

---

## Project Status

**Status:** Feature-complete · Maintenance mode
**Last active development:** 2026-04-20 (v1.0.11)
**Built with:** Claude Code (AI-assisted; product direction, decisions, and deployment by the author)

### What works
All features in the list below are live and stable on [animegoclub.com](https://animegoclub.com). See [CHANGELOG.md](CHANGELOG.md) for the full release history.

### Known limitations (intentional, not bugs)
- **Danmaku matching** — accuracy is not pursued to 100%; users fall back to the manual per-episode picker for uncommon sequels. See `feedback_danmaku_matching` in the project memory for the reasoning (no LLM/AI matching by design).
- **Bangumi enrichment** — background pipeline; newly released anime may take a cycle before Chinese titles/scores appear.
- **Single-instance WebSocket** — Socket.IO danmaku does not scale horizontally without Redis adapter. See TODO.md item 5.
- **No user privacy toggle** — watchlists at `/u/:username` are publicly visible by design in this phase. See TODO.md item 4.

### Restart checklist (if picking this up later)
1. Read this README + [CHANGELOG.md](CHANGELOG.md) (most recent 2-3 entries give you the current mental model).
2. Read [TODO.md](TODO.md) to see what was intentionally deferred.
3. `npm install && npm run dev:server` + `npm run dev:client` — verify local runs.
4. SSH to VPS, `docker compose ps` — verify production is healthy.
5. Re-read [DESIGN.md](DESIGN.md) before touching UI.

### Not planning to continue
Active development is paused. Core product goals are met; continued work would be diminishing-returns bug-polish. The codebase is stable enough to leave running; VPS auto-restarts via docker compose.

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
| Frontend | React 19 · Vite · TanStack Query v5 · React Router v7 |
| Backend | Node.js · Express · Socket.IO |
| Database | MongoDB · Mongoose |
| Auth | JWT (access 15m + refresh 7d) · bcrypt · httpOnly cookies |
| Player | Artplayer · JASSUB (ASS subtitles) · Web Workers (MD5 hash, MKV parsing) |
| External APIs | AniList GraphQL · Bangumi API · dandanplay API · ACG.rip RSS |
| Deployment | Docker Compose · Nginx reverse proxy · SSL |
| SEO | Dynamic sitemap · JSON-LD structured data · OG tags · robots.txt |

---

## Quick Start

### Prerequisites

- Node.js 20+
- MongoDB (local or [MongoDB Atlas](https://mongodb.com/atlas) free tier)

### Install & Run

```bash
# Install dependencies
npm install

# Terminal 1: start backend (port 5001)
npm run dev:server

# Terminal 2: start frontend (port 5173)
npm run dev:client
```

Open `http://localhost:5173`

### Environment Variables

Copy `.env.example` to `server/.env` and fill in:

```env
MONGODB_URI=mongodb+srv://...
JWT_SECRET=your_jwt_secret
JWT_REFRESH_SECRET=your_refresh_secret
JWT_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d
PORT=5001
CLIENT_ORIGIN=http://localhost:5173
CACHE_TTL_HOURS=24
DANDANPLAY_APP_ID=your_dandanplay_app_id
DANDANPLAY_APP_SECRET=your_dandanplay_app_secret
```

> dandanplay API credentials can be obtained at [api.dandanplay.net](https://api.dandanplay.net/)

**`client/.env`**

```env
VITE_API_BASE_URL=
```

> Leave `VITE_API_BASE_URL` empty for development — Vite proxies `/api` to `localhost:5001`.

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
