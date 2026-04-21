const SEARCH_ANIME_QUERY = `
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
`;

module.exports = { SEARCH_ANIME_QUERY };
