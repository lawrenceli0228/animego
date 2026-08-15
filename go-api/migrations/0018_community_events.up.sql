-- 0018: append-only community events, in-app notifications, and comment likes.
--
-- These tables turn one-off social writes into durable product loops:
-- activity_events is the chronological source for the feed, notifications
-- bring recipients back to the exact interaction, and comment_reactions gives
-- episode discussions a low-friction acknowledgement primitive.

CREATE TABLE activity_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event_type text NOT NULL,
    anilist_id integer REFERENCES anime_cache(anilist_id) ON DELETE CASCADE,
    episode integer,
    comment_id uuid REFERENCES episode_comments(id) ON DELETE CASCADE,
    target_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT activity_events_type_chk
        CHECK (event_type IN ('watch_progress', 'comment', 'follow')),
    CONSTRAINT activity_events_episode_chk
        CHECK (episode IS NULL OR episode >= 0),
    CONSTRAINT activity_events_shape_chk CHECK (
        (event_type = 'watch_progress'
            AND anilist_id IS NOT NULL AND episode IS NOT NULL
            AND comment_id IS NULL AND target_user_id IS NULL)
        OR
        (event_type = 'comment'
            AND anilist_id IS NOT NULL AND episode IS NOT NULL
            AND comment_id IS NOT NULL AND target_user_id IS NULL)
        OR
        (event_type = 'follow'
            AND anilist_id IS NULL AND episode IS NULL
            AND comment_id IS NULL AND target_user_id IS NOT NULL)
    )
);

CREATE INDEX idx_activity_events_feed
    ON activity_events (user_id, created_at DESC, id DESC);
CREATE INDEX idx_activity_events_anime_episode
    ON activity_events (anilist_id, episode, created_at DESC)
    WHERE anilist_id IS NOT NULL;

CREATE TABLE notifications (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    actor_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    notification_type text NOT NULL,
    comment_id uuid REFERENCES episode_comments(id) ON DELETE SET NULL,
    activity_event_id uuid REFERENCES activity_events(id) ON DELETE SET NULL,
    dedupe_key text NOT NULL,
    read_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT notifications_type_chk
        CHECK (notification_type IN ('reply', 'reaction', 'follow')),
    CONSTRAINT notifications_not_self_chk CHECK (user_id <> actor_id),
    CONSTRAINT notifications_dedupe_key_chk CHECK (char_length(dedupe_key) BETWEEN 1 AND 200),
    CONSTRAINT notifications_user_dedupe_uniq UNIQUE (user_id, dedupe_key)
);

CREATE INDEX idx_notifications_inbox
    ON notifications (user_id, created_at DESC, id DESC);
CREATE INDEX idx_notifications_unread
    ON notifications (user_id, created_at DESC)
    WHERE read_at IS NULL;

CREATE TABLE comment_reactions (
    comment_id uuid NOT NULL REFERENCES episode_comments(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reaction text NOT NULL DEFAULT 'like',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (comment_id, user_id),
    CONSTRAINT comment_reactions_reaction_chk CHECK (reaction IN ('like'))
);

CREATE INDEX idx_comment_reactions_user
    ON comment_reactions (user_id, created_at DESC);
