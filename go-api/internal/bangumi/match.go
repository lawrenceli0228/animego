// Package bangumi — match.go
//
// Candidate-scoring logic for the Phase-1 enrichment worker.
//
// Background: the worker searches Bangumi by anime title, then must decide
// whether the top result (or any candidate) is actually the same work as the
// AniList entry it is trying to enrich.  Blindly picking list[0] caused ~10%
// wrong bindings in a live audit (wrong Chinese name, wrong score attached).
//
// Scoring rationale:
//
//		final = 0.70 × titleSim + 0.20 × yearScore + 0.10 × epsScore
//
//	  - Title similarity (70%) is the dominant signal.  We compare each of the
//	    three AniList title variants (native/romaji/English) against both
//	    Bangumi Name and NameCN, then take the max.  Titles are NFKC-normalised,
//	    lowercased, stripped of all whitespace and punctuation, and have
//	    season/format markers removed before comparison.  Similarity is the
//	    Sørensen–Dice coefficient over character bigrams — no external dep.
//
//	  - Year score (20%) confirms the broadcast year.  Unknown year on either
//	    side is treated as neutral (0.5) rather than penalising.  A one-year
//	    delta (boundary season) scores 0.6; two or more scores 0.0.
//
//	  - Episode count (10%) catches season-length mismatches (e.g. a 12-ep
//	    sequel mis-matched to a 25-ep original).  Again unknown → neutral.
//
// Tier thresholds (see PickBest):
//   - TierHigh  → worker binds authoritatively.
//   - TierLow   → ambiguous; mark needs-review, do NOT bind.
//   - TierNone  → no plausible match.
package bangumi

import (
	"strconv"
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

// MatchInput is the AniList-side anime we are trying to match to a Bangumi
// subject.  Zero values for SeasonYear and Episodes are treated as "unknown"
// and contribute a neutral 0.5 to their respective score components.
type MatchInput struct {
	TitleNative  string // Japanese title (primary)
	TitleRomaji  string
	TitleEnglish string
	SeasonYear   int // 0 if unknown
	Episodes     int // 0 if unknown
}

// MatchTier is the confidence bucket the caller (worker) acts on.
type MatchTier string

const (
	// TierHigh means the scorer is confident enough that the worker should
	// bind the Bangumi subject to the AniList entry authoritatively.
	TierHigh MatchTier = "high"
	// TierLow means the match is ambiguous.  The caller should NOT bind and
	// should instead flag the entry for manual review.
	TierLow MatchTier = "low"
	// TierNone means no plausible match was found.
	TierNone MatchTier = "none"
)

// Threshold constants used by PickBest to decide the confidence tier.
const (
	ScoreHigh     = 0.82 // combined score above which we consider the match high-confidence
	ScoreLow      = 0.55 // combined score above which we consider the match plausible
	TitleSimFloor = 0.60 // minimum title similarity required for TierHigh at ScoreHigh
)

// punctuationCutSet is the set of punctuation characters we strip in
// NormalizeTitle (ASCII and Japanese/CJK set).
const punctuationCutSet = `！!？?：:・·、。，,．.~〜-—–「」『』【】()（）/／''"　`

// seasonSuffixReplacer strips common trailing season/series markers so that
// "アオアシ 第2期" and "アオアシ" compare as equal after normalisation.
// Markers are removed AFTER the rest of normalisation (already lower/stripped).
var seasonSuffixReplacer = strings.NewReplacer(
	// Arabic season numbers with common delimiters
	"season2", "",
	"season3", "",
	"season4", "",
	"season5", "",
	"season6", "",
	"season7", "",
	"season8", "",
	"season9", "",
	// English ordinals (stripped of punctuation, so "2nd" not "2nd.")
	"2ndseason", "",
	"3rdseason", "",
	"4thseason", "",
	"5thseason", "",
	// Japanese ordinals — 第N期 becomes 第n期 after lower then we remove numeric variants
	"第2期", "",
	"第3期", "",
	"第4期", "",
	"第5期", "",
	"第6期", "",
	"第7期", "",
	"第8期", "",
	"第9期", "",
	// Roman numerals (common in anime titles)
	"ⅱ", "",
	"ⅲ", "",
	"ⅳ", "",
	"ⅴ", "",
	"ⅵ", "",
	"ⅶ", "",
	"ⅷ", "",
	"ⅸ", "",
	"ii", "",
	"iii", "",
	"iv", "",
	// Format markers
	"oad", "",
	"ova", "",
	"ona", "",
	"movie", "",
	"film", "",
	// Part markers
	"part2", "",
	"part3", "",
	"part4", "",
	"part5", "",
	"part2", "",
	"partii", "",
	"partiii", "",
	"partiv", "",
)

// NormalizeTitle applies NFKC normalisation, lowercases, strips all ASCII and
// Japanese punctuation, strips all whitespace (including full-width space
// U+3000), and removes trailing season/format markers.  The result is a
// compact, folded string suitable for similarity comparison.
//
// The function is pure and deterministic — safe to call from multiple
// goroutines.
func NormalizeTitle(s string) string {
	if s == "" {
		return ""
	}

	// 1. NFKC — collapses compatibility characters (e.g. full-width ASCII,
	//    half-width katakana, roman numerals Ⅱ→II) into their canonical forms.
	s = norm.NFKC.String(s)

	// 2. Lowercase (after NFKC so full-width Latin is already folded to ASCII).
	s = strings.ToLower(s)

	// 3. Strip punctuation characters listed in punctuationCutSet, and strip
	//    all Unicode whitespace in one pass.
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		if strings.ContainsRune(punctuationCutSet, r) {
			continue
		}
		if unicode.IsSpace(r) {
			continue
		}
		b.WriteRune(r)
	}
	s = b.String()

	// 4. Remove season/format markers (replacer works on the already-compacted
	//    string — no spaces to worry about).
	s = seasonSuffixReplacer.Replace(s)

	return s
}

