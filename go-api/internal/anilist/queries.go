// Package anilist — GraphQL query string constants.
//
// These four queries are copied VERBATIM from the Express
// server/queries/*.graphql.js files so the AniList wire format stays
// byte-identical with the legacy backend.  Do not optimise the GraphQL
// shape locally; the legacy traffic is what production observability and
// rate-limit budgets are tuned against.
//
// Source files (Express):
//   - server/queries/searchAnime.graphql.js
//   - server/queries/seasonalAnime.graphql.js
//   - server/queries/animeDetail.graphql.js
//   - server/queries/weeklySchedule.graphql.js
package anilist

// SearchAnimeQuery — full-text + genre search across all anime.
//
// Variables:
//
//	$page    Int     1-based page index
//	$perPage Int     page size (AniList caps at 50)
//	$search  String  optional substring search (passed as undefined when empty)
//	$genre   String  optional genre filter (one of AniList's enumerated genres)
//
// Server-side filters: type=ANIME, isAdult=false, sort=SEARCH_MATCH.
const SearchAnimeQuery = `
  query SearchAnime($page: Int, $perPage: Int, $search: String, $genre: String) {
    Page(page: $page, perPage: $perPage) {
      pageInfo {
        total
        currentPage
        lastPage
        hasNextPage
        perPage
      }
      media(search: $search, genre: $genre, type: ANIME, isAdult: false, sort: SEARCH_MATCH) {
        id
        title { romaji english native }
        coverImage { extraLarge large color }
        bannerImage
        description(asHtml: false)
        episodes
        status
        season
        seasonYear
        averageScore
        genres
        format
      }
    }
  }
`

// SeasonalAnimeQuery — popularity-sorted listing for one season/year.
//
// Variables:
//
//	$page       Int          1-based page index
//	$perPage    Int          page size (AniList caps at 50)
//	$season     MediaSeason  WINTER | SPRING | SUMMER | FALL
//	$seasonYear Int          four-digit year (e.g. 2025)
//
// Server-side filters: type=ANIME, isAdult=false, sort=POPULARITY_DESC.
const SeasonalAnimeQuery = `
  query SeasonalAnime($page: Int, $perPage: Int, $season: MediaSeason, $seasonYear: Int) {
    Page(page: $page, perPage: $perPage) {
      pageInfo {
        total
        currentPage
        lastPage
        hasNextPage
        perPage
      }
      media(season: $season, seasonYear: $seasonYear, type: ANIME, isAdult: false, sort: POPULARITY_DESC) {
        id
        title { romaji english native }
        coverImage { extraLarge large color }
        trailer { id site }
        bannerImage
        description(asHtml: false)
        episodes
        status
        season
        seasonYear
        averageScore
        genres
        format
      }
    }
  }
`

// AnimeDetailQuery — detail view for a single anime by AniList id.
//
// Variables:
//
//	$id Int  AniList media id (the integer the rest of the system keys off)
//
// Includes relations, characters (8 max), staff (10 max), and 6 top
// recommendations.  No filters applied (AniList returns whatever exists
// for that id).
const AnimeDetailQuery = `
  query AnimeDetail($id: Int) {
    Media(id: $id, type: ANIME) {
      id
      title { romaji english native }
      coverImage { extraLarge large color }
      bannerImage
      description(asHtml: false)
      episodes
      status
      season
      seasonYear
      averageScore
      genres
      format
      startDate { year month day }
      endDate   { year month day }
      duration
      source
      studios(isMain: true) { nodes { name } }
      relations { edges { relationType node { id title { romaji native } coverImage { large color } format } } }
      characters(sort: ROLE, page: 1, perPage: 8) {
        edges { role node { id name { full native } image { medium } }
          voiceActors(language: JAPANESE) { id name { full native } image { medium } } }
      }
      staff(sort: RELEVANCE, page: 1, perPage: 10) {
        edges { role node { id name { full native } image { medium } } }
      }
      recommendations(sort: RATING_DESC, page: 1, perPage: 6) {
        nodes { mediaRecommendation { id title { romaji native } coverImage { large color } averageScore } }
      }
      trailer { id site }
    }
  }
`

// WeeklyScheduleQuery — airing schedules within a [weekStart, weekEnd]
// Unix-second window.  All page sizes hard-coded to 50 server-side.
//
// Variables:
//
//	$weekStart Int!  Unix seconds, lower bound (exclusive in AniList semantics)
//	$weekEnd   Int!  Unix seconds, upper bound (exclusive in AniList semantics)
//	$page      Int!  1-based page index — caller iterates until hasNextPage=false
const WeeklyScheduleQuery = `
  query WeeklySchedule($weekStart: Int!, $weekEnd: Int!, $page: Int!) {
    Page(page: $page, perPage: 50) {
      pageInfo { hasNextPage }
      airingSchedules(
        airingAt_greater: $weekStart
        airingAt_lesser: $weekEnd
        sort: TIME
      ) {
        id
        airingAt
        episode
        media {
          id
          isAdult
          title { romaji english native }
          coverImage { extraLarge large color }
          format
          averageScore
          genres
        }
      }
    }
  }
`

// MediaRatingsQuery — rating figures for an explicit list of media ids.
//
// The first query in this file that is NOT a port of an Express
// document.  The four above are copied verbatim because production
// observability and rate-limit budgets are tuned against them; this one
// has no legacy counterpart to stay byte-identical with, because the
// legacy backend never read a rating count.
//
// Variables:
//
//	$ids     [Int]  AniList media ids, at most 50 (AniList's page cap)
//	$perPage Int    page size — the caller passes len(ids)
//
// `id_in` rather than a page of a season, because the rows that need
// this are not a season: 4,500 of 18,458 catalogue rows have no
// season_year at all (films, OVAs, specials), and a per-season document
// can never reach them.  Batching by id also means one request refreshes
// 50 rows instead of one, which is what makes a whole-catalogue sweep
// cost ~370 requests instead of ~18,000.
//
// The selection is deliberately narrow.  This document is not a cache
// warm and must not be mistaken for one: it selects the two rating
// figures and the id needed to attribute them, and nothing a caller
// could be tempted to write over an existing row with.
//
// stats.scoreDistribution is how AniList exposes a rater count -- there
// is no scalar for it.  The buckets are per-decile and their amounts sum
// to the number of users who scored the work, which is the figure
// Bangumi prints as "N 人评分".  See Media.ScoreVotes.
const MediaRatingsQuery = `
  query MediaRatings($ids: [Int], $perPage: Int) {
    Page(page: 1, perPage: $perPage) {
      media(id_in: $ids, type: ANIME) {
        id
        averageScore
        stats { scoreDistribution { score amount } }
      }
    }
  }
`
