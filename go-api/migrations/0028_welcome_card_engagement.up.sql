-- Count the /welcome card that has been sitting in the discussion rail
-- untracked since 0020.
--
-- WHAT WAS MISSING.  HotDiscussions renders three kinds of thing into one
-- grid: a library guide strip, a pinned /welcome promo card, and N discussion
-- cards.  Only the discussion cards carry an onNavigate, so the rail can
-- answer "how often did someone open a discussion" but not "how often did
-- someone open the promo card sitting in the same grid, in the same card
-- shape, one slot above them".  That second number is the more useful of the
-- two for deciding what else belongs in that slot, and it was never recorded.
--
-- WHY THE EXISTING IMPRESSION CANNOT SERVE AS THE DENOMINATOR.  This is the
-- part that makes a second event necessary rather than merely tidy.
-- hot_discussions_impression is emitted by trackHotDiscussionsImpressionOnce,
-- which returns early when itemCount < 1.  The /welcome card is outside that
-- conditional -- it renders whether or not there are discussions to show, and
-- so does the empty state beside it.  So on every empty-list render the card
-- is visible and clickable while no impression is recorded at all.  Dividing
-- welcome_card_open by hot_discussions_impression would therefore divide by a
-- denominator that silently omits exactly those renders, and would report a
-- click rate higher than the true one by however often the rail is empty.
--
-- welcome_card_impression is emitted on mount with no count gate, so the pair
-- (welcome_card_impression, welcome_card_open) is self-consistent.  A useful
-- side effect: the gap between welcome_card_impression and
-- hot_discussions_impression is now a direct measure of how often the rail
-- renders empty, which nothing previously recorded either.
--
-- WHY TWO CONSTRAINTS MOVE, NOT ONE.  0020 wrote the target rule as a closed
-- OR over exactly two branches, each naming its event_type literally:
--
--     (event_type = 'hot_discussions_impression' AND anilist_id = 0 AND episode = 0)
--     OR
--     (event_type = 'discussion_open' AND anilist_id > 0 AND episode > 0)
--
-- A new event_type that is added only to community_engagement_event_type_chk
-- passes that check and is then rejected by this one, because it matches
-- neither branch.  The failure is a constraint violation on every insert of
-- the new type -- loud, but only at runtime, and only once the client is
-- already deployed and emitting.  Both constraints have to move together, in
-- this file.
--
-- The rewrite below regroups the branches by target shape rather than by
-- event: one branch for events that name no anime, one for the single event
-- that does.  It stays closed -- a typo'd event_type still matches no branch
-- and is still rejected -- but a future untargeted event is now one line in an
-- IN-list rather than a fourth OR arm.  event_type_chk remains the place where
-- the vocabulary itself is declared.
--
-- The source vocabulary is left alone.  Both new events are emitted from the
-- homepage, so 'home' already covers them; community_engagement_source_chk
-- does not move.

ALTER TABLE community_engagement_daily
    DROP CONSTRAINT community_engagement_event_type_chk;

ALTER TABLE community_engagement_daily
    ADD CONSTRAINT community_engagement_event_type_chk
        CHECK (event_type IN (
            'hot_discussions_impression',
            'discussion_open',
            'welcome_card_impression',
            'welcome_card_open'
        ));

ALTER TABLE community_engagement_daily
    DROP CONSTRAINT community_engagement_target_chk;

ALTER TABLE community_engagement_daily
    ADD CONSTRAINT community_engagement_target_chk CHECK (
        (event_type IN (
            'hot_discussions_impression',
            'welcome_card_impression',
            'welcome_card_open'
         ) AND anilist_id = 0 AND episode = 0)
        OR
        (event_type = 'discussion_open'
            AND anilist_id > 0
            AND episode > 0)
    );
