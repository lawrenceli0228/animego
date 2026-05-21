-- 0008_river_pending_use.down.sql  (rolls back 0008)

--
-- Drop `river_job.unique_states` and its index.
--

DROP INDEX river_job_unique_idx;

ALTER TABLE river_job
    DROP COLUMN unique_states;

CREATE UNIQUE INDEX IF NOT EXISTS river_job_kind_unique_key_idx ON river_job (kind, unique_key) WHERE unique_key IS NOT NULL;

--
-- Drop `river_job_state_in_bitmask` function.
--
DROP FUNCTION river_job_state_in_bitmask;

--
-- Revert to migration table based only on `(version)`.
--
-- If any non-main migrations are present, 005 is considered irreversible.
--

DO
$body$
BEGIN
    -- Tolerate users who may be using their own migration system rather than
    -- River's. If they are, they will have skipped version 001 containing
    -- `CREATE TABLE river_migration`, so this table won't exist.
    IF (SELECT to_regclass('river_migration') IS NOT NULL) THEN
        IF EXISTS (
            SELECT *
            FROM river_migration
            WHERE line <> 'main'
        ) THEN
            RAISE EXCEPTION 'Found non-main migration lines in the database; version 005 migration is irreversible because it would result in loss of migration information.';
        END IF;

        ALTER TABLE river_migration
            RENAME TO river_migration_old;

        CREATE TABLE river_migration(
            id bigserial PRIMARY KEY,
            created_at timestamptz NOT NULL DEFAULT NOW(),
            version bigint NOT NULL,
            CONSTRAINT version CHECK (version >= 1)
        );

        CREATE UNIQUE INDEX ON river_migration USING btree(version);

        INSERT INTO river_migration
            (created_at, version)
        SELECT created_at, version
        FROM river_migration_old;

        DROP TABLE river_migration_old;
    END IF;
END;
$body$
LANGUAGE 'plpgsql'; 

--
-- Drop `river_job.unique_key`.
--

ALTER TABLE river_job
    DROP COLUMN unique_key;

--
-- Drop `river_client` and derivative.
--

DROP TABLE river_client_queue;
DROP TABLE river_client;

