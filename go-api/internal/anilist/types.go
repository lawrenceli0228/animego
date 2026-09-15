// Package anilist — typed Go structs for AniList GraphQL responses.
//
// These types mirror the GraphQL response shape (NOT the normalised
// internal AnimeCache shape that the Express service emits).  Pointer
// types are used for any field that can come back null from AniList —
// strings, numbers, nested objects — so handlers can distinguish
// "absent" from "zero".  Slices are zero-value friendly (nil treated as
// empty by downstream callers).
//
// Field tags follow the AniList GraphQL field names exactly.  Do not
// rename — encoding/json's struct-tag lookup is the contract.
package anilist

import "time"

// ---------------------------------------------------------------------------
// Shared scalars (used by multiple queries)
// ---------------------------------------------------------------------------

// Title is the localised title triplet AniList returns on every Media.
// All three fields are nullable in the schema.
type Title struct {
	Romaji  *string `json:"romaji"`
	English *string `json:"english"`
	Native  *string `json:"native"`
}

// CoverImage carries the three sizes plus the dominant accent colour.
// extraLarge is preferred by the Express normaliser, falling back to
// large when extraLarge is unset.
type CoverImage struct {
	ExtraLarge *string `json:"extraLarge"`
	Large      *string `json:"large"`
	Color      *string `json:"color"`
}

// FuzzyDate is the {year, month, day} triple AniList uses for any date
// field (startDate, endDate).  Any component may be null when AniList
// only knows the year-month or year alone.
type FuzzyDate struct {
	Year  *int `json:"year"`
	Month *int `json:"month"`
	Day   *int `json:"day"`
}

// Whole returns the date as a calendar day, and false when AniList did
// not state one in full.
//
// A FuzzyDate can be "sometime in 2011"; a date column, a page, and a
// schema.org startDate cannot.  Padding a missing month or day with 1
// would print a day nobody stated, so the rule every writer follows is
// the one the Express migration already applied to the rows it carried
// over (transforms.MakeDate): all three parts or nothing.  An impossible
// day (Feb 30) is refused rather than normalised forward, for the same
// reason -- time.Date would happily return March 2, and that is not the
// date AniList gave.
func (f *FuzzyDate) Whole() (time.Time, bool) {
	if f == nil || f.Year == nil || f.Month == nil || f.Day == nil {
		return time.Time{}, false
	}
	y, mo, d := *f.Year, *f.Month, *f.Day
	if y <= 0 || mo < 1 || mo > 12 || d < 1 || d > 31 {
		return time.Time{}, false
	}
	t := time.Date(y, time.Month(mo), d, 0, 0, 0, 0, time.UTC)
	if t.Day() != d || t.Month() != time.Month(mo) {
		return time.Time{}, false
	}
	return t, true
}

// Image is the thumbnail object on characters/staff/voice-actors.
// AniList exposes large/medium variants; only medium is requested by
// the detail query.
type Image struct {
	Medium *string `json:"medium"`
}

// PersonName is the {full, native} pair used by character, staff, and
// voice-actor names.
type PersonName struct {
	Full   *string `json:"full"`
	Native *string `json:"native"`
}

// Trailer is the {id, site} pair AniList returns when a media has a
// trailer.  Site is typically "youtube" or "dailymotion".
type Trailer struct {
	ID   *string `json:"id"`
	Site *string `json:"site"`
}

// Document names which GraphQL document produced a Media.  It exists
// because a Media on its own cannot say what was asked of AniList, and
// two of the things the cache layer persists are answers whose absence
// only means something if the question was posed:
//
//   - a nil Media.Trailer is "AniList says none" when the document
//     selected `trailer`, and "we never asked" when it did not;
//   - an empty studios / characters / staff / relations set is "AniList
//     has none" when the document was AnimeDetailQuery, and "the listing
//     query does not select children" for every other document.
//
// Only the first reading of each is worth writing down, and writing the
// second one down is how a catalogue row ends up either overwritten with
// nothing (trailer) or re-fetched on every cache miss forever (children;
// see anime.isStale).
//
// The distinction is carried as a parameter rather than a convention at
// each call site because five paths upsert anime_cache from AniList and
// they do not share a query:
//
//	SeasonalAnimeQuery  → anime/seasonal, queue/warm_season   (SeasonalDocument)
//	AnimeDetailQuery    → anime/detail, anime/ensure_cached   (DetailDocument)
//	SearchAnimeQuery    → anime/search                        (SearchDocument)
//
// Making it an argument means a sixth call site cannot compile without
// answering the question.  The type lives here, next to the queries that
// decide the answer, so both internal/anime and internal/queue can name
// it without importing each other.  TestDocumentSelectionsMatchTheQueries
// is what ties each constant to the document text it makes claims about.
type Document uint8

