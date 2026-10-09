-- 0047: edits readers submit to person and character pages, the admin
-- review of them, and the overlay layer accepted values are read from.
--
-- Three tables and one widened one:
--
--   edit_submissions  one submission: who, which page, the source they cite,
--                     an optional note, and the review's outcome.
--   edit_items        one row per changed field (a voice row or a role on
--                     one title counts as a field): the value the submitter
--                     saw, the value they propose, and the admin's decision.
--                     A submission is reviewed item by item, so it can be
--                     partly accepted; a rejected item always carries the
--                     note the submitter is told.
--   entity_overlays   per person or character, the values admins accepted,
--                     as one JSON object (internal/overlay.Doc).  Every
--                     read applies it over AniList's and Bangumi's values:
--                     overlay > Bangumi's Chinese name > AniList.
--   notifications     learn the type 'edit_review', which points at the
--                     submission it reports on.
--
-- ★ Accepted values never go into the tables AniList refreshes or the
-- sweeps overwrite (anime_characters, anime_character_voices, anime_staff,
-- people, characters).  Those are rewritten from upstream on their own
-- schedules; a value written into them would last until the next refresh.
-- entity_overlays is written by the review and by nothing else.
--
-- ★ notifications_type_chk is rewritten as the union of 0046's types and
-- 'edit_review'.  0046 (the community tab) widens the same constraint to
-- ('reply', 'reaction', 'follow', 'thread_reply', 'activity_reply'), and a
-- CHECK cannot be widened twice without the second statement naming every
-- value the first one added.  This file is meant to run after 0046; a
-- database without 0046 (this branch alone) accepts the two community
-- types with nothing writing them, which is harmless.  If 0046's list
-- changes before it ships, this list must change with it.
--
-- ★ Locks.  The file runs as one transaction.  The ALTERs on notifications
-- take ACCESS EXCLUSIVE and re-validate its rows (a small table); the new
-- foreign keys take SHARE ROW EXCLUSIVE on users (writes wait, reads do
-- not).  No credit table, profile table or anime_cache is touched:
-- TestMigration0047_PG applies the file while those are locked.

SET lock_timeout = '3s';

CREATE TABLE edit_submissions (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind           text NOT NULL,
    entity_id      integer NOT NULL,
    -- The page as the submitter saw it: its names, its image and the title
    -- it hangs under, for the review queue and the submitter's
    -- notification, which should not need the page rebuilt to say what
    -- the submission was about.
    snapshot       jsonb NOT NULL,
    source_url     text NOT NULL,
    note           text,
    status         text NOT NULL DEFAULT 'pending',
    item_count     smallint NOT NULL,
    accepted_count smallint NOT NULL DEFAULT 0,
    rejected_count smallint NOT NULL DEFAULT 0,
    reviewed_by    uuid REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at    timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT edit_submissions_kind_chk CHECK (kind IN ('character', 'person')),
    CONSTRAINT edit_submissions_entity_chk CHECK (entity_id > 0),
    CONSTRAINT edit_submissions_snapshot_chk CHECK (jsonb_typeof(snapshot) = 'object'),
    CONSTRAINT edit_submissions_source_chk CHECK (char_length(source_url) BETWEEN 1 AND 500),
    CONSTRAINT edit_submissions_note_chk CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 500),
    CONSTRAINT edit_submissions_items_chk CHECK (item_count BETWEEN 1 AND 50),
    -- Pending: nothing decided.  Reviewed: every item decided, and when.
    -- reviewed_by may go NULL later (the admin's account is gone).
    CONSTRAINT edit_submissions_review_chk CHECK (
        (status = 'pending'
            AND reviewed_at IS NULL AND reviewed_by IS NULL
            AND accepted_count = 0 AND rejected_count = 0)
        OR
        (status = 'reviewed'
            AND reviewed_at IS NOT NULL
            AND accepted_count >= 0 AND rejected_count >= 0
            AND accepted_count + rejected_count = item_count)
    )
);