// bigrams returns the multiset of character bigrams for s as a map from
// bigram → count.  Single-character strings have no bigrams; the result is
// an empty map (not nil).
func bigrams(s string) map[string]int {
	runes := []rune(s)
	m := make(map[string]int, len(runes))
	for i := 0; i+1 < len(runes); i++ {
		m[string(runes[i:i+2])]++
	}
	return m
}

// TitleSimilarity returns the Sørensen–Dice coefficient over character bigrams
// of the two NormalizeTitle-processed strings.  Returns 1.0 for identical
// inputs (including two empty strings) and 0.0 when either normalised form
// has no bigrams (single-character or empty after normalisation).
//
// Range: [0, 1].
func TitleSimilarity(a, b string) float64 {
	na := NormalizeTitle(a)
	nb := NormalizeTitle(b)

	if na == nb {
		return 1.0
	}

	ba := bigrams(na)
	bb := bigrams(nb)

	if len(ba) == 0 || len(bb) == 0 {
		return 0.0
	}

	// |A ∩ B| in the bigram multiset sense: sum of min counts.
	var intersection int
	for bg, ca := range ba {
		if cb, ok := bb[bg]; ok {
			if ca < cb {
				intersection += ca
			} else {
				intersection += cb
			}
		}
	}

	totalA := 0
	for _, c := range ba {
		totalA += c
	}
	totalB := 0
	for _, c := range bb {
		totalB += c
	}

	// Dice = 2|A∩B| / (|A|+|B|)
	return float64(2*intersection) / float64(totalA+totalB)
}

// bestTitleSim computes the maximum TitleSimilarity between any pair drawn
// from the set of input titles and the set of candidate titles.  Empty strings
// are skipped (they would give a misleadingly high similarity due to both
// normalising to "").
func bestTitleSim(in MatchInput, c SearchResult) float64 {
	inTitles := []string{in.TitleNative, in.TitleRomaji, in.TitleEnglish}
	cTitles := []string{c.Name, c.NameCN}

	var best float64
	for _, it := range inTitles {
		if it == "" {
			continue
		}
		for _, ct := range cTitles {
			if ct == "" {
				continue
			}
			if s := TitleSimilarity(it, ct); s > best {
				best = s
			}
		}
	}
	return best
}

// yearScore computes the year-match component (0.0–1.0).
// If either year is unknown (in.SeasonYear==0 or c.Date is too short to
// contain a valid year), returns 0.5 (neutral/unknown).
func yearScore(in MatchInput, c SearchResult) float64 {
	if in.SeasonYear == 0 {
		return 0.5
	}
	if len(c.Date) < 4 {
		return 0.5
	}
	cy, err := strconv.Atoi(c.Date[:4])
	if err != nil {
		return 0.5
	}
	delta := in.SeasonYear - cy
	if delta < 0 {
		delta = -delta
	}
	switch {
	case delta == 0:
		return 1.0
	case delta == 1:
		return 0.6
	default:
		return 0.0
	}
}

// epsScore computes the episode-count match component (0.0–1.0).
func epsScore(in MatchInput, c SearchResult) float64 {
	if in.Episodes == 0 || c.Eps == 0 {
		return 0.5
	}
	delta := in.Episodes - c.Eps
	if delta < 0 {
		delta = -delta
	}
	switch {
	case delta == 0:
		return 1.0
	case delta == 1:
		return 0.7
	default:
		return 0.0
	}
}

// ScoreCandidate returns a weighted confidence score in [0, 1] for a single
// (MatchInput, SearchResult) pair:
//
//	score = 0.70 × titleSim + 0.20 × yearScore + 0.10 × epsScore
func ScoreCandidate(in MatchInput, c SearchResult) float64 {
	ts := bestTitleSim(in, c)
	ys := yearScore(in, c)
	es := epsScore(in, c)
	return 0.70*ts + 0.20*ys + 0.10*es
}

// PickBest scores every candidate in list and returns the highest-scoring one
// together with its score and confidence tier.
//
// Tier assignment (evaluated in order):
//  1. If bestTitleSim ≥ 0.95 AND yearScore ≠ 0.0 → TierHigh (near-exact
//     title, year not contradicting).
//  2. Else if score ≥ ScoreHigh AND bestTitleSim ≥ TitleSimFloor → TierHigh.
//  3. Else if score ≥ ScoreLow → TierLow.
//  4. Else → TierNone.
//
// An empty list returns (nil, 0, TierNone).
func PickBest(in MatchInput, list []SearchResult) (best *SearchResult, score float64, tier MatchTier) {
	if len(list) == 0 {
		return nil, 0, TierNone
	}

	var bestIdx int
	bestScore := -1.0
	for i := range list {
		s := ScoreCandidate(in, list[i])
		if s > bestScore {
			bestScore = s
			bestIdx = i
		}
	}

	winner := &list[bestIdx]
	ts := bestTitleSim(in, *winner)
	ys := yearScore(in, *winner)

	var t MatchTier
	switch {
	case ts >= 0.95 && ys != 0.0:
		t = TierHigh
	case bestScore >= ScoreHigh && ts >= TitleSimFloor:
		t = TierHigh
	case bestScore >= ScoreLow:
		t = TierLow
	default:
		t = TierNone
	}

	return winner, bestScore, t
}
