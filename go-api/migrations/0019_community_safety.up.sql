-- 0019: community safety primitives.
--
-- Spoiler labels let readers opt in before revealing episode discussion.
-- Blocks are directional records, while read/write policy treats either
-- direction as a blocked relationship. Reports retain a small moderation
-- workflow and deduplicate an already-pending report for the same target.

ALTER TABLE episode_comments
    ADD COLUMN is_spoiler boolean NOT NULL DEFAULT false;

CREATE TABLE user_blocks (
    blocker_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (blocker_id, blocked_id),
    CONSTRAINT user_blocks_not_self_chk CHECK (blocker_id <> blocked_id)
);

CREATE INDEX idx_user_blocks_blocked
    ON user_blocks (blocked_id, created_at DESC);

CREATE TABLE reports (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    reporter_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_type text NOT NULL,
    target_comment_id uuid REFERENCES episode_comments(id) ON DELETE SET NULL,
    target_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    target_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
    reason text NOT NULL,
    details text,
    status text NOT NULL DEFAULT 'pending',
    resolution_note text,
    reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT reports_target_type_chk
        CHECK (target_type IN ('comment', 'user')),
    -- The matching target id may become NULL through ON DELETE SET NULL. The
    -- snapshot preserves the moderation evidence, while this constraint still
    -- prevents a report from ever pointing at the wrong target kind or both.
    CONSTRAINT reports_target_shape_chk CHECK (
        (target_type = 'comment' AND target_user_id IS NULL)
        OR
        (target_type = 'user' AND target_comment_id IS NULL)
    ),
    CONSTRAINT reports_reason_chk CHECK (
        reason IN (
            'spam',
            'harassment',
            'hate_speech',
            'sexual_content',
            'violence',
            'spoiler',
            'misinformation',
            'other'
        )
    ),
    CONSTRAINT reports_details_length_chk
        CHECK (details IS NULL OR char_length(details) <= 500),
    CONSTRAINT reports_resolution_note_length_chk
        CHECK (resolution_note IS NULL OR char_length(resolution_note) <= 1000),
    CONSTRAINT reports_status_chk
        CHECK (status IN ('pending', 'reviewing', 'resolved', 'dismissed'))
);

CREATE UNIQUE INDEX reports_pending_comment_uniq
    ON reports (reporter_id, target_comment_id)
    WHERE status = 'pending' AND target_type = 'comment';

CREATE UNIQUE INDEX reports_pending_user_uniq
    ON reports (reporter_id, target_user_id)
    WHERE status = 'pending' AND target_type = 'user';

CREATE INDEX idx_reports_moderation_queue
    ON reports (status, created_at ASC, id ASC);
