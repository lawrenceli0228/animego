-- Three more things AniList states about a title that the catalogue
-- never kept, plus the id behind a studio name.

-- Tags: the classification layer under genres.  AniList has ~600 of
-- them, each with a per-title rank (0-100, how strongly the community
-- applies it) and a spoiler flag; Bangumi has its own user-voted tags in
-- Chinese.  One table, keyed by source, because the reader wants "the
-- tags on this title" and the two sources are replaced independently:
-- the AniList set by the detail path and the facts sweep, the Bangumi
-- set by V2.  A delete scoped to one source cannot touch the other's rows.
CREATE TABLE anime_tags (
    anime_id   integer NOT NULL REFERENCES anime_cache(anilist_id) ON DELETE CASCADE,
    source     text    NOT NULL,
    name       text    NOT NULL,
    -- AniList: the 0-100 rank.  Bangumi: the vote count.  Same column
    -- because both mean "how much this tag applies", read with the
    -- source beside it.
    rank       integer,
    is_spoiler boolean NOT NULL DEFAULT false,
    PRIMARY KEY (anime_id, source, name),
    CONSTRAINT anime_tags_source_chk CHECK (source IN ('anilist', 'bangumi')),
    CONSTRAINT anime_tags_name_nonempty CHECK (name <> ''),
    CONSTRAINT anime_tags_rank_nonneg CHECK (rank IS NULL OR rank >= 0)
);

-- Reverse lookup for a tag hub page: every title carrying a tag.
CREATE INDEX anime_tags_source_name_idx ON anime_tags (source, name);

-- External links: official site, social, streaming.  Keyed by url,
-- because AniList's `site` is a display label ("Official Site",
-- "Twitter") and one title can have two of the same label.
CREATE TABLE anime_external_links (
    anime_id integer NOT NULL REFERENCES anime_cache(anilist_id) ON DELETE CASCADE,
    site     text    NOT NULL,
    url      text    NOT NULL,
    -- AniList's ExternalLinkType: INFO | STREAMING | SOCIAL.
    type     text,
    PRIMARY KEY (anime_id, url),
    CONSTRAINT anime_external_links_url_chk CHECK (url ~ '^https?://')
);

-- Studios: keep the name as the key (the detail page joins on it and
-- the row set is replaced per title), add AniList's id for the studio
-- page, and record whether AniList calls it a main studio -- the
-- document now asks for every studio on the title rather than only the
-- main ones, so the production committee and the licensor arrive too,
-- and the detail page's "Studio" row needs to know which is which.
ALTER TABLE anime_studios
    ADD COLUMN studio_id integer,
    ADD COLUMN is_main   boolean NOT NULL DEFAULT true;

CREATE INDEX anime_studios_studio_id_idx ON anime_studios (studio_id) WHERE studio_id IS NOT NULL;
ALTER TABLE anime_studios ADD CONSTRAINT anime_studios_id_positive CHECK (studio_id IS NULL OR studio_id > 0);

-- The facts sweep's document widens again (tags, external links), so
-- the stamps it set under the narrower document are void once more.
-- Same reasoning as 0036.
UPDATE anime_cache SET facts_checked_at = NULL;
