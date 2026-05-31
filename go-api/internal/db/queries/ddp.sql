-- ddp.sql — dandanplay cross-validation cache (ddp_bgm_title).
-- dandanplay's Chinese animeTitle for a bgm.tv subject id, fetched via the
-- existing dandanplay client (/api/v2/bangumi/bgmtv/:bgmId) and cached here
-- keyed by bgm_id so validation + CN-heal never re-call the API for the same
-- subject — the open platform explicitly asks callers to cache and adds a
-- quota mechanism from 2026-06-25.

-- name: GetDdpTitle :one
-- Cache hit returns dandanplay's title (anime_title may be NULL = looked up,
-- none found) plus when it was checked, so the caller can skip stale rows.
SELECT anime_title, checked_at FROM ddp_bgm_title WHERE bgm_id = $1;

-- name: UpsertDdpTitle :exec
-- Persist a dandanplay lookup result (title, or NULL for a confirmed miss)
-- keyed by bgm_id.
INSERT INTO ddp_bgm_title (bgm_id, anime_title, checked_at)
VALUES ($1, $2, now())
ON CONFLICT (bgm_id) DO UPDATE
SET anime_title = EXCLUDED.anime_title,
    checked_at  = now();

-- name: ListIdMapRowsMissingCn :many
-- Heal targets for the dandanplay CN backfill: rows whose CURRENT bgm_id IS
-- the authoritative id-map binding (so the subject is trusted) but that still
-- have no Chinese title.  Healing these from dandanplay's animeTitle is safe
-- precisely because the bgm_id is map-confirmed — we never heal a fuzzy or
-- uncertain bind (whose dandanplay title could belong to the wrong subject).
SELECT a.anilist_id, a.bgm_id
FROM anime_cache a
JOIN bgm_id_map m ON m.anilist_id = a.anilist_id AND m.bgm_id = a.bgm_id
WHERE a.title_chinese IS NULL
ORDER BY a.anilist_id;

-- name: HealCnTitle :exec
-- Write a Chinese title sourced from dandanplay onto a trusted row.  Guarded
-- on title_chinese IS NULL so a concurrent enrichment that already filled CN
-- is never clobbered.
UPDATE anime_cache
SET title_chinese = $2, updated_at = now()
WHERE anilist_id = $1 AND title_chinese IS NULL;
