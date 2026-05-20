-- go-api/migrations/0004_relax_bangumi_version.up.sql
-- Prod data exposed via P1.E uses bangumi_version = 3 for the bulk of rows
-- (6422 / 6425) with no upper-bound semantics intended.  The original CHECK
-- (BETWEEN 0 AND 2) reflected a stale comment from v1 of the AniList/Bangumi
-- enrichment pipeline and would block the migration.  Relaxing to "non-negative"
-- preserves the integrity check while accommodating future phase numbers
-- without another migration.

ALTER TABLE anime_cache DROP CONSTRAINT anime_cache_bangumi_version_chk;
ALTER TABLE anime_cache ADD CONSTRAINT anime_cache_bangumi_version_chk CHECK (bangumi_version >= 0);
