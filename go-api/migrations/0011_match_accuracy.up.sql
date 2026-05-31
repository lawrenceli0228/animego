-- 0011: enrichment match-accuracy schema.
--
-- Background: Phase-1 bound a Bangumi subject via exact-string OR list[0]
-- fallback with no similarity guard. A live audit found ~10% of bindings
-- point at the WRONG subject (wrong title_chinese + bangumi_score attached),
-- and nothing in the schema recorded HOW a bgm_id was chosen, so confident
-- bindings and blind guesses looked identical on the dashboard.

-- bgm_match_source records how each row's bgm_id was bound so the admin
-- dashboard can distinguish confident bindings from guesses and the backfill
-- can target precisely:
--   NULL         never bound
--   'id_map'     authoritative AniList->Bangumi map hit (highest trust)
--   'fuzzy_high' scorer high-confidence bind
--   'fuzzy_low'  scorer low-confidence (quarantined: bgm_id NOT written)
--   'manual'     admin override
ALTER TABLE anime_cache ADD COLUMN IF NOT EXISTS bgm_match_source text;

-- bgm_id_map: vendored AniList->Bangumi id map (Fribb x BangumiExtLinker
-- joined on MAL id). Seeded from data/anilist_bgm_map.json on deploy and
-- consulted by the V1 worker BEFORE any Bangumi search. Authoritative.
CREATE TABLE IF NOT EXISTS bgm_id_map (
    anilist_id  integer PRIMARY KEY,
    bgm_id      integer NOT NULL,
    mal_id      integer,
    source      text NOT NULL DEFAULT 'mal',
    updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bgm_id_map_bgm ON bgm_id_map (bgm_id);

-- ddp_bgm_title: dandanplay's Chinese animeTitle for a bgm.tv subject id,
-- used as an independent cross-check (validation) and as a CN-heal source.
-- Cached here keyed by bgm_id so validation/heal never re-calls dandanplay
-- for the same subject (the open platform asks callers to cache + adds a
-- quota mechanism from 2026-06-25). anime_title NULL = looked up, none found.
CREATE TABLE IF NOT EXISTS ddp_bgm_title (
    bgm_id      integer PRIMARY KEY,
    anime_title text,
    checked_at  timestamptz NOT NULL DEFAULT now()
);
