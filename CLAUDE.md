# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Design System
Always read `DESIGN.md` before making any visual or UI decisions.
All font choices, colors, spacing, border-radius, and aesthetic direction are defined there.
Do not deviate without explicit user approval.
In QA mode, flag any code that doesn't match `DESIGN.md`.

Key rules at a glance:
- **Accent color:** `#0a84ff` (iOS Blue) — the ONLY primary action color. No purple, no gradients on interactive elements.
- **Backgrounds:** `#000000` → `#1c1c1e` → `#2c2c2e` (three-layer Apple True Black)
- **Teal `#5ac8fa`:** secondary accent, information/read-only scenes only — not for clickable actions
- **Fonts:** Sora (display/headings) + DM Sans (body/UI) + JetBrains Mono (code/data)
- **No decorative animations** — motion must serve state comprehension

## Commands

### Development
```bash
# Install all dependencies (monorepo)
npm install

# Start backend (port 5001) — run in terminal 1
npm run dev:server

# Start frontend (port 5173) — run in terminal 2
npm run dev:client
```

### Testing
```bash
# Client tests (Vitest + jsdom)
npm run test --workspace=client

# Client tests in watch mode
npm run test:watch --workspace=client

# Server tests (Jest)
npm run test --workspace=server

# Run a single server test file
npx jest --workspace=server server/__tests__/anime.controller.test.js
```

### Lint & Build
```bash
npm run lint --workspace=client
npm run build                         # builds client only
npm start                             # runs server in production mode
```

## Architecture

This is a **monorepo** with two workspaces: `client/` (React SPA) and `server/` (Express API).

### Request Flow
1. Client calls `/api/*` — Vite dev proxy forwards to `localhost:5001`
2. Express routes → controllers → services
3. `anilist.service.js` checks `AnimeCache` in MongoDB first; on miss, fetches from AniList GraphQL (≥700ms throttle between calls), upserts cache with 24h TTL
4. `bangumi.service.js` runs in the background to fill in `titleChinese` without blocking the main response
5. Server starts with `warmCurrentSeason()` to pre-populate cache for the current season

### Auth Flow
- `accessToken` lives in React memory only (never localStorage), expires in 15 minutes
- `refreshToken` stored in `httpOnly` cookie, expires in 7 days
- `axiosClient.js` intercepts 401s, calls `/auth/refresh` automatically, retries original request, emits `auth:expired` event on failure
- `AuthContext.jsx` listens for `auth:expired` to log the user out

### Real-time (Phase 3)
- Socket.IO server at `server/socket/index.js` attached to the same HTTP server as Express
- `socketAuth` middleware validates JWT on handshake
- `danmaku.handler.js` handles danmaku (bullet comment) events room-keyed by `anilistId:episode`
- Client hook: `client/src/hooks/useDanmaku.js`

### State Management
- Server state via **TanStack Query** (all hooks in `client/src/hooks/`)
- Auth state via `AuthContext` (React context)
- Language (zh/en) via `LanguageContext` + `localStorage`
- Translations in `client/src/locales/zh.js` and `en.js` — add keys to both files when adding new UI text

### Key Patterns
- All API responses use `{ data: ... }` or `{ data: [...], pagination: {...} }` or `{ error: { code, message } }`
- `pickTitle(anime, lang)` in `formatters.js` selects the right title based on current language
- `AnimeCard` accepts optional `rank` and `watcherCount` badge props
- Rate limit: 100 requests / 15 min / IP on all `/api` routes

### Environment Variables
**`server/.env`** — `MONGODB_URI`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `JWT_EXPIRES_IN=15m`, `JWT_REFRESH_EXPIRES_IN=7d`, `PORT=5001`, `CLIENT_ORIGIN=http://localhost:5173`, `CACHE_TTL_HOURS=24`

**`client/.env`** — `VITE_API_BASE_URL` (leave empty for dev; Vite proxy handles `/api`)
