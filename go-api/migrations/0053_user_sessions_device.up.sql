-- 0053: what each session was signed in with, for the settings page's
-- device list ("Mac · Chrome · Shanghai · 2 小时前").
--
-- user_agent is the raw User-Agent header, cut to 512 characters. It is kept
-- raw and parsed when read (auth.ParseUserAgent), so a better parser names
-- old rows correctly too. country and city come from Cloudflare's visitor
-- location request headers: CF-IPCountry (ISO 3166-1 alpha-2) whenever IP
-- geolocation is on for the zone, CF-IPCity only when the "Add visitor
-- location headers" managed transform is. No IP address is stored, here or
-- anywhere in the session.
--
-- All three are written when a session is opened (login, register, adoption
-- of a pre-0052 token) and refreshed on every rotation, so a session shows
-- where it was last used from, not where it started. NULL means "not
-- stated": a session opened before this migration until its next rotation,
-- a request without the header, or a value that failed validation.
ALTER TABLE user_sessions
    ADD COLUMN user_agent text,
    ADD COLUMN country text,
    ADD COLUMN city text,
    ADD CONSTRAINT user_sessions_user_agent_len_chk CHECK (char_length(user_agent) <= 512),
    ADD CONSTRAINT user_sessions_country_chk CHECK (country ~ '^[A-Z]{2}$'),
    ADD CONSTRAINT user_sessions_city_len_chk CHECK (char_length(city) BETWEEN 1 AND 80);