-- The queue, oldest first, and the reviewed list, newest first.
CREATE INDEX edit_submissions_pending_idx
    ON edit_submissions (created_at, id) WHERE status = 'pending';
CREATE INDEX edit_submissions_reviewed_idx
    ON edit_submissions (reviewed_at DESC, id DESC) WHERE status = 'reviewed';
-- A submitter's own history: the rate limits count it, the queue shows it.
CREATE INDEX edit_submissions_user_idx
    ON edit_submissions (user_id, created_at DESC);
-- One open submission per person per page.  A second one waits for the
-- first to be reviewed rather than queueing beside it.
CREATE UNIQUE INDEX edit_submissions_one_pending_uidx
    ON edit_submissions (user_id, kind, entity_id) WHERE status = 'pending';

CREATE TABLE edit_items (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    submission_id uuid NOT NULL REFERENCES edit_submissions(id) ON DELETE CASCADE,
    position      smallint NOT NULL,
    field         text NOT NULL,
    -- Which voice row or which title, for the fields that come in several;
    -- '' for the rest.
    item_key      text NOT NULL DEFAULT '',
    -- JSON null is "no value" on either side: a fact being filled in, a
    -- fact being cleared, a voice being added or removed.
    old_value     jsonb NOT NULL,
    new_value     jsonb NOT NULL,
    -- What the review shows beside the values (a role's title).
    meta          jsonb,
    status        text NOT NULL DEFAULT 'pending',
    reject_note   text,
    CONSTRAINT edit_items_field_chk CHECK (field IN (
        'nameCn', 'nameNative', 'nameFull', 'aliases', 'occupations', 'image',
        'gender', 'age', 'birth', 'bloodType', 'homeTown', 'description',
        'voice', 'role'
    )),
    CONSTRAINT edit_items_status_chk CHECK (status IN ('pending', 'accepted', 'rejected')),
    -- A rejected item always says why; nothing else carries a note.
    CONSTRAINT edit_items_reject_note_chk CHECK (
        (status = 'rejected') = (reject_note IS NOT NULL)
    ),
    CONSTRAINT edit_items_reject_note_length_chk CHECK (
        reject_note IS NULL OR char_length(btrim(reject_note)) BETWEEN 1 AND 500
    ),
    CONSTRAINT edit_items_field_once_uniq UNIQUE (submission_id, field, item_key),
    CONSTRAINT edit_items_position_uniq UNIQUE (submission_id, position)
);

CREATE TABLE entity_overlays (
    kind       text NOT NULL,
    entity_id  integer NOT NULL,
    data       jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
    PRIMARY KEY (kind, entity_id),
    CONSTRAINT entity_overlays_kind_chk CHECK (kind IN ('character', 'person')),
    CONSTRAINT entity_overlays_entity_chk CHECK (entity_id > 0),
    CONSTRAINT entity_overlays_data_chk CHECK (jsonb_typeof(data) = 'object')
);

-- ---------------------------------------------------------------------------
-- notifications: the outcome of a review, to the person who submitted
-- ---------------------------------------------------------------------------

-- CASCADE: a submission deleted with its submitter's account takes the
-- notification about it along.
ALTER TABLE notifications
    ADD COLUMN edit_submission_id uuid REFERENCES edit_submissions(id) ON DELETE CASCADE;

ALTER TABLE notifications DROP CONSTRAINT notifications_type_chk;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_chk
    CHECK (notification_type IN (
        'reply', 'reaction', 'follow', 'thread_reply', 'activity_reply', 'edit_review'
    ));

ALTER TABLE notifications ADD CONSTRAINT notifications_edit_target_chk
    CHECK (notification_type <> 'edit_review' OR edit_submission_id IS NOT NULL);

CREATE INDEX idx_notifications_edit_submission
    ON notifications (edit_submission_id)
    WHERE edit_submission_id IS NOT NULL;
