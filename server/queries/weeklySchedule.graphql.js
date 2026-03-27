const WEEKLY_SCHEDULE_QUERY = `
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
          coverImage { extraLarge large }
          format
          averageScore
          genres
        }
      }
    }
  }
`;

module.exports = { WEEKLY_SCHEDULE_QUERY };
