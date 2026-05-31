package anime

import (
	"github.com/lawrenceli0228/animego/go-api/internal/anilist"
	"github.com/lawrenceli0228/animego/go-api/internal/colorx"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// NormalizeMainRow converts an anilist.Media into the UpsertAnimeCacheParams
// shape sqlc expects.  Port of the JS normalize() in
// server/services/anilist.service.js:53-72 — main row only, child tables
// (genres / studios / relations / characters / staff / recommendations)
// are NOT touched here; callers wanting those must call Genres() and the
// detail-table helpers separately.
//
// Field mappings:
//
//	anilist.Media        →  UpsertAnimeCacheParams
//	-----------------------------------------------
//	id                   →  anilist_id          (int → int32)
//	title.romaji         →  title_romaji        (*string passthrough)
//	title.english        →  title_english
//	title.native         →  title_native
//	coverImage.extraLarge||large → cover_image_url  (JS `||` fallback)
//	coverImage.color     →  cover_image_color   + accentFields() output
//	bannerImage          →  banner_image_url
//	description          →  description
//	episodes             →  episodes            (*int → *int32)
//	status               →  status
//	season               →  season
//	seasonYear           →  season_year         (*int → *int32)
//	averageScore         →  average_score       (*int → *float64; AniList 0-100 scale)
//	format               →  format
//
// title_chinese, bgm_id, bangumi_score, bangumi_votes, bangumi_version
// are NOT set here — Bangumi enrichment workers own those columns and
// the upsert SQL preserves them on conflict.
//
// accentFields() (Express anilist.service.js:9-12) is folded into this
// function via colorx.NormalizePosterAccent.  Brand-fallback (#8B5CF6)
// applies for null / invalid / grayscale color inputs, so the three
// poster_accent_* columns ALWAYS land non-null.
func NormalizeMainRow(m anilist.Media) dbgen.UpsertAnimeCacheParams {
	var rawColor string
	if m.CoverImage != nil && m.CoverImage.Color != nil {
		rawColor = *m.CoverImage.Color
	}
	accent := colorx.NormalizePosterAccent(rawColor)

	return dbgen.UpsertAnimeCacheParams{
		AnilistID:                   int32(m.ID),
		TitleRomaji:                 deref(m.Title, func(t *anilist.Title) *string { return t.Romaji }),
		TitleEnglish:                deref(m.Title, func(t *anilist.Title) *string { return t.English }),
		TitleNative:                 deref(m.Title, func(t *anilist.Title) *string { return t.Native }),
		CoverImageUrl:               coverImageURL(m.CoverImage),
		CoverImageColor:             deref(m.CoverImage, func(c *anilist.CoverImage) *string { return c.Color }),
		PosterAccent:                ptrString(accent.Accent),
		PosterAccentRgb:             ptrString(accent.AccentRgb),
		PosterAccentContrastOnBlack: ptrFloat64(accent.AccentContrastOnBlack),
		BannerImageUrl:              m.BannerImage,
		Description:                 m.Description,
		Episodes:                    ptrInt32(m.Episodes),
		Status:                      m.Status,
		Season:                      m.Season,
		SeasonYear:                  ptrInt32(m.SeasonYear),
		AverageScore:                intPtrToFloat64Ptr(m.AverageScore),
		Format:                      m.Format,
	}
}

// Genres returns the media's genres slice — never nil; an empty Media
// yields an empty slice so callers can range without a guard.  Used by
// child-table upsert helpers that don't exist yet (P2.1.5).
func Genres(m anilist.Media) []string {
	if m.Genres == nil {
		return []string{}
	}
	return m.Genres
}

// coverImageURL implements Express's `m.coverImage?.extraLarge || m.coverImage?.large`.
// JavaScript `||` is falsy-skip; empty string counts as falsy, so an
// empty extraLarge falls through to large.  Returns nil when both are
// missing.
func coverImageURL(c *anilist.CoverImage) *string {
	if c == nil {
		return nil
	}
	if c.ExtraLarge != nil && *c.ExtraLarge != "" {
		return c.ExtraLarge
	}
	if c.Large != nil && *c.Large != "" {
		return c.Large
	}
	return nil
}

// deref pulls a nested *string out of a parent pointer.  Returns nil
// when the parent itself is nil — matches the JS optional-chaining
// `m.title?.romaji` semantics.
func deref[T any](parent *T, pick func(*T) *string) *string {
	if parent == nil {
		return nil
	}
	return pick(parent)
}

// ptrString is a 1-line helper for taking the address of a literal value
// (Go doesn't let you write `&"hello"`).
func ptrString(s string) *string { return &s }

// ptrFloat64 mirrors ptrString for float values.
func ptrFloat64(f float64) *float64 { return &f }

// ptrInt32 widens / narrows an *int into *int32 — Go's int is 64-bit on
// the platforms we run, but the DB columns are int32, so the cast must
// be explicit.  Returns nil on nil input.
func ptrInt32(p *int) *int32 {
	if p == nil {
		return nil
	}
	v := int32(*p)
	return &v
}

// intPtrToFloat64Ptr converts *int → *float64.  AniList returns
// averageScore as a 0-100 integer; the DB column is numeric(4,2) which
// sqlc maps to *float64 (see sqlc.yaml override).  Returns nil on nil.
func intPtrToFloat64Ptr(p *int) *float64 {
	if p == nil {
		return nil
	}
	v := float64(*p)
	return &v
}

// =============================================================================
// Child-row normalize helpers (P2.1.6).
//
// These convert detail-only fields of anilist.Media into the per-row insert
// payloads the six anime_* child tables expect.  Each helper mirrors a JS
// branch in server/services/anilist.service.js normalize() (lines 53-113):
//
//	m.studios   → anime_studios     (studio names only)
//	m.relations → anime_relations   (with accent fields per relation cover)
//	m.characters→ anime_characters  (display_order = slice index)
//	m.staff     → anime_staff       (display_order = slice index)
//	m.recommendations → anime_recommendations
//
// All accent fields run through colorx.NormalizePosterAccent the same way
// NormalizeMainRow does, so brand-fallback (#8B5CF6) lands on nil / invalid /
// grayscale colour inputs.  That guarantees the three poster_accent_* columns
// always carry a value — frontend renders cleanly even for media with no
// AniList-reported colour data.
//
// Title selection matches JS's `e.node.title?.romaji || e.node.title?.native`
// falsy-skip: empty strings fall through to the native fallback.
//
// Why not return dbgen.Insert*Params directly?  Two reasons:
//   1. Keeps detail.go in control of attaching the parent anime_id (kept out
//      of these helpers so a child-row helper stays a pure function of one
//      Media's payload — useful for tests).
//   2. The Row types here own the *shape* of one row's payload; the caller
//      maps Row → InsertParams + the anime_id at upsert time.  This split
//      avoids carrying the anime_id through every helper signature.
// =============================================================================

// RelationRow is one child-row payload for anime_relations.  Mirrors the
// JS `m.relations.edges.map(e => ({...}))` output.
type RelationRow struct {
	AnilistID                   int32
	RelationType                *string
	Title                       *string
	CoverImageUrl               *string
	CoverImageColor             *string
	PosterAccent                *string
	PosterAccentRgb             *string
	PosterAccentContrastOnBlack *float64
	Format                      *string
}

// CharacterRow is one child-row payload for anime_characters.  DisplayOrder
// must be assigned by the caller (typically the slice index).  NameCn is
// always nil here — V2 enrichment fills it via Bangumi later.
type CharacterRow struct {
	DisplayOrder       int32
	NameEn             *string
	NameJa             *string
	NameCn             *string // always nil from AniList; V2 worker writes this
	ImageUrl           *string
	Role               *string
	VoiceActorEn       *string
	VoiceActorJa       *string
	VoiceActorImageUrl *string
}

// StaffRow is one child-row payload for anime_staff.  DisplayOrder must be
// assigned by the caller (slice index).
type StaffRow struct {
	DisplayOrder int32
	NameEn       *string
	NameJa       *string
	ImageUrl     *string
	Role         *string
}

// RecommendationRow is one child-row payload for anime_recommendations.
type RecommendationRow struct {
	AnilistID                   int32
	Title                       *string
	CoverImageUrl               *string
	CoverImageColor             *string
	PosterAccent                *string
	PosterAccentRgb             *string
	PosterAccentContrastOnBlack *float64
	AverageScore                *float64
}

// StudiosFromMedia extracts studio names from a Media's StudioConnection.
// Returns empty slice (never nil) so callers can range without a guard.
// Mirrors Express `m.studios.nodes.map(n => n.name)`.
func StudiosFromMedia(m anilist.Media) []string {
	if m.Studios == nil || len(m.Studios.Nodes) == 0 {
		return []string{}
	}
	out := make([]string, 0, len(m.Studios.Nodes))
	for _, n := range m.Studios.Nodes {
		out = append(out, n.Name)
	}
	return out
}

// RelationsFromMedia maps Media.Relations to []RelationRow.  Each row's
// accent fields come from colorx.NormalizePosterAccent over the relation
// edge's cover colour (brand-fallback for nil / invalid colour).  The
// cover URL uses `e.node.coverImage?.large ?? null` directly — Express's
// detail query asks for .large explicitly (NOT .extraLarge) on relation
// edges; preserve that byte-for-byte.
//
// Title selection follows JS `e.node.title?.romaji || e.node.title?.native`
// (falsy-skip on empty string).
func RelationsFromMedia(m anilist.Media) []RelationRow {
	if m.Relations == nil || len(m.Relations.Edges) == 0 {
		return []RelationRow{}
	}
	out := make([]RelationRow, 0, len(m.Relations.Edges))
	for _, e := range m.Relations.Edges {
		var rawColor string
		var coverColor *string
		var coverURL *string
		if e.Node.CoverImage != nil {
			coverURL = e.Node.CoverImage.Large // .large, NOT .extraLarge
			if e.Node.CoverImage.Color != nil {
				rawColor = *e.Node.CoverImage.Color
				coverColor = e.Node.CoverImage.Color
			}
		}
		accent := colorx.NormalizePosterAccent(rawColor)

		out = append(out, RelationRow{
			AnilistID:                   int32(e.Node.ID),
			RelationType:                e.RelationType,
			Title:                       titleRomajiOrNative(e.Node.Title),
			CoverImageUrl:               coverURL,
			CoverImageColor:             coverColor,
			PosterAccent:                ptrString(accent.Accent),
			PosterAccentRgb:             ptrString(accent.AccentRgb),
			PosterAccentContrastOnBlack: ptrFloat64(accent.AccentContrastOnBlack),
			Format:                      e.Node.Format,
		})
	}
	return out
}

// CharactersFromMedia maps Media.Characters to []CharacterRow.  DisplayOrder
// is the slice index (0-based) so the relational re-read preserves AniList
// edge ordering.  VoiceActor* fields come from edges.voiceActors[0] when
// present — Express picks the first JAPANESE entry, the GraphQL query
// already filters server-side so the first array entry is the correct one.
// NameCn is always nil here; V2 enrichment writes it via Bangumi later.
func CharactersFromMedia(m anilist.Media) []CharacterRow {
	if m.Characters == nil || len(m.Characters.Edges) == 0 {
		return []CharacterRow{}
	}
	out := make([]CharacterRow, 0, len(m.Characters.Edges))
	for i, e := range m.Characters.Edges {
		var nameEn, nameJa, imageURL *string
		if e.Node.Name != nil {
			nameEn = e.Node.Name.Full
			nameJa = e.Node.Name.Native
		}
		if e.Node.Image != nil {
			imageURL = e.Node.Image.Medium
		}

		var vaEn, vaJa, vaImg *string
		if len(e.VoiceActors) > 0 {
			va := e.VoiceActors[0]
			if va.Name != nil {
				vaEn = va.Name.Full
				vaJa = va.Name.Native
			}
			if va.Image != nil {
				vaImg = va.Image.Medium
			}
		}

		out = append(out, CharacterRow{
			DisplayOrder:       int32(i),
			NameEn:             nameEn,
			NameJa:             nameJa,
			NameCn:             nil,
			ImageUrl:           imageURL,
			Role:               e.Role,
			VoiceActorEn:       vaEn,
			VoiceActorJa:       vaJa,
			VoiceActorImageUrl: vaImg,
		})
	}
	return out
}

// StaffFromMedia maps Media.Staff to []StaffRow.  DisplayOrder = slice
// index.  Mirrors Express `m.staff.edges.map(e => ({...}))`.
func StaffFromMedia(m anilist.Media) []StaffRow {
	if m.Staff == nil || len(m.Staff.Edges) == 0 {
		return []StaffRow{}
	}
	out := make([]StaffRow, 0, len(m.Staff.Edges))
	for i, e := range m.Staff.Edges {
		var nameEn, nameJa, imageURL *string
		if e.Node.Name != nil {
			nameEn = e.Node.Name.Full
			nameJa = e.Node.Name.Native
		}
		if e.Node.Image != nil {
			imageURL = e.Node.Image.Medium
		}
		out = append(out, StaffRow{
			DisplayOrder: int32(i),
			NameEn:       nameEn,
			NameJa:       nameJa,
			ImageUrl:     imageURL,
			Role:         e.Role,
		})
	}
	return out
}

// RecommendationsFromMedia maps Media.Recommendations to []RecommendationRow.
// Express filters out nodes whose mediaRecommendation pointer is nil
// (`.filter(n => n.mediaRecommendation)`); match that byte-for-byte.  Title
// selection follows the same romaji-or-native falsy-skip rule used elsewhere.
// Cover URL uses `.large` directly (NOT .extraLarge) — Express's detail
// query requests .large only on recommendation nodes.
func RecommendationsFromMedia(m anilist.Media) []RecommendationRow {
	if m.Recommendations == nil || len(m.Recommendations.Nodes) == 0 {
		return []RecommendationRow{}
	}
	out := make([]RecommendationRow, 0, len(m.Recommendations.Nodes))
	for _, n := range m.Recommendations.Nodes {
		if n.MediaRecommendation == nil {
			continue // Express: `.filter(n => n.mediaRecommendation)`
		}
		mr := n.MediaRecommendation
		var rawColor string
		var coverColor *string
		var coverURL *string
		if mr.CoverImage != nil {
			coverURL = mr.CoverImage.Large
			if mr.CoverImage.Color != nil {
				rawColor = *mr.CoverImage.Color
				coverColor = mr.CoverImage.Color
			}
		}
		accent := colorx.NormalizePosterAccent(rawColor)

		out = append(out, RecommendationRow{
			AnilistID:                   int32(mr.ID),
			Title:                       titleRomajiOrNative(mr.Title),
			CoverImageUrl:               coverURL,
			CoverImageColor:             coverColor,
			PosterAccent:                ptrString(accent.Accent),
			PosterAccentRgb:             ptrString(accent.AccentRgb),
			PosterAccentContrastOnBlack: ptrFloat64(accent.AccentContrastOnBlack),
			AverageScore:                intPtrToFloat64Ptr(mr.AverageScore),
		})
	}
	return out
}

// titleRomajiOrNative implements JS's `t?.romaji || t?.native` falsy-skip.
// Empty string falls through to the native fallback, matching Express's
// JavaScript `||` semantics.  Returns nil only when both candidates are
// nil-or-empty.
func titleRomajiOrNative(t *anilist.Title) *string {
	if t == nil {
		return nil
	}
	if t.Romaji != nil && *t.Romaji != "" {
		return t.Romaji
	}
	if t.Native != nil && *t.Native != "" {
		return t.Native
	}
	return nil
}
