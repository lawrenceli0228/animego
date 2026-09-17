-- Synonyms in scripts the site's readers do not read a title in.
--
-- AniList's synonyms are mostly other markets' translated titles, and the
-- table held 2,858 of them in Cyrillic, Thai, Hebrew, Arabic, Greek,
-- Hangul and Vietnamese out of 27,319 rows.  The writer (anilist.KeepSynonym,
-- applied in Media.SynonymSet) now refuses them; this removes the ones
-- already stored.
--
-- Allowlist, not blocklist: a synonym stays only if every code point is in
-- one of these ranges -- Latin through Extended-A (ASCII, accented Western
-- European letters, romaji macrons), general punctuation and symbols, the
-- CJK blocks (skipping Hangul Compatibility Jamo), fullwidth forms, emoji
-- and the CJK supplementary plane.  The ranges are the same table as
-- anilist.synonymRanges; synonym_scripts_pg_test.go drives both from one
-- list of cases so they cannot drift.  Change one, change both.
--
-- The escapes are PostgreSQL ARE \u / \U code points, kept as escapes on
-- purpose: a literal U+0000 cannot travel in a query string.
DELETE FROM anime_synonyms
WHERE synonym ~ '[^\u0000-\u017F\u2000-\u2BFF\u2E80-\u312F\u3190-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\U0001F000-\U0001FAFF\U00020000-\U0002FFFF]';
