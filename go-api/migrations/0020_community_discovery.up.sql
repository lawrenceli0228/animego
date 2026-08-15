-- 0020: community discovery signals and privacy-preserving engagement totals.
--
-- The homepage needs a compact "what is being discussed" read, while product
-- decisions need impression/open counts.  Analytics stay aggregate-only: no
-- IP address, user agent, anonymous identifier, comment body, or per-user
-- event row is stored.

CREATE TABLE community_engagement_daily (
    event_date date NOT NULL DEFAULT current_date,
    event_type text NOT NULL,
    source text NOT NULL,
    anilist_id integer NOT NULL DEFAULT 0,
    episode integer NOT NULL DEFAULT 0,
    authenticated boolean NOT NULL DEFAULT false,
    event_count bigint NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (
        event_date,
        event_type,
        source,
        anilist_id,
        episode,
        authenticated
    ),
    CONSTRAINT community_engagement_event_type_chk
        CHECK (event_type IN ('hot_discussions_impression', 'discussion_open')),
    CONSTRAINT community_engagement_source_chk
        CHECK (source IN ('home', 'seasonal')),
    CONSTRAINT community_engagement_target_chk CHECK (
        (event_type = 'hot_discussions_impression'
            AND anilist_id = 0
            AND episode = 0)
        OR
        (event_type = 'discussion_open'
            AND anilist_id > 0
            AND episode > 0)
    ),
    CONSTRAINT community_engagement_count_chk CHECK (event_count >= 0)
);

CREATE INDEX idx_community_engagement_daily_date
    ON community_engagement_daily (event_date DESC, event_type, source);

CREATE INDEX idx_episode_comments_recent_discovery
    ON episode_comments (created_at DESC, anilist_id, episode);
