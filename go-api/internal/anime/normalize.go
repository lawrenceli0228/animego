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
