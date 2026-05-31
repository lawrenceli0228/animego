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
