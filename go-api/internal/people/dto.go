// Package people serves the person and character pages: GET /api/people/:id,
// GET /api/characters/:id, and the sitemap listings of the ones indexed.
//
// # Where a page's content comes from
//
// The credit tables are the page.  A person is whoever anime_staff,
// anime_characters.voice_actor_id or anime_character_voices names; a
// character is whoever anime_characters names.  Their profiles (people and
// characters, migration 0044) and their Bangumi matches (bgm_person_map and
// bgm_character_map, 0045) are additions on top: a page renders from the
// credits alone, and an id no non-adult credit names is a 404 whatever else
// the database holds about it.
//
// Accepted reader edits (entity_overlays, 0047; see internal/overlay) come
// last and win: overlay, then Bangumi's Chinese name, then AniList.  They
// change what a page says, never whether it exists, and never which titles
// a person is counted on.
//
// Nothing here calls AniList.  A crawler walking ids gets a database read and
// a 404, never an upstream request; the profiles sweep is what fills the
// profile tables, in its own time.
//
// # The JSON shapes
//
// Names travel as {full, native, cn}: AniList's romanised and native names
// and Bangumi's simplified Chinese one, each null when nobody has it.  The
// page picks between them per language; this package only decides where each
// field comes from (see nameLadder).  Titles travel under the field names
// /api/anime/:id uses (titleChinese, titleRomaji, ...), so the site's title
// pickers read them unchanged.  Dates are AniList's FuzzyDate, part by part.
package people

import (
	"time"
)

// FuzzyDate is a date AniList may know only part of: a birthday is most often
// a month and a day with no year.
type FuzzyDate struct {
	Year  *int32 `json:"year"`
	Month *int32 `json:"month"`
	Day   *int32 `json:"day"`
}

// Name is the three names a person or character can have.
type Name struct {
	// Full is AniList's name.full, romanised ("Chiaki Kobayashi").
	Full *string `json:"full"`
	// Native is AniList's name.native ("小林千晃", "シュタルク").
	Native *string `json:"native"`
	// Cn is Bangumi's simplified Chinese name ("修塔尔克").
	Cn *string `json:"cn"`
}

// Work is a title as these pages list it.
type Work struct {
	AnilistID     int32   `json:"anilistId"`
	TitleRomaji   *string `json:"titleRomaji"`
	TitleEnglish  *string `json:"titleEnglish"`
	TitleNative   *string `json:"titleNative"`
	TitleChinese  *string `json:"titleChinese"`
	TitleHant     *string `json:"titleHant"`
	TitleHantSeo  *string `json:"titleHantSeo"`
	CoverImageURL *string `json:"coverImageUrl"`
	Format        *string `json:"format"`
	// Year is the start date's year, else the season year.
	Year         *int32  `json:"year"`
	Popularity   *int32  `json:"popularity"`
	PosterAccent *string `json:"posterAccent"`

	// startDate orders titles within a year; zero when AniList gave only a
	// year or nothing.
	startDate time.Time
}

// CharacterRef is a character as a credit line shows it.
type CharacterRef struct {
	AnilistID int32   `json:"anilistId"`
	Name      Name    `json:"name"`
	Image     *string `json:"image"`
}

// PersonRef is a person as a credit line shows them.
type PersonRef struct {
	AnilistID int32   `json:"anilistId"`
	Name      Name    `json:"name"`
	Image     *string `json:"image"`
}

// VoiceRole is one character a person voiced on one title.
type VoiceRole struct {
	Character CharacterRef `json:"character"`
	Anime     Work         `json:"anime"`
	// Role is the character's role on that title: MAIN, SUPPORTING or
	// BACKGROUND.
	Role *string `json:"role"`
	// Language is AniList's languageV2 label ("Japanese").
	Language *string `json:"language"`
	// RoleNotes is AniList's free-text note ("Childhood"), null for the
	// character's main voice.
	RoleNotes *string `json:"roleNotes"`

	// characterOrder is the character's place in that title's cast.
	characterOrder int32
}

// VoiceYear is one year of a person's voice roles.
type VoiceYear struct {
	// Year is null for titles AniList has no date for.
	Year  *int32      `json:"year"`
	Roles []VoiceRole `json:"roles"`
}

// StaffWork is one title a person is credited on as staff, with every role
// they hold there in the order the title lists them.
type StaffWork struct {
	Anime Work     `json:"anime"`
	Roles []string `json:"roles"`
}

