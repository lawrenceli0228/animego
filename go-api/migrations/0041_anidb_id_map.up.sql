-- 0041: anidb_id_map — AniList -> AniDB, straight from Fribb/anime-lists.
--
-- Until now the AniDB id lived only in bgm_id_map (migration 0013), so a show
-- had one only if the AniList->Bangumi join also succeeded for it.  The two
-- are different questions: the AniDB id comes from Fribb alone and feeds the
-- AnimeTosho magnet feed, while the Bangumi id needs a second dataset to
-- agree and decides which Chinese title, synopsis and episode names a page
-- copies.  Once cmd/bgmmap started refusing Bangumi links the two datasets
-- disagree about, keeping the AniDB id in the same row would have taken the
-- magnet feed away from exactly those shows.
--
-- Seeded at boot from the embedded internal/bgmidmap/anilist_anidb_map.json
-- with the same full-replace TRUNCATE + COPY as bgm_id_map.  bgm_id_map's own
-- anidb_id column stays and is still written; nothing reads it any more.
CREATE TABLE IF NOT EXISTS anidb_id_map (
    anilist_id integer PRIMARY KEY,
    anidb_id   integer NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);