const (
	// SearchDocument marks a Media from SearchAnimeQuery: no `trailer`,
	// no child connections.  Nothing absent on it is an answer.
	SearchDocument Document = iota

	// SeasonalDocument marks a Media from SeasonalAnimeQuery: selects
	// `trailer` (a nil Trailer is authoritative) but no child
	// connections.
	SeasonalDocument

	// DetailDocument marks a Media from AnimeDetailQuery: selects
	// `trailer` and every child connection, so an empty child set is
	// AniList's answer rather than a gap.
	DetailDocument
)

// SelectsTrailer reports whether the document asked for `trailer`, i.e.
// whether a nil Media.Trailer may be stored as a confirmed absence.
func (d Document) SelectsTrailer() bool { return d != SearchDocument }

// SelectsChildren reports whether the document asked for the child
// connections (studios, relations, characters, staff, recommendations),
// i.e. whether the row may be stamped as having been through the detail
// fetch.
func (d Document) SelectsChildren() bool { return d == DetailDocument }

// ---------------------------------------------------------------------------
// Page wrapper + PageInfo (search / seasonal / weekly all return Page{...})
// ---------------------------------------------------------------------------

// PageInfo is the pagination metadata block.  hasNextPage is the only
// field the weekly-schedule query asks for; the rest are populated by
// search / seasonal.
type PageInfo struct {
	Total       int  `json:"total"`
	CurrentPage int  `json:"currentPage"`
	LastPage    int  `json:"lastPage"`
	HasNextPage bool `json:"hasNextPage"`
	PerPage     int  `json:"perPage"`
}

// MediaPage is the Page envelope used by SearchAnime and SeasonalAnime.
type MediaPage struct {
	PageInfo PageInfo `json:"pageInfo"`
	Media    []Media  `json:"media"`
}

// SchedulePage is the Page envelope used by WeeklySchedule.  Only
// hasNextPage is meaningful in the PageInfo block.
type SchedulePage struct {
	PageInfo         PageInfo          `json:"pageInfo"`
	AiringSchedules  []AiringSchedule  `json:"airingSchedules"`
}

// ---------------------------------------------------------------------------
// Media (anime) — the primary payload for all four queries
// ---------------------------------------------------------------------------

// Media is one anime entry as returned by AniList.  All optional fields
// are pointer types so encoding/json preserves the absent/null
// distinction the downstream cache layer relies on.
//
// The detail-only fields (StartDate, EndDate, Duration, Source,
// BannerImage with full payload, Studios, Relations, Characters, Staff,
// Recommendations, Trailer) are populated only by AnimeDetailQuery and
// will marshal as `null` / empty slices for search & seasonal hits.
type Media struct {
	// Always populated (search, seasonal, detail)
	ID            int        `json:"id"`
	Title         *Title     `json:"title"`
	CoverImage    *CoverImage `json:"coverImage"`
	BannerImage   *string    `json:"bannerImage"`
	Description   *string    `json:"description"`
	Episodes      *int       `json:"episodes"`
	Status        *string    `json:"status"`
	Season        *string    `json:"season"`
	SeasonYear    *int       `json:"seasonYear"`
	AverageScore  *int       `json:"averageScore"`
	Genres        []string   `json:"genres"`
	Format        *string    `json:"format"`

	// Weekly-schedule only — see Media{IsAdult} usage in
	// anilist.service.js getWeeklySchedule for the adult-content skip.
	IsAdult *bool `json:"isAdult,omitempty"`

	// Detail-only fields (AnimeDetailQuery)
	StartDate       *FuzzyDate       `json:"startDate,omitempty"`
	EndDate         *FuzzyDate       `json:"endDate,omitempty"`
	Duration        *int             `json:"duration,omitempty"`
	Source          *string          `json:"source,omitempty"`
	Studios         *StudioConnection `json:"studios,omitempty"`
	Relations       *RelationConnection `json:"relations,omitempty"`
	Characters      *CharacterConnection `json:"characters,omitempty"`
	Staff           *StaffConnection  `json:"staff,omitempty"`
	Recommendations *RecommendationConnection `json:"recommendations,omitempty"`
	Trailer         *Trailer         `json:"trailer,omitempty"`

	// Ratings-only field (MediaRatingsQuery).  Nil for every other
	// query, which is why nothing reads it directly — see ScoreVotes.
	Stats *MediaStats `json:"stats,omitempty"`
}

