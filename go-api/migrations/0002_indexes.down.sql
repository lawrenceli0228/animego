-- go-api/migrations/0002_indexes.down.sql
-- Reverse of 0002_indexes.up.sql.

DROP INDEX anime_recommendations_anime_id_idx;
DROP INDEX anime_staff_anime_id_idx;
DROP INDEX anime_characters_anime_id_idx;
DROP INDEX anime_relations_anime_id_idx;

DROP INDEX danmakus_created_idx;
DROP INDEX danmakus_ep_created_idx;

DROP INDEX episode_comments_user_idx;
DROP INDEX episode_comments_parent_idx;
DROP INDEX episode_comments_ep_idx;

DROP INDEX follows_followee_idx;

DROP INDEX subscriptions_anilist_id_idx;
DROP INDEX subscriptions_user_status_idx;

DROP INDEX anime_cache_title_english_trgm_idx;
DROP INDEX anime_cache_title_romaji_trgm_idx;
DROP INDEX anime_cache_title_native_trgm_idx;
DROP INDEX anime_cache_title_cn_trgm_idx;
DROP INDEX anime_cache_admin_flag_idx;
DROP INDEX anime_cache_season_idx;
DROP INDEX anime_cache_search_vec_idx;
