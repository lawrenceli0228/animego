-- go-api/migrations/0001_init.up.sql
-- AnimeGo Postgres 16 schema: initial tables, types, and generated columns.
-- Migration from MongoDB (Mongoose) to Postgres + sqlc + golang-migrate.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- pg_cron: NOT created in 0001.  postgres:16-alpine does not bundle pg_cron.
-- Will be added back in P1.F migration after docker-compose.dev.yml swaps to a
-- custom image that compiles pg_cron from source on top of postgres:16-alpine.
-- See P1-PROGRESS.md.
-- CREATE EXTENSION IF NOT EXISTS pg_cron;

CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    username text NOT NULL UNIQUE,
    email text NOT NULL UNIQUE,
    password text NOT NULL,
    role text,
    refresh_token text,
    reset_password_token text,
    reset_password_expires timestamptz,
    is_public boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT users_username_length_chk CHECK (char_length(username) BETWEEN 3 AND 50),
    CONSTRAINT users_role_chk CHECK (role IN ('admin') OR role IS NULL)
);

CREATE TABLE anime_cache (
    anilist_id integer PRIMARY KEY,
    title_romaji text,
    title_english text,
    title_native text,
    title_chinese text,
    cover_image_url text,
    cover_image_color text,
    poster_accent text,
    poster_accent_rgb text,
    poster_accent_contrast_on_black numeric,
    banner_image_url text,
    description text,
    episodes integer,
    status text,
    season text,
    season_year integer,
    average_score numeric(4,2),
    format text,
    duration integer,
    source text,
    bgm_id integer,
    bangumi_score numeric(4,2),
    bangumi_votes integer,
    bangumi_version integer NOT NULL DEFAULT 0,
    cached_at timestamptz NOT NULL DEFAULT now(),
    start_date date,
    admin_flag text,
    search_vec tsvector GENERATED ALWAYS AS (
        to_tsvector(
            'simple',
            coalesce(title_romaji, '') || ' ' ||
            coalesce(title_english, '') || ' ' ||
            coalesce(title_native, '') || ' ' ||
            coalesce(title_chinese, '')
        )
    ) STORED,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT anime_cache_admin_flag_chk CHECK (admin_flag IN ('needs-review', 'manually-corrected') OR admin_flag IS NULL),
    CONSTRAINT anime_cache_bangumi_version_chk CHECK (bangumi_version BETWEEN 0 AND 2)
);

CREATE TABLE anime_genres (
    anime_id integer NOT NULL REFERENCES anime_cache(anilist_id) ON DELETE CASCADE,
    genre text NOT NULL,
    PRIMARY KEY (anime_id, genre)
);

CREATE TABLE anime_studios (
    anime_id integer NOT NULL REFERENCES anime_cache(anilist_id) ON DELETE CASCADE,
    studio text NOT NULL,
    PRIMARY KEY (anime_id, studio)
);

CREATE TABLE anime_relations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    anime_id integer NOT NULL REFERENCES anime_cache(anilist_id) ON DELETE CASCADE,
    anilist_id integer NOT NULL,
    relation_type text,
    title text,
    cover_image_url text,
    cover_image_color text,
    poster_accent text,
    poster_accent_rgb text,
    poster_accent_contrast_on_black numeric,
    format text
);

CREATE TABLE anime_characters (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    anime_id integer NOT NULL REFERENCES anime_cache(anilist_id) ON DELETE CASCADE,
    display_order integer NOT NULL,
    name_en text,
    name_ja text,
    name_cn text,
    image_url text,
    role text,
    voice_actor_en text,
    voice_actor_ja text,
    voice_actor_cn text,
    voice_actor_image_url text
);

CREATE TABLE anime_staff (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    anime_id integer NOT NULL REFERENCES anime_cache(anilist_id) ON DELETE CASCADE,
    display_order integer NOT NULL,
    name_en text,
    name_ja text,
    image_url text,
    role text
);

CREATE TABLE anime_recommendations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    anime_id integer NOT NULL REFERENCES anime_cache(anilist_id) ON DELETE CASCADE,
    anilist_id integer NOT NULL,
    title text,
    cover_image_url text,
    cover_image_color text,
    poster_accent text,
    poster_accent_rgb text,
    poster_accent_contrast_on_black numeric,
    average_score numeric(4,2)
);

CREATE TABLE anime_episode_titles (
    anime_id integer NOT NULL REFERENCES anime_cache(anilist_id) ON DELETE CASCADE,
    episode integer NOT NULL,
    name_cn text,
    name text,
    PRIMARY KEY (anime_id, episode),
    CONSTRAINT anime_episode_titles_episode_chk CHECK (episode > 0)
);

CREATE TABLE subscriptions (
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    anilist_id integer NOT NULL REFERENCES anime_cache(anilist_id) ON DELETE CASCADE,
    status text NOT NULL,
    current_episode integer NOT NULL DEFAULT 0,
    score integer,
    last_watched_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, anilist_id),
    CONSTRAINT subscriptions_status_chk CHECK (status IN ('watching','completed','plan_to_watch','dropped')),
    CONSTRAINT subscriptions_score_chk CHECK (score IS NULL OR score BETWEEN 1 AND 10)
);

CREATE TABLE follows (
    follower_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    followee_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (follower_id, followee_id)
);

CREATE TABLE episode_comments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    anilist_id integer NOT NULL REFERENCES anime_cache(anilist_id) ON DELETE CASCADE,
    episode integer NOT NULL,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    username text NOT NULL,
    content text NOT NULL,
    parent_id uuid REFERENCES episode_comments(id) ON DELETE CASCADE,
    reply_to_username text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT episode_comments_content_length_chk CHECK (char_length(content) <= 500)
);

CREATE TABLE danmakus (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    anilist_id integer NOT NULL REFERENCES anime_cache(anilist_id) ON DELETE CASCADE,
    episode integer NOT NULL,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    username text NOT NULL,
    content text NOT NULL,
    live_ends_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT danmakus_content_length_chk CHECK (char_length(content) <= 50)
);

CREATE TABLE episode_windows (
    anilist_id integer NOT NULL REFERENCES anime_cache(anilist_id) ON DELETE CASCADE,
    episode integer NOT NULL,
    live_ends_at timestamptz NOT NULL,
    PRIMARY KEY (anilist_id, episode)
);
