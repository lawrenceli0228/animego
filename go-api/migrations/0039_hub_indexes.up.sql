-- Reverse lookups for the hub pages: "every title in this genre", "every
-- title this studio made", "every title from this year".
--
-- anime_genres and anime_studios are keyed (anime_id, x), which answers
-- "what are this title's genres" and nothing else; asking the other way
-- round has been a sequential scan since 0001.  The two indexes below
-- are what a genre or studio page paginates on.  The studio index is
-- partial on is_main because the studio page is about who animated the
-- title, not who sat on its committee.
CREATE INDEX anime_genres_genre_idx ON anime_genres (genre, anime_id);
CREATE INDEX anime_studios_studio_main_idx ON anime_studios (studio, anime_id) WHERE is_main;

-- A title's year is season_year when AniList assigned a season, and the
-- year of its start date otherwise -- a quarter of the catalogue (films,
-- OVAs, specials) has no season and would fall off a year page keyed on
-- season_year alone.  The expression is what BrowseAnime filters on, so
-- it is indexed as written there; EXTRACT on a date is immutable.
CREATE INDEX anime_cache_release_year_idx
    ON anime_cache ((COALESCE(season_year, EXTRACT(YEAR FROM start_date)::int)))
    WHERE NOT is_adult;

-- The default ordering of every hub page.
CREATE INDEX anime_cache_popularity_idx ON anime_cache (popularity DESC NULLS LAST) WHERE NOT is_adult;
