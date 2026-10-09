// Package anilist — GraphQL query string constants.
//
// The four listing/detail queries began as VERBATIM copies of the Express
// server/queries/*.graphql.js documents, and their request COUNT is still
// what production observability and rate-limit budgets are tuned against.
// Their selection sets are no longer byte-identical: trailer (0032) and
// then the scalar block -- popularity, favourites, idMal, isAdult,
// countryOfOrigin, nextAiringEpisode (0036) -- were added to every
// document that upserts anime_cache, so that no upsert path can carry a
// row without them.  Adding a scalar to a document costs nothing in
// requests; it is the request count, not the byte count, that the
// budgets are about.
//
// Source files (Express):
//   - server/queries/searchAnime.graphql.js
//   - server/queries/seasonalAnime.graphql.js
//   - server/queries/animeDetail.graphql.js
//   - server/queries/weeklySchedule.graphql.js
package anilist

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
)

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
        popularity
        favourites
        idMal
        isAdult
        countryOfOrigin
        nextAiringEpisode { airingAt episode }
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
        popularity
        favourites
        idMal
        isAdult
        countryOfOrigin
        nextAiringEpisode { airingAt episode }
      }
    }
  }
`

// CreditsPerPage is how many characters or staff one page of a nested
// connection holds: AniList's ceiling (pageInfo.perPage tops out there
// whatever is asked).  The documents below spell it as the literal 25,
// because a const string cannot be built from an int; the query tests
// hold the two together.
const CreditsPerPage = 25

// MaxCreditPagesPerRequest is how many pages one aliased credit request
// carries (p1 ... p8 on a single Media).  Measured against AniList: eight
// pages of characters with every voice role answer in one request with
// no complexity error.  See CharacterPagesQuery.
const MaxCreditPagesPerRequest = 8

// The two sort orders, and why they end in ID.
//
// [ROLE, RELEVANCE, ID] is the order AniList's own site lists characters
// in; the port asked for ROLE alone, so the first page was a different
// 25 from the one AniList shows and the eight the detail page draws were
// not AniList's eight.  Staff were RELEVANCE alone.  The trailing ID is
// what makes either order total: page 9 of an order with ties is not
// guaranteed to continue page 8, and the credits sweep stitches up to
// sixteen pages from two requests.
const (
	characterCreditsSort = `[ROLE, RELEVANCE, ID]`
	staffCreditsSort     = `[RELEVANCE, ID]`
)

// characterCreditsSelection is everything inside one characters(...)
// page, shared by AnimeDetailQuery and CharacterPagesQuery so the detail
// path and the sweep cannot drift apart on what a row is made of.
//
// `node { id ... }` is load-bearing beyond the id it stores: AniList
// answers voiceActorRoles with an empty list, and no error, on an edge
// whose node id was not selected.  voiceActorRoles takes no language
// argument, so every language comes back with its languageV2 label --
// the StaffLanguage enum the old `voiceActors(language:)` filter took has
// no Chinese value at all.
const characterCreditsSelection = `pageInfo { hasNextPage }
        edges { role node { id name { full native } image { large medium } }
          voiceActorRoles(sort: [RELEVANCE, ID]) { roleNotes dubGroup voiceActor { id name { full native } image { large medium } languageV2 } } }`

// staffCreditsSelection is characterCreditsSelection for staff.
const staffCreditsSelection = `pageInfo { hasNextPage }
        edges { role node { id name { full native } image { medium } } }`

// AnimeDetailQuery — detail view for a single anime by AniList id.
//
// Variables:
//
//	$id Int  AniList media id (the integer the rest of the system keys off)
//
// Includes relations, the first page of characters and of staff (25
// each -- AniList's cap on a nested connection page), and 6 top
// recommendations.  No filters applied (AniList returns whatever exists
// for that id).
//
// The first page is all the detail path ever writes.  Whether there is a
// second is what pageInfo { hasNextPage } is selected for: it is stored
// (cast_has_more / staff_has_more) and is how the credits sweep finds the
// titles it has to complete -- see credits.WriteCast for why the detail
// path keeps the sweep's rows instead of replacing them.
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
      studios { edges { isMain node { id name } } }
      relations { edges { relationType node { id title { romaji native } coverImage { large color } format } } }
      characters(sort: ` + characterCreditsSort + `, page: 1, perPage: 25) {
        ` + characterCreditsSelection + `
      }
      staff(sort: ` + staffCreditsSort + `, page: 1, perPage: 25) {
        ` + staffCreditsSelection + `
      }
      recommendations(sort: RATING_DESC, page: 1, perPage: 6) {
        nodes { mediaRecommendation { id title { romaji native } coverImage { large color } averageScore } }
      }
      trailer { id site }
      synonyms
      popularity
      favourites
      idMal
      isAdult
      countryOfOrigin
      nextAiringEpisode { airingAt episode }
      tags { name rank isMediaSpoiler }
      externalLinks { site url type }
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

// MediaFactsQuery — the four scalar facts for an explicit list of media
// ids, for the sweep that fills them in across the back catalogue.
//
// Same shape and same reasoning as MediaRatingsQuery above: id_in rather
// than a season page because a quarter of the catalogue has no season to
// page by, and a batch of 50 per request because that is what turns a
// whole-catalogue pass into hundreds of requests rather than thousands.
//
// The selection is the four columns 0034 taught the upsert to write, the
// scalar block 0036 added (synonyms, popularity, favourites, idMal,
// isAdult, countryOfOrigin, nextAiringEpisode), the two lists 0038 added
// (tags, externalLinks), and the id to attribute them.  Nothing else: this document is not a cache warm, and a sweep
// that overwrote titles or scores across every row at once would have no
// second source to restore them from if it was wrong.  Everything it
// does select is a fact AniList alone is the source of.  See
// queue/anime_facts.go.
//
// Variables:
//
//	$ids     [Int]  AniList media ids, at most 50 (AniList's page cap)
//	$perPage Int    page size — the caller passes len(ids)
const MediaFactsQuery = `
  query MediaFacts($ids: [Int], $perPage: Int) {
    Page(page: 1, perPage: $perPage) {
      media(id_in: $ids, type: ANIME) {
        id
        startDate { year month day }
        endDate   { year month day }
        duration
        source
        synonyms
        popularity
        favourites
        idMal
        isAdult
        countryOfOrigin
        nextAiringEpisode { airingAt episode }
        tags { name rank isMediaSpoiler }
        externalLinks { site url type }
      }
    }
  }
