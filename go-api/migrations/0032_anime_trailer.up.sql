-- Trailer metadata is independent of Bangumi enrichment, so it gets its
-- own columns rather than riding the bangumi_version ratchet.
--
-- trailer_checked_at is a timestamp and not a boolean because the column
-- has to answer three questions, and a flag only answers the first:
--
--   NULL                     nobody has asked AniList about this row yet
--   <when we asked>          a nil trailer here is an answer, not a gap
--   < some cutoff            due to be asked again
--
-- The third one is the reason.  A work announced before its PV exists
-- gets one later, and a trailer on a site we do not support today may be
-- one we support tomorrow -- both are stored as "checked, none", which a
-- boolean can never distinguish from "checked, genuinely none" and can
-- never un-answer.  With a timestamp the re-sweep is a WHERE clause.
ALTER TABLE anime_cache
    ADD COLUMN trailer_id text,
    ADD COLUMN trailer_site text,
    ADD COLUMN trailer_checked_at timestamptz;

-- Metadata is stored as an id + site pair or not at all, only for the one
-- site the API promises, and only on a row we actually asked about.  The
-- id pattern is YouTube's 11-character video id; anything else is either
-- a malformed record or an embed URL smuggled into an id field, and both
-- must be refused at the column rather than at the caller.
ALTER TABLE anime_cache ADD CONSTRAINT anime_trailer_pair CHECK (
    (trailer_id IS NULL AND trailer_site IS NULL) OR
    (trailer_id IS NOT NULL AND trailer_site IS NOT NULL
     AND trailer_checked_at IS NOT NULL
     AND trailer_site = 'youtube'
     AND trailer_id ~ '^[A-Za-z0-9_-]{11}$')
);
