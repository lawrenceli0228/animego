-- 0009_users_email_lowercase.up.sql
-- Enforce email lowercase invariant at the schema level.
--
-- Mongoose set `lowercase: true` on User.email which auto-lowercased on
-- save.  The PG schema had email as plain text + UNIQUE; a Go-side bug
-- (or a tool inserting unnormalised emails) could land
-- ("Foo@x.com", "foo@x.com") as two distinct rows, bypassing UNIQUE.
--
-- Two-phase fix:
--   1. Normalise existing rows in case prod migration ever ran with
--      mixed-case data.  Postgres UNIQUE rejects this UPDATE if two
--      rows would collide — that's the right failure mode (we'd want
--      to know).  See the down migration for rollback.
--   2. Add CHECK (email = lower(email)) so future inserts fail loudly
--      instead of silently creating dup-resistant collisions.

BEGIN;

UPDATE users
SET email = lower(email)
WHERE email <> lower(email);

ALTER TABLE users
    ADD CONSTRAINT users_email_lowercase_chk
    CHECK (email = lower(email));

COMMIT;
