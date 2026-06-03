-- 0012 user personalization: pass photo (avatar) + chosen backdrop anime.
--
-- avatar_url stores the cropped member-pass photo. At this scale we keep it
-- as a data URL in a TEXT column (no object storage configured); the value
-- is a small downscaled JPEG (~tens of KB). backdrop_anilist_id is the
-- anilist id of the anime whose wide banner themes the profile page. Both
-- nullable — a user who has set neither renders the default pass.
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS backdrop_anilist_id INTEGER;