// StaffYear is one year of a person's staff credits.
type StaffYear struct {
	Year  *int32      `json:"year"`
	Works []StaffWork `json:"works"`
}

// PersonProfile is what AniList's Staff profile adds to the credits.  Null on
// the page until the profiles sweep has fetched it.  The description is not
// here: AniList's is English, and the page does not show one.
type PersonProfile struct {
	Occupations []string   `json:"occupations"`
	Gender      *string    `json:"gender"`
	Birth       *FuzzyDate `json:"birth"`
	Death       *FuzzyDate `json:"death"`
	Age         *int32     `json:"age"`
	YearsActive []int32    `json:"yearsActive"`
	HomeTown    *string    `json:"homeTown"`
	BloodType   *string    `json:"bloodType"`
	Language    *string    `json:"language"`
	SiteURL     *string    `json:"siteUrl"`
}

// Person is GET /api/people/:id.
type Person struct {
	AnilistID int32 `json:"anilistId"`
	// BangumiID is the matched Bangumi person, when the import matched one.
	BangumiID *int32         `json:"bangumiId"`
	Name      Name           `json:"name"`
	Image     *string        `json:"image"`
	Profile   *PersonProfile `json:"profile"`
	// RepresentativeRoles are the few roles the page leads with: main roles
	// in the most popular titles first.  See representativeRoles.
	RepresentativeRoles []VoiceRole `json:"representativeRoles"`
	// VoiceRoles is every voice role, by year, newest first.
	VoiceRoles []VoiceYear `json:"voiceRoles"`
	// StaffRoles is every staff credit, by title, by year, newest first.
	StaffRoles []StaffYear `json:"staffRoles"`
	// VoiceWorkCount and StaffWorkCount count distinct titles.
	VoiceWorkCount int `json:"voiceWorkCount"`
	StaffWorkCount int `json:"staffWorkCount"`
	// Indexable says whether the page asks to be indexed; see
	// MinIndexedVoiceWorks.
	Indexable bool `json:"indexable"`
}

// CharacterProfile is what AniList's Character profile adds.
type CharacterProfile struct {
	// Description is AniList's markdown as stored: links, emphasis and
	// spoiler markers (~!...!~) included.  The page renders it.
	Description *string `json:"description"`
	Gender      *string `json:"gender"`
	// Age is free text on AniList ("17-18", "1000+").
	Age       *string    `json:"age"`
	Birth     *FuzzyDate `json:"birth"`
	BloodType *string    `json:"bloodType"`
	SiteURL   *string    `json:"siteUrl"`
}

// CharacterVoice is one person who voices a character.
type CharacterVoice struct {
	// Key names the row for an edit: overlay.VoiceKey of the credit it came
	// from (person, language, notes), or overlay.AddedVoiceKey for a row an
	// accepted edit added.  It stays the credit's key after an edit gives
	// the row to someone else, so a later edit still finds it.
	Key       string    `json:"key"`
	Person    PersonRef `json:"person"`
	Language  *string   `json:"language"`
	RoleNotes *string   `json:"roleNotes"`
	// Line is the line under the name as an accepted edit wrote it; the
	// page shows it in place of the language and notes.  Null otherwise.
	Line *string `json:"line"`
}

// Appearance is one title a character is on, and their role there.
type Appearance struct {
	Anime Work    `json:"anime"`
	Role  *string `json:"role"`
}

// Character is GET /api/characters/:id.
type Character struct {
	AnilistID        int32             `json:"anilistId"`
	BangumiID        *int32            `json:"bangumiId"`
	Name             Name              `json:"name"`
	AlternativeNames []string          `json:"alternativeNames"`
	Image            *string           `json:"image"`
	Profile          *CharacterProfile `json:"profile"`
	// BangumiDescription is Bangumi's summary of the character (0048), in
	// the markup Profile.Description uses; null when Bangumi has none, and
	// when an accepted edit set the description, which every language then
	// shows.  Beside the profile, not in it: it is there whether or not the
	// profiles sweep has reached the character.  The page picks between the
	// two per language.
	BangumiDescription *string `json:"bangumiDescription"`
	// Voices is every voice of the character across its titles and
	// languages, one entry per person and note.
	Voices []CharacterVoice `json:"voices"`
	// Appearances is every title, earliest first.
	Appearances []Appearance `json:"appearances"`
	Indexable   bool         `json:"indexable"`
}

// SitemapEntry is one indexed page in a sitemap listing.
type SitemapEntry struct {
	AnilistID int32     `json:"anilistId"`
	UpdatedAt time.Time `json:"updatedAt"`
}
