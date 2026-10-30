-- go-api/migrations/0055_drop_community_engagement.down.sql
-- Recreates community_engagement_daily exactly as 0020 + 0028 left it: the
-- same columns and defaults, the same primary key, all four CHECK
-- constraints (event_type_chk and target_chk in 0028's widened form), and
-- the date index.
--
-- THE DATA IS NOT RESTORED.  The table comes back empty: the rows it held
-- were dropped with it by the up migration, and a daily aggregate with no
-- per-event rows behind it cannot be rebuilt.  Nothing in this build reads
-- or writes the table either, so roll the code back to a build that
-- predates 0055 as well if the counters are wanted again.

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
        CHECK (event_type IN (
            'hot_discussions_impression',
            'discussion_open',
            'welcome_card_impression',
            'welcome_card_open'
        )),
    CONSTRAINT community_engagement_source_chk
        CHECK (source IN ('home', 'seasonal')),
    CONSTRAINT community_engagement_target_chk CHECK (
        (event_type IN (
            'hot_discussions_impression',
            'welcome_card_impression',
            'welcome_card_open'
         ) AND anilist_id = 0 AND episode = 0)
        OR
        (event_type = 'discussion_open'
            AND anilist_id > 0
            AND episode > 0)
    ),
    CONSTRAINT community_engagement_count_chk CHECK (event_count >= 0)
);

CREATE INDEX idx_community_engagement_daily_date
    ON community_engagement_daily (event_date DESC, event_type, source);
