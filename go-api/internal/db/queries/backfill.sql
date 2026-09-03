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

-- name: ListBgmBoundNeedingEpisodeTitles :many
-- The same universe as ListBgmBoundForBackfill, minus the rows a previous
-- episode-title pass already finished.
--
-- It exists because a full pass over that universe is hours long and the
-- upstream can stop answering partway through.  That is not hypothetical: a
-- production run wrote 3,890 anime and then received nothing for the remaining
-- 8,215, because the shared account hit a quota ceiling around 5,000 requests
-- in.  Re-running from the top would have spent that ceiling again on rows
-- already done before reaching the ones that were not.
--
-- `episode_titles_at` is the resume marker and it is honest by construction:
-- the writer stamps it inside the same transaction that writes the titles, so
-- a stamped row is one whose titles committed.  A row that upstream had nothing
-- for is NOT stamped -- it never reaches the write -- which means it stays a
-- candidate.  That is the right direction to be wrong in: re-asking about an
-- empty subject costs one request, while skipping a row that was never
-- actually written loses it until someone notices.
--
-- The order is unchanged (anilist_id) so a resumed run walks the same sequence
-- as the run it continues, and the report of the two can be read side by side.
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
  AND episode_titles_at IS NULL
ORDER BY anilist_id;
