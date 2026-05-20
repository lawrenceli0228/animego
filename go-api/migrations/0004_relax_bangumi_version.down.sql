-- go-api/migrations/0004_relax_bangumi_version.down.sql
-- Restore the 0-2 bound.  NOTE: if any row has bangumi_version > 2, the
-- down migration will fail at constraint validation — that is intentional,
-- since downgrading the schema implies the data has been culled back too.

ALTER TABLE anime_cache DROP CONSTRAINT anime_cache_bangumi_version_chk;
ALTER TABLE anime_cache ADD CONSTRAINT anime_cache_bangumi_version_chk CHECK (bangumi_version BETWEEN 0 AND 2);