`

// ErrCreditPageRange is returned for a page range no credit document can
// carry: pages are 1-based, the range must not be empty, and one request
// holds at most MaxCreditPagesPerRequest of them.
var ErrCreditPageRange = errors.New("anilist: credit page range invalid")

// CreditPageAlias is the GraphQL alias page n is requested under: "p1"
// for page 1, "p9" for page 9.  Aliases are numbered by page rather than
// by position in the request so the sweep's second request (pages 9-16)
// reads p9 ... p16, and a decoder counting from 1 cannot attribute a
// page to the wrong offset.
func CreditPageAlias(page int) string { return "p" + strconv.Itoa(page) }

// CharacterPagesQuery returns the document that fetches pages
// first..last of one title's characters in a single request: each page
// is the same characters(...) connection under its own alias on one
// Media.  It also selects countryOfOrigin, which decides whose voice is
// the primary one (see credits.PrimaryLanguage).
//
// A document per range rather than one with page variables, because
// GraphQL has no way to repeat a field a variable number of times; the
// variables carry only $id.
//
// The selection inside each page is the constant AnimeDetailQuery uses,
// so a row the sweep writes and a row the detail path writes are made of
// the same fields.
func CharacterPagesQuery(first, last int) (string, error) {
	return creditPagesQuery("MediaCharacterPages", "characters", characterCreditsSort,
		characterCreditsSelection, "countryOfOrigin", first, last)
}

// StaffPagesQuery is CharacterPagesQuery for the staff connection.
func StaffPagesQuery(first, last int) (string, error) {
	return creditPagesQuery("MediaStaffPages", "staff", staffCreditsSort,
		staffCreditsSelection, "", first, last)
}

// creditPagesQuery assembles one aliased credit document.  extra is an
// optional Media scalar selected beside the pages.
func creditPagesQuery(name, connection, sort, selection, extra string, first, last int) (string, error) {
	if first < 1 || last < first || last-first+1 > MaxCreditPagesPerRequest {
		return "", fmt.Errorf("%w: pages %d..%d", ErrCreditPageRange, first, last)
	}
	var b strings.Builder
	fmt.Fprintf(&b, "\n  query %s($id: Int) {\n    Media(id: $id, type: ANIME) {\n      id\n", name)
	if extra != "" {
		fmt.Fprintf(&b, "      %s\n", extra)
	}
	for page := first; page <= last; page++ {
		fmt.Fprintf(&b, "      %s: %s(sort: %s, page: %d, perPage: %d) {\n        %s\n      }\n",
			CreditPageAlias(page), connection, sort, page, CreditsPerPage, selection)
	}
	b.WriteString("    }\n  }\n")
	return b.String(), nil
}
