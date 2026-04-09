# AnimeGo

A full-stack anime discovery and tracking platform. Browse seasonal anime, manage your watchlist, post danmaku (bullet comments), and connect with other fans.

**Live:** [animegoclub.com](https://animegoclub.com)

Data sourced from [AniList GraphQL API](https://anilist.gitbook.io/anilist-apiv2-docs/) (free, no key required). Chinese titles and scores enriched via [Bangumi API](https://bangumi.github.io/api/).

---

## Features

### Browse & Discover
- **Seasonal anime** — filter by genre, format, status; sort by score/title/format
- **Trending** — top anime ranked by subscriber count
- **Weekly schedule** — airing times for current season
- **Search** — full-text search with genre filters
- **Anime detail** — hero banner, score, synopsis, characters, staff, relations, recommendations
- **Episode titles** — sourced from Bangumi with automatic offset normalization for sequels

### Track & Watch
- **Subscription system** — watching / completed / plan to watch / dropped
- **Episode progress** — track current episode, highlight watched episodes
- **Continue watching** — homepage section showing in-progress anime with progress bars
- **Torrent search** — aggregate magnet links from ACG.rip RSS, filter by fansub group

### Community
- **Danmaku** — real-time bullet comments overlaid on episode sections (Socket.IO)
- **Episode comments** — threaded comments per episode with replies and likes
- **Follow system** — follow other users, see their activity in your feed
- **Public profiles** — `/u/:username` with watchlist and follower/following counts
- **Activity feed** — recent subscription updates from followed users
- **Share** — Web Share API with clipboard fallback

### SEO & Social
- **Dynamic sitemap** — auto-generated from database, 1h cache
- **OG tags** — server-side meta tags for social crawlers and search engine bots
- **Dynamic page titles** — per-page `document.title` in Chinese and English
- **Google Search Console** verified

### Admin Dashboard
- **Enrichment monitor** — real-time queue status for Phase 1-3, Phase 4, and V3 pipelines
- **Inline editing** — edit Chinese titles and Bangumi IDs directly
- **V3 self-heal** — batch heal missing Chinese titles with progress bar, pause/resume
- **User management** — view registered users and activity

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
| External APIs | AniList GraphQL · Bangumi API · ACG.rip RSS |
| Deployment | Docker Compose · Nginx reverse proxy |
| SEO | Dynamic sitemap · OG tags · robots.txt |

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

**`server/.env`**

```env
MONGODB_URI=mongodb+srv://...
JWT_SECRET=your_jwt_secret
JWT_REFRESH_SECRET=your_refresh_secret
JWT_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d
PORT=5001
CLIENT_ORIGIN=http://localhost:5173
CACHE_TTL_HOURS=24
```

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
  ↓ /api/*
Express API → Controllers → Services
  ↓                            ↓
MongoDB (cache + user data)   AniList GraphQL API
                               ↓ (background)
                              Bangumi API (Chinese titles, scores, characters, episodes)
                               ↓ (real-time)
                              Socket.IO (danmaku)
```

### Data Pipeline

1. **AniList fetch** — seasonal/search/detail queries with 700ms throttle
2. **MongoDB cache** — 24h TTL, auto-refresh on expiry
3. **Bangumi enrichment** — 4-phase background pipeline:
   - Phase 1-3: keyword search → `titleChinese` + `bgmId`
   - Phase 4: scores, character Chinese names, episode titles
   - V3: self-heal missing Chinese titles via direct `bgmId` lookup
4. **Priority queue** — user-requested anime jumps to front of enrichment queue
5. **Cache warming** — current season pre-populated on server start

### Auth Flow

- `accessToken` in React memory only (never localStorage)
- `refreshToken` in httpOnly cookie
- Automatic 401 → refresh → retry via Axios interceptor
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

## License

MIT
