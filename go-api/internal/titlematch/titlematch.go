// Package titlematch decides whether two anime titles name the same entry.
//
// It is a pure-string package: no database row types, no I/O, no query
// dependency.  Callers that hold rows, upstream API payloads or queue jobs
// pull the title strings off their own types and pass them in — which is what
// lets the dandanplay /match ranker and a Bangumi binding gate share one
// implementation instead of two that drift apart.
//
// The point of the package is that identity is TWO INDEPENDENT SIGNALS:
//
//	similarity — season-blind, answers "same franchise?"
//	marker     — explicit season/part numbers, answers "same entry?"
//
// They must stay independent.  bangumi.NormalizeTitle, which Similarity builds
// on, deliberately STRIPS season markers ("Ⅱ", "第2期", "part2", …) so that an
// enrichment worker can bind "アオアシ 第2期" to "アオアシ".  That makes every
// season of a franchise normalise to the same string and score nearly
// identically — consecutive seasons of a long franchise land around 0.85
// similarity, which no floor can separate.
//
// So the marker is a HARD GATE, not a weight: a season-3 query must never
// resolve to a season-2 candidate no matter how similar the titles read.
// Folding the two signals into a single combined score reintroduces the bug
// this logic was written for — a season 3 file rendering season 2's score,
// year, episode count and "view details" link.
//
// Callers ask the two questions separately:
//
//	sim := titlematch.BestSimilarity(subjectName, native, romaji)
//	if sim < titlematch.SimilarityFloor { /* different show */ }
//	if !titlematch.MarkerFor(native, romaji).SameEntry(
//		titlematch.ExtractMarker(subjectName)) { /* different season */ }
package titlematch

import (
	"github.com/lawrenceli0228/animego/go-api/internal/bangumi"
)

// SimilarityFloor is the minimum season-blind title similarity a candidate
// needs before it may be accepted as the same work — unless it clears the
// containment rule in MatchesQuery instead.  The season/part gate is what
// rejects wrong entries of the right franchise; this is a secondary net for
// candidates that pass the gate but describe a different show entirely.
const SimilarityFloor = 0.45

// Similarity is the season-blind similarity of two titles, in [0, 1].
//
// It is the Sørensen–Dice coefficient over character bigrams of the two
// bangumi.NormalizeTitle-folded strings, and it is symmetric.  Season-blind is
// not an accident to be fixed here: see the package doc.  Pair every use with
// a marker comparison.
func Similarity(a, b string) float64 {
	return bangumi.TitleSimilarity(a, b)
}

// BestSimilarity is the highest Similarity between query and any candidate.
//
// Max-over-candidates is the only fair reading when a single entry carries
// titles in several scripts (Chinese, native Japanese, romaji, English) and
// the query is in exactly one of them: the non-matching scripts score near
// zero and would drag an average below any usable floor.
//
// Empty candidate strings are the caller's to filter; with no candidates at
// all the result is 0.
func BestSimilarity(query string, candidates ...string) float64 {
	best := 0.0
	for _, c := range candidates {
		if s := Similarity(query, c); s > best {
			best = s
		}
	}
	return best
}

// MatchesQuery reports whether a candidate set that has ALREADY cleared the
// season/part gate is a plausible answer for query, plus its similarity for
// ranking.  It does not gate on season itself — callers must run the marker
// comparison separately, which is the whole point of the two-signal split.
//
// Two ways to pass, because Sørensen–Dice punishes length mismatch hard: a
// bare franchise keyword ("无职转生", which is all a folder name gives us)
// scores far below the floor against the full title "无职转生～到了异世界就拿出
// 真本事～" even though it is unambiguously the same show — and it is the very
// substring that produced this candidate in the first place.  So containment
// is an alternative pass.
//
// LooselyMatchesKeyword normalises with LooseNormalize, which (unlike
// bangumi.NormalizeTitle) keeps season markers intact — so containment cannot
// smuggle a wrong season past a caller's gate either.
//
// Callers holding two full titles rather than a keyword should prefer
// BestSimilarity against SimilarityFloor directly; the containment branch
// exists for the keyword-versus-full-title shape.
func MatchesQuery(query string, candidates ...string) (bool, float64) {
	sim := BestSimilarity(query, candidates...)
	if sim >= SimilarityFloor {
		return true, sim
	}
	for _, c := range candidates {
		if LooselyMatchesKeyword(c, query) {
			return true, sim
		}
	}
	return false, sim
}
