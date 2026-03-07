const ANIME_DETAIL_QUERY = `
  query AnimeDetail($id: Int) {
    Media(id: $id, type: ANIME) {
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
      startDate { year month day }
      endDate   { year month day }
      studios(isMain: true) { nodes { name } }
      trailer { id site }
    }
  }
`;

module.exports = { ANIME_DETAIL_QUERY };