// MediaStats is the stats{...} block.  Only scoreDistribution is
// requested; AniList also exposes statusDistribution there, which
// answers a different question (how many people are watching) and is
// not selected.
type MediaStats struct {
	ScoreDistribution []ScoreDistributionBucket `json:"scoreDistribution"`
}

// ScoreDistributionBucket is one decile of the rating histogram: Score
// is the bucket label on AniList's 0-100 scale (10, 20, ... 100) and
// Amount is how many users gave a score in it.
//
// The bucket labels are not used.  This type exists so the amounts can
// be summed; keeping Score means a future caller that wants the shape of
// the distribution (a "mostly 10s vs evenly spread" signal) does not
// have to change the query to get it.
type ScoreDistributionBucket struct {
	Score  int `json:"score"`
	Amount int `json:"amount"`
}

// ScoreVotes is the number of users who scored this media -- the figure
// Bangumi prints as "N 人评分" -- or nil when the query behind this
// Media did not ask for it.
//
// AniList has no scalar for this.  It is the sum of the
// scoreDistribution amounts, and the sum is the whole reason the
// histogram is selected.
//
// The nil / zero distinction is the same one Document exists
// for, except here the response carries it: a Media from a document that
// did not select `stats` has a nil Stats and no opinion, while a Media
// from one that did has a non-nil Stats even when the distribution is
// empty -- and an empty distribution means nobody has scored it, which
// is an answer worth storing.  Callers therefore do not need to pass a
// selection flag alongside the Media; a nil return says "did not ask"
// and a *0 says "asked, nobody has".
func (m Media) ScoreVotes() *int {
	if m.Stats == nil {
		return nil
	}
	total := 0
	for _, b := range m.Stats.ScoreDistribution {
		// Negative amounts are not a shape AniList produces; guarding
		// is cheaper than explaining a negative count in the column
		// later, and the CHECK on anilist_score_votes would refuse it
		// anyway -- silently, from inside a swallowed per-row update.
		if b.Amount > 0 {
			total += b.Amount
		}
	}
	return &total
}

// ---------------------------------------------------------------------------
// Studio / Relation / Character / Staff / Recommendation connections
// ---------------------------------------------------------------------------

// Studio is one studio node.  Only the name is requested.
type Studio struct {
	Name string `json:"name"`
}

// StudioConnection is the studios{nodes{...}} wrapper.  Express picks
// `isMain: true` server-side, so this connection only carries primary
// production studios.
type StudioConnection struct {
	Nodes []Studio `json:"nodes"`
}

// RelationNode is the embedded Media reference on a RelationEdge.
// AniList does not include genres / averageScore on relation nodes —
// only the minimal title + cover + format trio the UI needs.
type RelationNode struct {
	ID         int         `json:"id"`
	Title      *Title      `json:"title"`
	CoverImage *CoverImage `json:"coverImage"`
	Format     *string     `json:"format"`
}

// RelationEdge ties a RelationNode to its relationship type
// (SEQUEL, PREQUEL, SIDE_STORY, …).  RelationType is an enum string.
type RelationEdge struct {
	RelationType *string      `json:"relationType"`
	Node         RelationNode `json:"node"`
}

// RelationConnection is the relations{edges{...}} wrapper.
type RelationConnection struct {
	Edges []RelationEdge `json:"edges"`
}

// CharacterNode is the character's identity payload — id, name pair,
// image.  Embedded inside a CharacterEdge.
type CharacterNode struct {
	ID    int         `json:"id"`
	Name  *PersonName `json:"name"`
	Image *Image      `json:"image"`
}

// VoiceActor is one voice-actor entry.  AniList returns an array per
// character; Express picks the first JAPANESE entry only, so callers
// should look at edges.voiceActors[0].
type VoiceActor struct {
	ID    int         `json:"id"`
	Name  *PersonName `json:"name"`
	Image *Image      `json:"image"`
}

// CharacterEdge carries the role string (MAIN, SUPPORTING, BACKGROUND)
// plus the embedded character node and its voice-actor list.
type CharacterEdge struct {
	Role        *string       `json:"role"`
	Node        CharacterNode `json:"node"`
	VoiceActors []VoiceActor  `json:"voiceActors"`
}

// CharacterConnection is the characters{edges{...}} wrapper.  Express
// requests page=1 perPage=8 so the slice has at most 8 entries.
type CharacterConnection struct {
	Edges []CharacterEdge `json:"edges"`
}

// StaffNode is one staff person's identity.
type StaffNode struct {
	ID    int         `json:"id"`
	Name  *PersonName `json:"name"`
	Image *Image      `json:"image"`
}

