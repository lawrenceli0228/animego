const ANIME_DETAIL_QUERY = `
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
`;

module.exports = { ANIME_DETAIL_QUERY };
