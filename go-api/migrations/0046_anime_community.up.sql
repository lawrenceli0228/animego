-- 0046: the community tab of an anime page -- reviews, discussion threads,
-- replies, and the activity a subscription leaves behind.
--
-- Six changes, in this order:
--
--   1. activity_events learns a fourth event type, 'status': a subscription
--      changed state (started, completed, plans to watch, dropped).  It is
--      what the tab's 最近动态 lists ("看完了"), and the subscription writes
--      in queries/subscriptions.sql append it in the same statement as the
--      change.  The 90-day prune (0021) only ever deleted 'watch_progress',
--      so status events -- and the replies and likes hanging off them --
--      are kept.
--   2. anime_reviews: a one-line summary and a body.  No score column, on
--      purpose: the community tab shows no score anywhere.
--   3. anime_review_votes: one "有用" (helpful) vote per user per review.
--   4. anime_threads: discussion threads.
--   5. community_replies: the replies under a thread OR an activity event.
--      One table rather than two because the two are the same object --
--      author, text, soft delete, report target, notification -- reached
--      from two parents; an exclusive arc keeps exactly one parent set.
--   6. activity_likes: one like per user per activity event.
--
-- and three existing tables widen to point at them: notifications (a reply
-- notifies the owner of what it replies to), reports (reviews, threads and
-- replies can be reported) and activity_events itself.
--
-- ★ Deletes are soft.  A review, thread or reply gets deleted_at /
-- deleted_by and stays: reports keep pointing at real rows, a removed
-- reply under a thread does not renumber anything, and an admin removal is
-- recorded as such.  deleted_by is the author or the admin who removed it.
-- Hard deletes still happen through the foreign keys when a user or an
-- anime is deleted.
--
-- ★ Locks.  The file runs as one transaction.  The ALTERs on
-- activity_events, notifications and reports take ACCESS EXCLUSIVE and the
-- CHECKs re-validate those tables' rows while holding it; all three are
-- small (activity_events is pruned to 90 days of watch progress).  The new
-- foreign keys take SHARE ROW EXCLUSIVE on users and anime_cache -- writes
-- wait, reads do not.  lock_timeout makes the deploy fail fast instead of
-- queueing every login behind a long transaction, the same call 0025 made.
--
-- ★ The binary that predates this file keeps working against it: it never
-- writes a 'status' event or the new notification and report types, and
-- every constraint below still admits every row it writes.

SET lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- 1. activity_events: subscription status events
-- ---------------------------------------------------------------------------

ALTER TABLE activity_events ADD COLUMN status text;

ALTER TABLE activity_events DROP CONSTRAINT activity_events_type_chk;
ALTER TABLE activity_events ADD CONSTRAINT activity_events_type_chk
    CHECK (event_type IN ('watch_progress', 'comment', 'follow', 'status'));

-- The 0018 shape, with `status IS NULL` added to the three existing arms and
-- one arm for the new type.  A status event names an anime and the status it
-- moved to -- the same four values subscriptions_status_chk admits.
ALTER TABLE activity_events DROP CONSTRAINT activity_events_shape_chk;
ALTER TABLE activity_events ADD CONSTRAINT activity_events_shape_chk CHECK (
    (event_type = 'watch_progress'
        AND anilist_id IS NOT NULL AND episode IS NOT NULL
        AND comment_id IS NULL AND target_user_id IS NULL AND status IS NULL)
    OR
    (event_type = 'comment'
        AND anilist_id IS NOT NULL AND episode IS NOT NULL
        AND comment_id IS NOT NULL AND target_user_id IS NULL AND status IS NULL)
    OR
    (event_type = 'follow'
        AND anilist_id IS NULL AND episode IS NULL
        AND comment_id IS NULL AND target_user_id IS NOT NULL AND status IS NULL)
    OR
    (event_type = 'status'
        AND anilist_id IS NOT NULL AND episode IS NULL
        AND comment_id IS NULL AND target_user_id IS NULL
        -- IS NOT NULL first: `NULL IN (...)` is NULL, and a CHECK that
        -- evaluates to NULL passes.
        AND status IS NOT NULL
        AND status IN ('watching', 'completed', 'plan_to_watch', 'dropped'))
);

-- The tab's activity list: one anime's status events, newest first.
CREATE INDEX idx_activity_events_anime_status
    ON activity_events (anilist_id, created_at DESC, id DESC)
    WHERE event_type = 'status';

-- ---------------------------------------------------------------------------
-- 2. anime_reviews
-- ---------------------------------------------------------------------------

