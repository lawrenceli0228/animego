-- genre_overview.sql — the tile rows of a genre page, behind
-- GET /api/anime/genre-overview: titles by decade, the genres that appear
-- alongside this one, and the main studios that made the most of it.  The
-- page's rails are not here: they are BrowseAnime itself, called with the
-- filters each rail's "see all" link puts on /browse.
--
-- Every query reads the genre's titles by BrowseAnime's rule -- the genre,
-- adult titles out by the column and by the genre -- so a decade or
-- related-genre tile counts exactly the titles of the /browse listing it
-- opens (yearFrom/yearTo, with), and its covers are that listing's first
-- titles with a cover, in that listing's order.
--
-- A tile carries up to per_tile cover candidates rather than the three it
-- shows: the page skips a cover an earlier tile already used, and needs
-- spares to do that.  Candidates rank covered-first and then in browse
-- order, so a tile whose titles have no cover still returns a row -- the
-- count rides on it -- and the handler drops the coverless candidates.

-- name: ListGenreDecadeTiles :many
-- How many of the genre's titles came out in each year range, and each
-- range's cover candidates.  The ranges arrive as three parallel arrays
-- (key, first year, last year, all inclusive) so the decade table is
-- written once, in internal/anime/genre_overview.go, beside the /browse
-- bounds each decade stands for.  A range with no titles returns no rows,
-- and neither does a title with no release year.
WITH ranges AS (
    SELECT unnest(sqlc.arg(range_keys)::text[]) AS range_key,
           unnest(sqlc.arg(range_froms)::int[]) AS year_from,
           unnest(sqlc.arg(range_tos)::int[])   AS year_to
),
titles AS (
    SELECT a.anilist_id, a.cover_image_url, a.poster_accent, a.popularity, a.average_score,
           COALESCE(a.season_year, EXTRACT(YEAR FROM a.start_date)::int) AS release_year
    FROM anime_cache a
    WHERE NOT a.is_adult
      AND NOT EXISTS (
            SELECT 1 FROM anime_genres h
            WHERE h.anime_id = a.anilist_id AND h.genre = 'Hentai')
      AND EXISTS (
            SELECT 1 FROM anime_genres g
            WHERE g.anime_id = a.anilist_id AND g.genre = sqlc.arg(genre)::text)
),
ranked AS (
    SELECT r.range_key, t.anilist_id, t.cover_image_url, t.poster_accent,
           count(*) OVER (PARTITION BY r.range_key) AS n,
           row_number() OVER (
               PARTITION BY r.range_key
               ORDER BY t.cover_image_url IS NULL, t.popularity DESC NULLS LAST,
                        t.average_score DESC NULLS LAST, t.anilist_id
           ) AS rn
    FROM titles t
    JOIN ranges r ON t.release_year >= r.year_from AND t.release_year <= r.year_to
)
SELECT range_key::text AS range_key, n::bigint AS n, anilist_id, cover_image_url, poster_accent
FROM ranked
WHERE rn <= sqlc.arg(per_tile)::int
ORDER BY range_key, rn;

-- name: ListGenreRelatedTiles :many
-- The genres that most often appear alongside this one: how many titles
-- carry both, and their cover candidates.  Only the caller's candidates
-- count -- the browsable genres, so never Hentai -- and never the genre
-- itself.  The max_tiles most frequent, ties by name; dense_rank gives each
-- genre one rank, shared by all of its candidate rows.
WITH titles AS (
    SELECT a.anilist_id, a.cover_image_url, a.poster_accent, a.popularity, a.average_score
    FROM anime_cache a
    WHERE NOT a.is_adult
      AND NOT EXISTS (
            SELECT 1 FROM anime_genres h
            WHERE h.anime_id = a.anilist_id AND h.genre = 'Hentai')
      AND EXISTS (
            SELECT 1 FROM anime_genres g
            WHERE g.anime_id = a.anilist_id AND g.genre = sqlc.arg(genre)::text)
),
pairs AS (
    SELECT o.genre AS related, t.anilist_id, t.cover_image_url, t.poster_accent,
           count(*) OVER (PARTITION BY o.genre) AS n,
           row_number() OVER (
               PARTITION BY o.genre
               ORDER BY t.cover_image_url IS NULL, t.popularity DESC NULLS LAST,
                        t.average_score DESC NULLS LAST, t.anilist_id
           ) AS rn
    FROM titles t
    JOIN anime_genres o ON o.anime_id = t.anilist_id
    WHERE o.genre <> sqlc.arg(genre)::text
      AND o.genre = ANY(sqlc.arg(candidates)::text[])
),
tiles AS (
    SELECT p.related, p.n, p.rn, p.anilist_id, p.cover_image_url, p.poster_accent,
           dense_rank() OVER (ORDER BY p.n DESC, p.related) AS tile_rank
    FROM pairs p
    WHERE p.rn <= sqlc.arg(per_tile)::int
)
SELECT related::text AS related, n::bigint AS n, anilist_id, cover_image_url, poster_accent
FROM tiles
WHERE tile_rank <= sqlc.arg(max_tiles)::int
ORDER BY tile_rank, rn;

-- name: ListGenreStudioTiles :many
-- The main studios that made the most of the genre's titles, with their
-- cover candidates among them.  Main studios only, as on the studio hub
-- the tile links to: the tile is about who animated the titles, not who
-- sat on their committees.  A title with two main studios counts for both.
-- The max_tiles largest, ties by name.
WITH titles AS (
    SELECT a.anilist_id, a.cover_image_url, a.poster_accent, a.popularity, a.average_score
    FROM anime_cache a
    WHERE NOT a.is_adult
      AND NOT EXISTS (
            SELECT 1 FROM anime_genres h
            WHERE h.anime_id = a.anilist_id AND h.genre = 'Hentai')
      AND EXISTS (
            SELECT 1 FROM anime_genres g
            WHERE g.anime_id = a.anilist_id AND g.genre = sqlc.arg(genre)::text)
),
made AS (
    SELECT st.studio, t.anilist_id, t.cover_image_url, t.poster_accent,
           count(*) OVER (PARTITION BY st.studio) AS n,
           row_number() OVER (
               PARTITION BY st.studio
               ORDER BY t.cover_image_url IS NULL, t.popularity DESC NULLS LAST,
                        t.average_score DESC NULLS LAST, t.anilist_id
           ) AS rn
    FROM titles t
    JOIN anime_studios st ON st.anime_id = t.anilist_id AND st.is_main
),
tiles AS (
    SELECT m.studio, m.n, m.rn, m.anilist_id, m.cover_image_url, m.poster_accent,
           dense_rank() OVER (ORDER BY m.n DESC, m.studio) AS tile_rank
    FROM made m
    WHERE m.rn <= sqlc.arg(per_tile)::int
)
SELECT studio::text AS studio, n::bigint AS n, anilist_id, cover_image_url, poster_accent
FROM tiles
WHERE tile_rank <= sqlc.arg(max_tiles)::int
ORDER BY tile_rank, rn;