// StaffEdge ties a StaffNode to their role string (Director, Writer,
// Music, …).
type StaffEdge struct {
	Role *string   `json:"role"`
	Node StaffNode `json:"node"`
}

// StaffConnection is the staff{edges{...}} wrapper.  Express requests
// page=1 perPage=10.
type StaffConnection struct {
	Edges []StaffEdge `json:"edges"`
}

// MediaRecommendation is the embedded Media reference on a
// RecommendationNode.  Like RelationNode, AniList limits the field set.
type MediaRecommendation struct {
	ID           int         `json:"id"`
	Title        *Title      `json:"title"`
	CoverImage   *CoverImage `json:"coverImage"`
	AverageScore *int        `json:"averageScore"`
}

// RecommendationNode wraps an optional MediaRecommendation pointer.
// When AniList has no recommendation row the pointer is nil — Express
// filters these out before normalising.
type RecommendationNode struct {
	MediaRecommendation *MediaRecommendation `json:"mediaRecommendation"`
}

// RecommendationConnection is the recommendations{nodes{...}} wrapper.
// Express requests page=1 perPage=6 sort=RATING_DESC.
type RecommendationConnection struct {
	Nodes []RecommendationNode `json:"nodes"`
}

// ---------------------------------------------------------------------------
// Weekly-schedule specifics
// ---------------------------------------------------------------------------

// AiringSchedule is one row in airingSchedules{...}.  The embedded
// Media object only carries the subset of fields the schedule view
// renders — title, cover, format, score, genres, isAdult.
type AiringSchedule struct {
	ID       int   `json:"id"`
	AiringAt int64 `json:"airingAt"` // Unix seconds
	Episode  int   `json:"episode"`
	Media    Media `json:"media"`
}

// ---------------------------------------------------------------------------
// GraphQL wire envelope (used internally by client.go)
// ---------------------------------------------------------------------------

// graphqlRequest is the POST body shape AniList expects.
type graphqlRequest struct {
	Query     string         `json:"query"`
	Variables map[string]any `json:"variables"`
}

// graphqlError mirrors the GraphQL spec error object.  AniList populates
// `message` and (sometimes) `locations`; the latter is logged but not
// exposed to callers.
type graphqlError struct {
	Message   string         `json:"message"`
	Locations []any          `json:"locations,omitempty"`
	Path      []any          `json:"path,omitempty"`
	Extra     map[string]any `json:"extensions,omitempty"`
}

// graphqlResponse is the top-level wire envelope.  Data is decoded into
// the caller-specified type via json.RawMessage so the same envelope
// can carry Page-of-Media, Page-of-Schedule, or a bare Media.
type graphqlResponse struct {
	Data   any            `json:"data"`
	Errors []graphqlError `json:"errors,omitempty"`
}

// ---------------------------------------------------------------------------
// Query-specific response payloads — the .Data field of graphqlResponse
// ---------------------------------------------------------------------------

// SearchAnimeResponse is the typed response for SearchAnime.
type SearchAnimeResponse struct {
	Page MediaPage `json:"Page"`
}

// SeasonalAnimeResponse is the typed response for SeasonalAnime —
// identical shape to SearchAnimeResponse, kept separate so callers
// document intent at the type level.
type SeasonalAnimeResponse struct {
	Page MediaPage `json:"Page"`
}

// WeeklyScheduleResponse is the typed response for WeeklySchedule.
type WeeklyScheduleResponse struct {
	Page SchedulePage `json:"Page"`
}

// AnimeDetailResponse is the typed response for AnimeDetail — a bare
// Media object under the "Media" key (no Page wrapper).
type AnimeDetailResponse struct {
	Media Media `json:"Media"`
}

// MediaRatingsResponse is the typed response for MediaRatings.  The
// Page envelope carries no pageInfo: the caller supplies the id list and
// perPage=len(ids), so there is never a second page to ask for.
//
// The returned slice is NOT guaranteed to hold one entry per requested
// id.  AniList omits ids it no longer serves (deleted or merged media),
// and the caller has to notice -- see queue/ratings_refresh.go, where the
// ids that come back missing are stamped as checked so they stop leading
// every subsequent batch.
type MediaRatingsResponse struct {
	Page MediaPage `json:"Page"`
}

// MediaFactsResponse is the typed response for MediaFacts.  Same
// envelope and same caveat as MediaRatingsResponse: ids AniList no
// longer serves are simply absent from the slice, and the caller has to
// stamp them or they lead every subsequent batch.
type MediaFactsResponse struct {
	Page MediaPage `json:"Page"`
}