-- Lengths are in characters (char_length counts code points, the same thing
-- the handler's utf8.RuneCountInString and the page's Array.from count).
-- The handler checks them first so the answer is a 400 with a message; these
-- are the floor if anything else ever writes the table.
CREATE TABLE anime_reviews (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    anilist_id  integer NOT NULL REFERENCES anime_cache(anilist_id) ON DELETE CASCADE,
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    summary     text NOT NULL,
    body        text NOT NULL,
    -- The whole review gives the plot away: the list folds it.
    is_spoiler  boolean NOT NULL DEFAULT false,
    -- Only the author can read it, anywhere.
    is_private  boolean NOT NULL DEFAULT false,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    deleted_at  timestamptz,
    deleted_by  uuid REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT anime_reviews_summary_length_chk
        CHECK (char_length(summary) BETWEEN 10 AND 60),
    CONSTRAINT anime_reviews_body_length_chk
        CHECK (char_length(body) BETWEEN 300 AND 20000),
    -- deleted_by may go NULL later (the deleter's account is gone); a
    -- deleter on a live row is never valid.
    CONSTRAINT anime_reviews_deleted_by_chk
        CHECK (deleted_by IS NULL OR deleted_at IS NOT NULL)
);

-- One live review per user per anime.  Partial, so deleting a review frees
-- the slot for a new one.
CREATE UNIQUE INDEX anime_reviews_one_live_per_user
    ON anime_reviews (anilist_id, user_id)
    WHERE deleted_at IS NULL;

CREATE INDEX idx_anime_reviews_anime
    ON anime_reviews (anilist_id, created_at DESC)
    WHERE deleted_at IS NULL;

-- Covers the user_id foreign key (a user delete cascades through it) and
-- the per-user lookups.
CREATE INDEX idx_anime_reviews_user ON anime_reviews (user_id);

-- ---------------------------------------------------------------------------
-- 3. anime_review_votes
-- ---------------------------------------------------------------------------

-- Presence is the vote.  There is no "not helpful" row: the list sorts by
-- how many found a review helpful, and nothing else.
CREATE TABLE anime_review_votes (
    review_id   uuid NOT NULL REFERENCES anime_reviews(id) ON DELETE CASCADE,
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (review_id, user_id)
);

CREATE INDEX idx_anime_review_votes_user ON anime_review_votes (user_id);

-- ---------------------------------------------------------------------------
-- 4. anime_threads
-- ---------------------------------------------------------------------------

CREATE TABLE anime_threads (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    anilist_id        integer NOT NULL REFERENCES anime_cache(anilist_id) ON DELETE CASCADE,
    user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title             text NOT NULL,
    body              text NOT NULL,
    is_spoiler        boolean NOT NULL DEFAULT false,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    -- Moves on every reply, so the list puts live conversations first.
    last_activity_at  timestamptz NOT NULL DEFAULT now(),
    deleted_at        timestamptz,
    deleted_by        uuid REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT anime_threads_title_length_chk
        CHECK (char_length(title) BETWEEN 4 AND 80),
    CONSTRAINT anime_threads_body_length_chk
        CHECK (char_length(body) BETWEEN 1 AND 5000),
    CONSTRAINT anime_threads_deleted_by_chk
        CHECK (deleted_by IS NULL OR deleted_at IS NOT NULL)
);

CREATE INDEX idx_anime_threads_anime
    ON anime_threads (anilist_id, last_activity_at DESC, id DESC)
    WHERE deleted_at IS NULL;

CREATE INDEX idx_anime_threads_user ON anime_threads (user_id);

-- ---------------------------------------------------------------------------
-- 5. community_replies
-- ---------------------------------------------------------------------------

CREATE TABLE community_replies (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Denormalised from the parent, so a notification, a report or a
    -- moderator can place a reply without knowing which parent it has.
    anilist_id         integer NOT NULL REFERENCES anime_cache(anilist_id) ON DELETE CASCADE,
    thread_id          uuid REFERENCES anime_threads(id) ON DELETE CASCADE,
    activity_event_id  uuid REFERENCES activity_events(id) ON DELETE CASCADE,
    -- A reply to another reply under the same parent ("回复 @某人").  SET
    -- NULL, not CASCADE: a reply outlives the hard delete of the one it
    -- answered.  The writer checks the parent shares the reply's parent.
    parent_id          uuid REFERENCES community_replies(id) ON DELETE SET NULL,
    user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body               text NOT NULL,
    is_spoiler         boolean NOT NULL DEFAULT false,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    deleted_at         timestamptz,
    deleted_by         uuid REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT community_replies_one_parent_chk
        CHECK (num_nonnulls(thread_id, activity_event_id) = 1),
    CONSTRAINT community_replies_body_length_chk
        CHECK (char_length(body) BETWEEN 1 AND 500),
    CONSTRAINT community_replies_deleted_by_chk
        CHECK (deleted_by IS NULL OR deleted_at IS NOT NULL)
);

CREATE INDEX idx_community_replies_thread
    ON community_replies (thread_id, created_at, id)
    WHERE thread_id IS NOT NULL;
CREATE INDEX idx_community_replies_activity
    ON community_replies (activity_event_id, created_at, id)
    WHERE activity_event_id IS NOT NULL;
CREATE INDEX idx_community_replies_parent
    ON community_replies (parent_id)
    WHERE parent_id IS NOT NULL;
CREATE INDEX idx_community_replies_user ON community_replies (user_id);
CREATE INDEX idx_community_replies_anime ON community_replies (anilist_id);

-- ---------------------------------------------------------------------------
-- 6. activity_likes
-- ---------------------------------------------------------------------------

CREATE TABLE activity_likes (
    activity_event_id  uuid NOT NULL REFERENCES activity_events(id) ON DELETE CASCADE,
    user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at         timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (activity_event_id, user_id)
);

CREATE INDEX idx_activity_likes_user ON activity_likes (user_id);

-- ---------------------------------------------------------------------------
-- notifications: replies to a thread or to an activity event
-- ---------------------------------------------------------------------------

-- CASCADE: a reply that is hard-deleted takes its notification with it.  A
-- soft delete removes the notification in the same statement (see
-- queries/anime_community.sql), so an inbox never links to a removed reply.
ALTER TABLE notifications
    ADD COLUMN reply_id uuid REFERENCES community_replies(id) ON DELETE CASCADE;

ALTER TABLE notifications DROP CONSTRAINT notifications_type_chk;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_chk
    CHECK (notification_type IN (
        'reply', 'reaction', 'follow', 'thread_reply', 'activity_reply'
    ));

-- The two new types always carry the reply they are about.
ALTER TABLE notifications ADD CONSTRAINT notifications_reply_target_chk
    CHECK (
        notification_type NOT IN ('thread_reply', 'activity_reply')
        OR reply_id IS NOT NULL
    );

CREATE INDEX idx_notifications_reply
    ON notifications (reply_id)
    WHERE reply_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- reports: reviews, threads and replies as targets
-- ---------------------------------------------------------------------------

ALTER TABLE reports
    ADD COLUMN target_review_id uuid REFERENCES anime_reviews(id) ON DELETE SET NULL,
    ADD COLUMN target_thread_id uuid REFERENCES anime_threads(id) ON DELETE SET NULL,
    ADD COLUMN target_reply_id  uuid REFERENCES community_replies(id) ON DELETE SET NULL;

ALTER TABLE reports DROP CONSTRAINT reports_target_type_chk;
ALTER TABLE reports ADD CONSTRAINT reports_target_type_chk
    CHECK (target_type IN ('comment', 'user', 'review', 'thread', 'reply'));

-- Each kind may carry only its own id (which ON DELETE SET NULL can still
-- empty -- the snapshot keeps the evidence, as 0019 says).
ALTER TABLE reports DROP CONSTRAINT reports_target_shape_chk;
ALTER TABLE reports ADD CONSTRAINT reports_target_shape_chk CHECK (
    (target_type = 'comment'
        AND target_user_id IS NULL AND target_review_id IS NULL
        AND target_thread_id IS NULL AND target_reply_id IS NULL)
    OR
    (target_type = 'user'
        AND target_comment_id IS NULL AND target_review_id IS NULL
        AND target_thread_id IS NULL AND target_reply_id IS NULL)
    OR
    (target_type = 'review'
        AND target_comment_id IS NULL AND target_user_id IS NULL
        AND target_thread_id IS NULL AND target_reply_id IS NULL)
    OR
    (target_type = 'thread'
        AND target_comment_id IS NULL AND target_user_id IS NULL
        AND target_review_id IS NULL AND target_reply_id IS NULL)
    OR
    (target_type = 'reply'
        AND target_comment_id IS NULL AND target_user_id IS NULL
        AND target_review_id IS NULL AND target_thread_id IS NULL)
);

-- One pending report per reporter per target, as 0019 does for comments
-- and users.
CREATE UNIQUE INDEX reports_pending_review_uniq
    ON reports (reporter_id, target_review_id)
    WHERE status = 'pending' AND target_type = 'review';
CREATE UNIQUE INDEX reports_pending_thread_uniq
    ON reports (reporter_id, target_thread_id)
    WHERE status = 'pending' AND target_type = 'thread';
CREATE UNIQUE INDEX reports_pending_reply_uniq
    ON reports (reporter_id, target_reply_id)
    WHERE status = 'pending' AND target_type = 'reply';
