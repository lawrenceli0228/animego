-- 0010_refresh_token_grace.up.sql
-- Add grace-window columns for refresh-token rotation.
--
-- Context: near-simultaneous refresh requests (Next.js RSC prefetch +
-- navigation) race on the same refresh token.  The first request rotates
-- (writes a new refresh_token), the second arrives with the now-old token
-- and gets a 401.
--
-- Fix: keep the immediately-previous token for 30 s.  The Refresh handler
-- accepts either the current OR the previous token (within the window).
-- A "grace hit" re-issues a new ACCESS token and re-sets the refresh cookie
-- to the CURRENT refresh_token so the client catches up — no re-rotation.

ALTER TABLE users
    ADD COLUMN previous_refresh_token TEXT,
    ADD COLUMN refresh_rotated_at     TIMESTAMPTZ;
