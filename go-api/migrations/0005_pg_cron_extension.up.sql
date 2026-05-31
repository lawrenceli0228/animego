-- go-api/migrations/0005_pg_cron_extension.up.sql
-- Re-enable pg_cron now that the dev + test postgres image bundles it
-- (see go-api/docker/postgres/Dockerfile).  0001 commented this out
-- because postgres:16-alpine lacks the control file; that constraint
-- no longer applies.

CREATE EXTENSION IF NOT EXISTS pg_cron;
