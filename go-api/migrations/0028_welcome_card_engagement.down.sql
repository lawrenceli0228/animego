-- Restore the 0020 vocabulary, which means discarding the counts 0028 added.
--
-- THE DELETE IS NOT OPTIONAL AND IS NOT TIDYING.  ADD CONSTRAINT ... CHECK
-- validates every existing row.  Any welcome_card_impression or
-- welcome_card_open row still present when the narrowed event_type_chk goes
-- back on would fail that validation and abort the rollback -- leaving the
-- schema in neither the 0027 nor the 0028 shape.  So the rows go first.
--
-- This loses data, and it should be understood as losing data rather than as
-- cleanup: rolling back past 0028 throws away every welcome-card count
-- collected while it was applied.  There is no way to keep them, because the
-- 0027 schema has no vocabulary that can represent them.  The counts are a
-- daily aggregate with no per-user rows behind them, so nothing can rebuild
-- them afterwards either -- a rollback is final for this series.
--
-- Ordering within the file is load-bearing: DELETE, then event_type_chk, then
-- target_chk.  Both constraints are restored to their 0020 text verbatim.

DELETE FROM community_engagement_daily
    WHERE event_type IN ('welcome_card_impression', 'welcome_card_open');

ALTER TABLE community_engagement_daily
    DROP CONSTRAINT community_engagement_event_type_chk;

ALTER TABLE community_engagement_daily
    ADD CONSTRAINT community_engagement_event_type_chk
        CHECK (event_type IN ('hot_discussions_impression', 'discussion_open'));

ALTER TABLE community_engagement_daily
    DROP CONSTRAINT community_engagement_target_chk;

ALTER TABLE community_engagement_daily
    ADD CONSTRAINT community_engagement_target_chk CHECK (
        (event_type = 'hot_discussions_impression'
            AND anilist_id = 0
            AND episode = 0)
        OR
        (event_type = 'discussion_open'
            AND anilist_id > 0
            AND episode > 0)
    );
