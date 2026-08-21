package hant

// The precedence ladder, and the provenance hash.
//
// Ladder, highest first:
//
//	manual     a human decided; this tool never overwrites it, ever
//	wikipedia  cgroup-hk.json      Hong Kong names, the overlay
//	anilist    anilist-chinese.json Taiwan names, the trunk
//	opencc     s2twp(title_chinese) the tail, excluded from search results
//	           by migration 0022's generated title_hant_seo column
//
// Hong Kong sits above Taiwan because 港澳優先 is the stated preference,
// but Taiwan is the trunk because it is the one with reach: CGroup covers
// 5.6% of subscribed anime, anilist-chinese covers 88.9%.  An overlay that
// wins where it exists, over a foundation that exists nearly everywhere,
// is how both facts get respected at once.

import (
	"crypto/sha256"
	"encoding/hex"
)

// Source vocabulary.  These strings are constrained by the CHECK on
// anime_cache.title_hant_source, and the first three are what migration
// 0022's title_hant_seo whitelist admits to search results.
const (
	SrcManual    = "manual"
	SrcWikipedia = "wikipedia"
	SrcAnilist   = "anilist"
	SrcOpenCC    = "opencc"
)

// Row is the slice of anime_cache this tool reads and writes.  It is
// a plain struct rather than the sqlc row so the ladder can be tested
// without a database.
type Row struct {
	AnilistID     int32
	TitleNative   *string
	TitleChinese  *string
	DescriptionCN *string

	TitleHant       *string
	TitleHantSource *string
	TitleHantHash   *string

	DescHant       *string
	DescHantSource *string
	DescHantHash   *string
}

// SourceHash is the digest stored in *_hant_source_hash: the SHA-256 of
// the exact input string that produced the value, lowercase hex.
//
// It exists because provenance goes stale silently.  A title_hant machine
// converted from title_chinese keeps that conversion forever after the
// Bangumi enrichment rewrites title_chinese underneath it, and nothing in
// the schema notices.  Storing the digest of the input lets a later run
// ask "is this still derived from what it claims?" without re-deriving
// every row -- which is what --restale does.
//
// The input differs by tier: the dataset value for the dataset tiers,
// title_chinese for the opencc tier, and nothing at all for manual, whose
// input is a human and cannot be hashed.
func SourceHash(input string) string {
	sum := sha256.Sum256([]byte(input))
	return hex.EncodeToString(sum[:])
}

// Decision is one column's proposed value.  Source == "" means no tier
// produced anything and the column is left alone.
type Decision struct {
	Source string
	Value  string
	Input  string
	Hash   string

	// Via names the CGroup join side that hit ("title_native" /
	// "title_chinese"); empty for other tiers.
	Via string

	// Pick carries the anilist tier's gate outcome so the report can
	// count rejections by rule even when a higher tier won.
	Pick AnilistPick

	// PickAttempted is true when the anilist dataset had a record for
	// this id, i.e. when Pick is meaningful.
	PickAttempted bool
}

// Resolver holds everything the ladder needs.  Read-only after
// construction.
type Resolver struct {
	cgroup  *cgroupSet
	anilist *anilistSet
	gate    *gate
	conv    *Converter
}

// resolveTitle walks the ladder for title_hant.
//
// The anilist tier is consulted even when CGroup already won, because the
// report's per-rule rejection counts are a property of the dataset, not
// of which rows happened to miss the overlay -- and because the list of
// Simplified-rejected titles is only useful if it is complete.
func (r *Resolver) resolveTitle(row Row) Decision {
	var d Decision

	if pick, ok := r.anilist.pick(row.AnilistID, r.gate); ok {
		d.Pick = pick
		d.PickAttempted = true
	}

	if hit, ok := r.cgroup.lookup(row.TitleNative, row.TitleChinese); ok {
		if reason, _ := r.gate.check(hit.Value); reason == ReasonNone {
			d.Source = SrcWikipedia
			d.Value = hit.Value
			d.Input = hit.Value
			d.Hash = SourceHash(hit.Value)
			d.Via = hit.Via
			return d
		}
		// A Hong Kong value that fails the gate falls through rather than
		// being written.  Five zh_hk values carry a Simplified character
		// and two carry kana; the ladder is the right place to absorb
		// that, not the column.
	}

	if d.PickAttempted && d.Pick.Value != "" {
		d.Source = SrcAnilist
		d.Value = d.Pick.Value
		d.Input = d.Pick.Value
		d.Hash = SourceHash(d.Pick.Value)
		return d
	}

	if row.TitleChinese != nil && *row.TitleChinese != "" {
		converted := r.conv.Convert(*row.TitleChinese)
		d.Source = SrcOpenCC
		d.Value = converted
		d.Input = *row.TitleChinese
		d.Hash = SourceHash(*row.TitleChinese)
		return d
	}

	return d
}

