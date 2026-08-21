-- 0022: Traditional Chinese title and synopsis for anime_cache.
--
-- The site has three published locales but only two scripts of Chinese text.
-- A zh-Hant reader currently gets Simplified prose under a Traditional URL,
-- which is worse than getting nothing: it reads as a broken translation
-- rather than an absent one, and Google sees two locales serving byte
-- identical bodies.
--
-- Three columns per field rather than one, and the third is the one that is
-- easy to skip:
--
--   *_hant              the text
--   *_hant_source       where it came from
--   *_hant_source_hash  a digest of the input that produced it
--
-- The hash exists because provenance goes stale silently.  A row whose
-- title_hant was machine converted from title_chinese keeps that conversion
-- forever after the Bangumi enrichment rewrites title_chinese underneath it,
-- and nothing in the schema notices.  0014_description_cn.up.sql:15 predicted
-- this exact gap and deferred the column to "the phase that does machine
-- translation".  This is that phase.  The digest covers the input string the
-- writer consumed, whichever tier it came from, so a re-run can ask "is this
-- still derived from what it claims?" without re-deriving it.
--
-- Provenance vocabulary, in precedence order (the writers enforce the order,
-- the CHECK only constrains the vocabulary -- same division of labour as
-- 0014):
--
--   manual     a human decided
--   wikipedia  Module:CGroup/Anime zh-hk, the only Hong Kong source that
--              exists.  Measured coverage is 541 of 17,511 rows.
--   anilist    soruly/anilist-chinese, keyed by AniList id, Taiwan usage.
--              Measured coverage is 7,862 of 17,511 rows and 88.9% of the
--              titles anyone here is actually subscribed to.
--   opencc     s2twp character + vocabulary conversion of title_chinese.
--              Fills the tail.  MUST NOT reach a search engine -- see below.

ALTER TABLE anime_cache
    ADD COLUMN IF NOT EXISTS title_hant text,
    ADD COLUMN IF NOT EXISTS title_hant_source text,
    ADD COLUMN IF NOT EXISTS title_hant_source_hash text,
    ADD COLUMN IF NOT EXISTS description_hant text,
    ADD COLUMN IF NOT EXISTS description_hant_source text,
    ADD COLUMN IF NOT EXISTS description_hant_source_hash text;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'anime_cache_title_hant_source_check'
    ) THEN
        ALTER TABLE anime_cache
            ADD CONSTRAINT anime_cache_title_hant_source_check
            CHECK (title_hant_source IN ('wikipedia', 'anilist', 'opencc', 'manual')
                   OR title_hant_source IS NULL);
    END IF;

    -- Narrower on purpose.  No dataset carries a Traditional synopsis, so
    -- description_hant can only ever be a conversion of description_cn or
    -- something a human wrote.  Admitting 'anilist' or 'wikipedia' here would
    -- describe a tier that does not exist.
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'anime_cache_description_hant_source_check'
    ) THEN
        ALTER TABLE anime_cache
            ADD CONSTRAINT anime_cache_description_hant_source_check
            CHECK (description_hant_source IN ('opencc', 'manual')
                   OR description_hant_source IS NULL);
    END IF;
END $$;

-- The SERP boundary, expressed as a column instead of a convention.
--
-- The rule is that a machine converted title must never appear in <title>,
-- og:title, or JSON-LD name.  Simplified-to-Traditional conversion is a
-- character mapping with a vocabulary layer bolted on; it does not know that
-- 進擊的巨人 is what Taiwan calls the show and it will not invent 鬼滅之刃
-- from 鬼灭之刃's neighbours.  Measured sentence accuracy is 85.3%, and the
-- 15.4% it cannot produce correlates with popularity -- so the errors land
-- precisely on the titles people search for.  A wrong title in a search
-- result is the least reversible mistake available here, because it is what
-- Google learns the page is about.
--
-- 0014 wrote that rule in a comment and left enforcement to the writers.
-- That is enough when one job writes the column.  It is not enough now: nine
-- hand-written DTOs and forty-odd render sites can all reach title_hant, and
-- a reviewer cannot see from a call site whether the value beneath it was
-- machine made.  So the safe value gets its own column and the SEO code reads
-- that one.  Being handed NULL is a correct answer -- the renderer already
-- falls back through the ladder.
--
-- The expression is a whitelist rather than "<> 'opencc'" deliberately.  If a
-- later migration widens the source vocabulary and forgets this line, the new
-- tier is excluded from search results rather than silently admitted to them.
-- Admitting a source to the SERP should cost a migration.
ALTER TABLE anime_cache
    ADD COLUMN IF NOT EXISTS title_hant_seo text
    GENERATED ALWAYS AS (
        CASE WHEN title_hant_source IN ('wikipedia', 'anilist', 'manual')
             THEN title_hant
        END
    ) STORED;

-- No index, and that is a decision rather than an omission.
--
-- The backfill reads every row once from a vendored file and writes in
-- batches; it has no candidate query to accelerate.  The admin counters are
-- unfiltered count(*) aggregates, which scan whatever happens.  And the query
-- that would actually benefit -- "which rows have a stale source hash?" --
-- has to recompute the digest to know, so no index can answer it.
--
-- 0014 shipped a partial index for a candidate query, and 0015 dropped it
-- eight lines into its own migration once the real access pattern showed up.
-- Repeating that here would cost a table-sized index to serve nothing.  If a
-- periodic top-up job later needs one, it lands with the job.
--
-- Two known gaps, recorded so they are not rediscovered as bugs:
--
--   search_vec (0001:57) is GENERATED over the four original title columns
--   and does not include title_hant.  Widening it on PostgreSQL 16 means
--   dropping and re-adding the column plus rebuilding the GIN index, and
--   search_vec has no application consumer at all -- it appears only in
--   0001, 0002 and two migration tests.  Not worth a table rewrite.
--
--   Simplified/Traditional folding in search is still not done.  A reader who
--   types 進擊的巨人 will not match the title_chinese trigram index, exactly
--   as anime/handlers.go:484 already warns.  That is a search change, not a
--   locale change, and it is out of scope here.
