-- backfill.sql — one-time re-validation of existing bgm bindings
-- (cmd/bgmbackfill).  The new matcher + dandanplay cross-check flag rows
-- whose bgm_id is likely wrong; the apply step RESETS them so the fixed V1
-- pipeline re-enriches (id_map -> authoritative, or search+score -> the
-- needs-review gate).  The reset nulls the wrong data immediately.

-- name: ListBgmBoundForBackfill :many
-- Every row that currently has a bgm_id — the universe the backfill audits.
-- Returns the fields the scorer + the dandanplay CN cross-check need.
SELECT
    anilist_id,
    bgm_id,
    title_native,
    title_romaji,
    title_english,
    title_chinese,
    season_year,
    episodes,
    bangumi_score,
    bgm_match_source
FROM anime_cache
WHERE bgm_id IS NOT NULL
ORDER BY anilist_id;

-- name: BackfillResetRows :exec
-- Apply step: reset a batch of flagged rows so the fixed pipeline re-enriches
-- them from scratch.  Nulls the (possibly wrong) bgm_id + title_chinese +
-- score/votes so the bad data disappears immediately; bangumi_version=0
-- re-queues them via the orphan scan / a follow-up V1 enqueue.
UPDATE anime_cache
SET bgm_id           = NULL,
    title_chinese    = NULL,
    bangumi_score    = NULL,
    bangumi_votes    = NULL,
    bgm_match_source = NULL,
    admin_flag       = NULL,
    bangumi_version  = 0,
    updated_at       = now()
WHERE anilist_id = ANY($1::integer[]);
