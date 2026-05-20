-- go-api/migrations/0001_init.down.sql
-- Reverse of 0001_init.up.sql. Drop children before parents.

DROP TABLE episode_windows;
DROP TABLE danmakus;
DROP TABLE episode_comments;
DROP TABLE follows;
DROP TABLE subscriptions;
DROP TABLE anime_episode_titles;
DROP TABLE anime_recommendations;
DROP TABLE anime_staff;
DROP TABLE anime_characters;
DROP TABLE anime_relations;
DROP TABLE anime_studios;
DROP TABLE anime_genres;
DROP TABLE anime_cache;
DROP TABLE users;
