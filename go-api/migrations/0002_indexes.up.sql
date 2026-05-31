-- go-api/migrations/0002_indexes.up.sql
-- Secondary indexes for anime_cache search, subscriptions, follows, comments, danmakus,
-- and anime_* children. Names explicit so 0002_indexes.down.sql can drop by name.

CREATE INDEX anime_cache_search_vec_idx ON anime_cache USING gin (search_vec);
CREATE INDEX anime_cache_season_idx ON anime_cache (season, season_year);
CREATE INDEX anime_cache_admin_flag_idx ON anime_cache (admin_flag) WHERE admin_flag IS NOT NULL;
CREATE INDEX anime_cache_title_cn_trgm_idx ON anime_cache USING gin (title_chinese gin_trgm_ops);
CREATE INDEX anime_cache_title_native_trgm_idx ON anime_cache USING gin (title_native gin_trgm_ops);
CREATE INDEX anime_cache_title_romaji_trgm_idx ON anime_cache USING gin (title_romaji gin_trgm_ops);
CREATE INDEX anime_cache_title_english_trgm_idx ON anime_cache USING gin (title_english gin_trgm_ops);

CREATE INDEX subscriptions_user_status_idx ON subscriptions (user_id, status);
CREATE INDEX subscriptions_anilist_id_idx ON subscriptions (anilist_id);

CREATE INDEX follows_followee_idx ON follows (followee_id);

CREATE INDEX episode_comments_ep_idx ON episode_comments (anilist_id, episode);
CREATE INDEX episode_comments_parent_idx ON episode_comments (parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX episode_comments_user_idx ON episode_comments (user_id);

CREATE INDEX danmakus_ep_created_idx ON danmakus (anilist_id, episode, created_at);
CREATE INDEX danmakus_created_idx ON danmakus (created_at);

CREATE INDEX anime_relations_anime_id_idx ON anime_relations (anime_id);
CREATE INDEX anime_characters_anime_id_idx ON anime_characters (anime_id);
CREATE INDEX anime_staff_anime_id_idx ON anime_staff (anime_id);
CREATE INDEX anime_recommendations_anime_id_idx ON anime_recommendations (anime_id);
