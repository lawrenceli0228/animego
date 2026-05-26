# P6 inventory — Library + Player + shared infrastructure

Generated 2026-05-25 from three parallel explore subagents. Source of
truth for the design doc that follows. `*-DESIGN.md` and this
`-INVENTORY.md` are both gitignored (project convention since P0).

## Scope numbers

| Surface | LOC | Notes |
|---|---|---|
| Library | 15,280 | 2 pages + 28 components + 22 hooks + 8 services + 21-file db layer |
| Player  |  5,800 | + 4.5 MB jassub WASM assets |
| Shared  |    ~550 | AuthContext + axiosClient + useDanmaku + LangContext + ProtectedRoute |
| **Total** | **~21,000** | (P7 admin was ~1,000 LOC for comparison — P6 is ~21x bigger) |

## Library — key facts

- Entry pages: `client/src/pages/LibraryPage.jsx` (1,170 LOC) +
  `client/src/pages/LocalSeriesPage.jsx` (567).
- Dexie singleton at module level via `getDb('animego-library')`,
  schema v5 frozen for the migration window
  (P8.1-STATUS §3 R1 + MIGRATION_PLAN decision log).
- 4 direct `db` touch points in render boundaries (2 pages + 2
  components), 6 hooks subscribe in effects, 8 services mutate from
  event handlers/effects only.
- File System Access API call sites are correctly gated behind
  onClick handlers today (`useFileHandles.pickFolder` lines 100-111).
  P6 must keep them out of `useEffect`.
- Heavy `useLang()` usage — port stays inside `'use client'`
  boundary; no SSR i18n needed for Library.
- Library uses `react-hot-toast`, `motion`, `react-router-dom`,
  `spark-md5`, `axios`, `@tanstack/react-query`, `dexie@4.4.2`.

## Player — key facts

- Entry: `client/src/pages/PlayerPage.jsx` (962 LOC) +
  `client/src/components/player/VideoPlayer.jsx` (684).
- jassub overlay (311 LOC) — single import site,
  `crossOriginIsolated` check at jassubOverlay.js:150 is the only
  guard, SSR `typeof crossOriginIsolated === 'undefined'` → silent
  hang without it. nginx COOP/COEP already in place.
- 4.5 MB WASM under `client/public/jassub/` — verbatim copy into
  `next-app/public/jassub/` during port.
- Subtitle picker uses standard `<input type="file">`, NOT File
  System Access API — no gesture-window caveat.
- artplayer + jassub are 100% browser-DOM → `'use client'` +
  `dynamic({ssr:false})` mandatory.
- Third-party deps: artplayer 5.4.0, artplayer-plugin-danmuku 5.3.0,
  jassub 2.5.1, motion 12.38.0, pako, spark-md5, axios.

## Shared — what's already done

| Asset | Status | Where |
|---|---|---|
| Cookie dual-track auth (Bearer + session) | ✅ P8.1 cc073f9 | `server/middleware/auth.middleware.js readToken()` |
| next-app RSC cookie forwarding | ✅ P8.1 cc073f9 | `next-app/src/lib/api.ts buildHeaders()` |
| ws-server split (socket.io standalone) | ✅ P2.8 c9a3f20 | `ws-server/` |
| RSC i18n helper | ✅ P3+ | `next-app/src/lib/i18n.ts` (getDict, tFromDict) |
| proxy.ts auth gate | ✅ P7 9ccddcb | `next-app/src/proxy.ts` (admin only — needs /library + /player matchers) |

## P6 actual work (what P7 didn't touch)

1. **Dexie + liveQuery in `'use client'` + `dynamic({ssr:false})`** —
   2 pages need this wrapping; module-level db init has to survive
   re-mount.
2. **jassub deferred mount** — `crossOriginIsolated` check + WASM
   load can only happen after first client render. Already handled
   in jassubOverlay.js, just needs to land in next-app intact.
3. **`/library` + `/player` proxy.ts matchers** — extend the
   existing `/admin/:path*` matcher to `["/admin/:path*",
   "/library/:path*", "/player/:path*"]`. Drop the role check for
   the two new paths (just require a valid session).
4. **RSC 401 strategy** — recommendation: don't try to replicate the
   axios interceptor + queue dedup. proxy.ts handles the expired
   case (redirect to /login?from=...). The legacy axios cascade
   stays for any client-side fetch the ported pages still make.
5. **WASM assets copy** — 4.5 MB into `next-app/public/jassub/`.
   Reuse the existing postinstall script that copies from
   node_modules/jassub/dist/.

## Open architectural questions for P6-DESIGN.md

- Library mode → Player navigation: legacy uses `useNavigate('/player', {state: {seriesId, episode}})`. Next 16 doesn't have `state` on Link — port to `?seriesId=&episode=` query params, or to a shared zustand store, or to a Library→Player React context that survives client navigation?
- Browser refresh on /player: legacy keeps in-memory File handles → refresh loses the file. Same trade-off in next-app — accept the loss, or persist file paths in URL search params and re-prompt FSA?
- Episode pagination state on /library/:seriesId: query string vs internal useState (matching the /admin monolithic pattern from P7)?
- Suspense boundaries: how granular? Per section (EpisodeFileList, DanmakuPicker)? Per modal? One big shell?

## Out of scope (defer)

- Library data migration (Dexie schema v5 stays frozen; v6 is post-cutover + 30d).
- Player rendering engine swap (artplayer 5.x → 6.x or alternatives — orthogonal).
- Danmaku ws-server nginx flip from `/socket.io → app` to `/socket.io → ws_server` — that's P9 work, not P6.
- New player features. P6 is parity port only.

## Next step

Write `docs/migration/P6-DESIGN.md` (gitignored, local).
Tasks 15-N will follow the same pattern as P7 Tasks 3-10 once design is locked.
