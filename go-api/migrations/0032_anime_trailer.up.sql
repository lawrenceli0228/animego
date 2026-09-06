-- Trailer metadata is independent of Bangumi enrichment. A checked-null trailer
-- must remain distinguishable from rows that predate this migration.
ALTER TABLE anime_cache
    ADD COLUMN trailer_id text,
    ADD COLUMN trailer_site text,
    ADD COLUMN trailer_fetched boolean NOT NULL DEFAULT false;
ALTER TABLE anime_cache ADD CONSTRAINT anime_trailer_pair CHECK (
    (trailer_id IS NULL AND trailer_site IS NULL) OR
    (trailer_id IS NOT NULL AND trailer_site IS NOT NULL AND trailer_site = 'youtube' AND trailer_id ~ '^[A-Za-z0-9_-]{11}$')
);
