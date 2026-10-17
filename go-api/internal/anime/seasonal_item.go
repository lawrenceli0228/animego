package anime

import (
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// seasonalItem is one entry of /api/anime/seasonal's data array.
//
// Hand-declared rather than passing dbgen.GetSeasonalAnimeRow straight out,
// for the reason trendingItem and episodeCountItem are: the wire contract is
// pinned here instead of tracking whatever the SELECT list happens to
// contain.  The row was the response until the columns after trailer_site
// arrived, and one of those would not encode as the contract says if passed
// through: pgtype.Timestamptz prints the instant in whatever location pgx
// scanned it into, which is the process's local zone, not UTC.
//
// The fields down to TrailerSite are the row's, in the row's order, with
// the row's JSON names and Go types, so they encode byte for byte as they
// did when the row was the response.  A downstream Go client decodes this
// endpoint; TestSeasonalItem_LegacyFieldsEncodeAsBefore holds those bytes.
// Everything after TrailerSite is additive.
type seasonalItem struct {
	AnilistID             int32    `json:"anilistId"`
	TitleRomaji           *string  `json:"titleRomaji"`
	TitleEnglish          *string  `json:"titleEnglish"`
	TitleNative           *string  `json:"titleNative"`
	TitleChinese          *string  `json:"titleChinese"`
	TitleHant             *string  `json:"titleHant"`
	TitleHantSource       *string  `json:"titleHantSource"`
	TitleHantSeo          *string  `json:"titleHantSeo"`
	CoverImageUrl         *string  `json:"coverImageUrl"`
	BannerImageUrl        *string  `json:"bannerImageUrl"`
	CoverImageColor       *string  `json:"coverImageColor"`
	PosterAccent          *string  `json:"posterAccent"`
	AverageScore          *float64 `json:"averageScore"`
	BangumiScore          *float64 `json:"bangumiScore"`
	Episodes              *int32   `json:"episodes"`
	Season                *string  `json:"season"`
	SeasonYear            *int32   `json:"seasonYear"`
	Status                *string  `json:"status"`
	Format                *string  `json:"format"`
	Description           *string  `json:"description"`
	DescriptionCn         *string  `json:"descriptionCn"`
	DescriptionCnSource   *string  `json:"descriptionCnSource"`
	DescriptionHant       *string  `json:"descriptionHant"`
	DescriptionHantSource *string  `json:"descriptionHantSource"`
	Genres                []string `json:"genres"`
	DiscussionCount       int64    `json:"discussionCount"`
	TrailerID             *string  `json:"trailerId"`
	TrailerSite           *string  `json:"trailerSite"`

	// Studio is the alphabetically first main studio.  Null when AniList
	// lists none, and also for a row the detail fetch has not reached yet:
	// anime_studios is written only there (see GetSeasonalAnime).
	Studio *string `json:"studio"`
	// NextAiringAt and NextAiringEpisode are the next episode as AniList
	// last stated it, both or neither (a CHECK on the column pair).  The
	// time is RFC 3339 in UTC, like every other timestamp the API emits.
	// It is as fresh as the row, so it can lie in the past: a reader
	// compares it with its own clock.
	NextAiringAt      *time.Time `json:"nextAiringAt"`
	NextAiringEpisode *int32     `json:"nextAiringEpisode"`
	Popularity        *int32     `json:"popularity"`
	Favourites        *int32     `json:"favourites"`
	// Source is AniList's MediaSource value: ORIGINAL, MANGA, LIGHT_NOVEL ...
	Source *string `json:"source"`
	// StartDate is YYYY-MM-DD, or null.  The column holds whole dates only:
	// a date AniList states as a year or a month is stored as unknown (see
	// anilist.FuzzyDate.Whole).
	StartDate *string `json:"startDate"`
	// Duration is minutes per episode.
	Duration *int32 `json:"duration"`
	// IsSequel says AniList lists a PREQUEL that is itself an anime.  False
	// also for a row the detail fetch has not reached yet, for the reason
	// Studio is null there: anime_relations is written only by that fetch.
	IsSequel bool `json:"isSequel"`
}

// seasonalItemFromRow projects one GetSeasonalAnime row onto the wire
// shape.  The legacy fields are copied as they are -- Genres included, so
// a nil slice still encodes as null, exactly as the row did.
func seasonalItemFromRow(r dbgen.GetSeasonalAnimeRow) seasonalItem {
	return seasonalItem{
		AnilistID:             r.AnilistID,
		TitleRomaji:           r.TitleRomaji,
		TitleEnglish:          r.TitleEnglish,
		TitleNative:           r.TitleNative,
		TitleChinese:          r.TitleChinese,
		TitleHant:             r.TitleHant,
		TitleHantSource:       r.TitleHantSource,
		TitleHantSeo:          r.TitleHantSeo,
		CoverImageUrl:         r.CoverImageUrl,
		BannerImageUrl:        r.BannerImageUrl,
		CoverImageColor:       r.CoverImageColor,
		PosterAccent:          r.PosterAccent,
		AverageScore:          r.AverageScore,
		BangumiScore:          r.BangumiScore,
		Episodes:              r.Episodes,
		Season:                r.Season,
		SeasonYear:            r.SeasonYear,
		Status:                r.Status,
		Format:                r.Format,
		Description:           r.Description,
		DescriptionCn:         r.DescriptionCn,
		DescriptionCnSource:   r.DescriptionCnSource,
		DescriptionHant:       r.DescriptionHant,
		DescriptionHantSource: r.DescriptionHantSource,
		Genres:                r.Genres,
		DiscussionCount:       r.DiscussionCount,
		TrailerID:             r.TrailerID,
		TrailerSite:           r.TrailerSite,

		Studio:            firstOrNil(r.MainStudio),
		NextAiringAt:      utcInstant(r.NextAiringAt),
		NextAiringEpisode: r.NextAiringEpisode,
		Popularity:        r.Popularity,
		Favourites:        r.Favourites,
		Source:            r.Source,
		StartDate:         calendarDate(r.StartDate),
		Duration:          r.Duration,
		IsSequel:          r.IsSequel,
	}
}

// seasonalItemsFromRows maps a page of rows.  Never nil, so an empty page
// encodes as [] rather than null.
func seasonalItemsFromRows(rows []dbgen.GetSeasonalAnimeRow) []seasonalItem {
	out := make([]seasonalItem, 0, len(rows))
	for _, r := range rows {
		out = append(out, seasonalItemFromRow(r))
	}
	return out
}

// firstOrNil is the first element, or nil for an empty slice.  The query
// returns the main studio as an array of at most one; see GetSeasonalAnime
// for why.
func firstOrNil(ss []string) *string {
	if len(ss) == 0 {
		return nil
	}
	s := ss[0]
	return &s
}

// utcInstant is the column's instant in UTC, or nil when the column is
// NULL or not a finite time (Postgres's ±infinity has no RFC 3339 form).
func utcInstant(ts pgtype.Timestamptz) *time.Time {
	if !ts.Valid || ts.InfinityModifier != pgtype.Finite {
		return nil
	}
	t := ts.Time.UTC()
	return &t
}

// calendarDate is the column's date as YYYY-MM-DD, or nil when the column
// is NULL or not a finite date.  pgx scans a date as midnight UTC, so the
// calendar fields are the stored ones.
func calendarDate(d pgtype.Date) *string {
	if !d.Valid || d.InfinityModifier != pgtype.Finite {
		return nil
	}
	s := d.Time.Format(time.DateOnly)
	return &s
}
