const SEASONAL_ANIME_QUERY = `
  query SeasonalAnime($page: Int, $perPage: Int, $season: MediaSeason, $seasonYear: Int) {
    Page(page: $page, perPage: $perPage) {
      pageInfo {
        total
        currentPage
        lastPage
        hasNextPage
        perPage
      }
      media(season: $season, seasonYear: $seasonYear, type: ANIME, sort: POPULARITY_DESC) {
        id
        title { romaji english native }
        coverImage { extraLarge large }
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

module.exports = { SEASONAL_ANIME_QUERY };