// resolveDescription is the same shape with one tier.
//
// No dataset carries a Traditional synopsis, so s2twp(description_cn) is
// the only thing that can fill this column -- which is why migration
// 0022's CHECK on description_hant_source admits only 'opencc' and
// 'manual'.  Machine conversion is safe here in a way it is not for
// titles because descriptions never reach <title>, og:title or JSON-LD
// name; the detail page's generateMetadata reads the English description
// directly (see the SEO BOUNDARY comment in
// next-app/src/app/[lang]/anime/[id]/page.tsx).  An 85%-accurate synopsis
// under a Traditional locale is a readable synopsis.  An 85%-accurate
// title in a search result is what Google learns the page is about.
func (r *Resolver) resolveDescription(row Row) Decision {
	if row.DescriptionCN == nil || *row.DescriptionCN == "" {
		return Decision{}
	}
	return Decision{
		Source: SrcOpenCC,
		Value:  r.conv.Convert(*row.DescriptionCN),
		Input:  *row.DescriptionCN,
		Hash:   SourceHash(*row.DescriptionCN),
	}
}

// ─── manual protection ───────────────────────────────────────────────────────

// isManual reports whether a source column is the manual tier.
//
// Checked in three places on purpose: here before proposing anything, in
// the report so manual rows are counted rather than silently missing, and
// again in the UPDATE's WHERE clause.  The SQL guard is the one that
// actually holds -- it survives a bug in this file.
func isManual(source *string) bool {
	return source != nil && *source == SrcManual
}

// ─── staleness ───────────────────────────────────────────────────────────────

// StaleKind classifies a stored row against what its claimed source
// would produce today.
type StaleKind string

const (
	StaleNone StaleKind = ""
	// StaleHash: the stored hash does not match the digest of the input
	// its source claims to derive from.  This is the case migration 0022
	// was written for -- title_chinese moved and title_hant did not.
	StaleHash StaleKind = "hash_mismatch"
	// StaleMissingHash: a value with a source but no hash.  Nothing this
	// tool writes looks like that; it means an older writer or a hand
	// edit that used a source other than 'manual'.
	StaleMissingHash StaleKind = "missing_hash"
	// StaleGone: the source can no longer produce any input at all -- the
	// dataset dropped the id, or title_chinese was nulled out.
	StaleGone StaleKind = "input_gone"
)

// checkStale re-derives the input for a stored value and compares hashes.
// It never rewrites anything; --apply is what rewrites, and it does so by
// re-running the ladder rather than by trusting this classification.
func (r *Resolver) checkStale(row Row, value, source, hash *string) StaleKind {
	if value == nil || source == nil {
		return StaleNone
	}
	if *source == SrcManual {
		// A human wrote it; there is no input to compare against and the
		// NULL hash is correct rather than missing.
		return StaleNone
	}

	input, ok := r.currentInput(row, *source)
	if !ok {
		return StaleGone
	}
	if hash == nil || *hash == "" {
		return StaleMissingHash
	}
	if *hash != SourceHash(input) {
		return StaleHash
	}
	return StaleNone
}

// currentInput returns the string the given source would consume for this
// row today.
func (r *Resolver) currentInput(row Row, source string) (string, bool) {
	switch source {
	case SrcWikipedia:
		hit, ok := r.cgroup.lookup(row.TitleNative, row.TitleChinese)
		if !ok {
			return "", false
		}
		return hit.Value, true
	case SrcAnilist:
		pick, ok := r.anilist.pick(row.AnilistID, r.gate)
		if !ok || pick.Value == "" {
			return "", false
		}
		return pick.Value, true
	case SrcOpenCC:
		if row.TitleChinese == nil || *row.TitleChinese == "" {
			return "", false
		}
		return *row.TitleChinese, true
	}
	return "", false
}

// checkDescriptionStale is the description column's equivalent.  Only the
// opencc tier exists, so the input is always description_cn.
func (r *Resolver) checkDescriptionStale(row Row) StaleKind {
	if row.DescHant == nil || row.DescHantSource == nil {
		return StaleNone
	}
	if *row.DescHantSource == SrcManual {
		return StaleNone
	}
	if row.DescriptionCN == nil || *row.DescriptionCN == "" {
		return StaleGone
	}
	if row.DescHantHash == nil || *row.DescHantHash == "" {
		return StaleMissingHash
	}
	if *row.DescHantHash != SourceHash(*row.DescriptionCN) {
		return StaleHash
	}
	return StaleNone
}
