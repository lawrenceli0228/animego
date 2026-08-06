package bangumi

import (
	"regexp"
	"strings"
	"unicode"
)

// Cleaning and language-gating for Subject.Summary before it may be stored
// as a Chinese description.
//
// Bangumi summaries are user-edited free text and come in three shapes that
// all have to be handled before the value is fit to render:
//
//  1. Chinese prose — what we want.
//  2. Chinese prose followed by a "[简介原文]" divider and the full Japanese
//     original. Everything from the divider on has to go, or the detail page
//     shows a Chinese paragraph trailed by an untranslated Japanese one.
//  3. Japanese original only, no Chinese at all. Common on newly-airing
//     shows, because the Chinese summary is written later by the community.
//
// Measured against prod on 2026-08-06 — 150 subjects sampled from the rows
// that pass the id_map trust gate, fetched live from bgm.tv:
//
//	usable Chinese   57.3%   (95% CI 49.4–65.2)
//	Japanese only    36.7%   <- shape 3, must be rejected
//	empty             3.3%
//	too short         2.7%
//	carries divider   1.3%   <- shape 2, recoverable after stripping
//
// That 36.7% is why the language gate is not optional: without it, better
// than a third of enriched rows would replace an English description the
// reader cannot read with a Japanese one they equally cannot read.

// summaryDivider matches Bangumi's convention for appending the untranslated
// original. Everything from the marker to the end of the string is dropped.
var summaryDivider = regexp.MustCompile(`\[简介原文\][\s\S]*$`)

// sourceNote matches trailing attributions such as "（来自维基百科）" that
// several summaries carry. Only stripped at the very end of the text so a
// mid-sentence parenthetical survives.
var sourceNote = regexp.MustCompile(`[（(](?:来自|摘自|转自|引自)[^）)]*[）)]\s*$`)

// minSummaryRunes rejects placeholder summaries — "待补充", a bare title, a
// single clause. 40 runes is comfortably below any real synopsis (the prod
// sample's shortest usable Chinese summary was 61) and above every
// placeholder observed.
const minSummaryRunes = 40

// maxKanaRatio is the share of kana among all CJK characters above which the
// text is treated as Japanese.
//
// The prod sample splits into two clean modes with almost nothing between
// them: 86 subjects sit at a kana ratio of 0.0–0.1 (Chinese prose, the kana
// coming only from quoted Japanese proper nouns) and 50 sit at 0.5–0.8
// (Japanese prose, where kana necessarily outnumber kanji). 0.35 lands in
// the empty gap.
//
// An earlier 0.12 threshold was wrong: it rejected genuine Chinese summaries
// that quote a Japanese title, e.g. bgm subject 37459, whose Chinese synopsis
// cites "バトルスキッパー" and "美少女遊撃隊エクスターズ" and thereby reaches
// a 14.7% kana ratio while being entirely Chinese prose.
const maxKanaRatio = 0.35

// CleanSummary normalises a Bangumi summary and reports whether the result is
// usable as a Chinese description.
//
// A false return means "leave the existing value alone and keep falling back
// to the English description" — never store the rejected text. Callers must
// not treat the returned string as meaningful when ok is false.
func CleanSummary(raw string) (cleaned string, ok bool) {
	s := summaryDivider.ReplaceAllString(raw, "")
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.ReplaceAll(s, "\r", "\n")
	s = sourceNote.ReplaceAllString(s, "")
	s = strings.TrimSpace(s)

	if s == "" {
		return "", false
	}
	if len([]rune(s)) < minSummaryRunes {
		return "", false
	}
	if isJapanese(s) {
		return "", false
	}
	return s, true
}

// isJapanese reports whether the CJK content of s is predominantly kana.
//
// Text with no CJK characters at all (a stray URL, a romaji-only blurb) is
// not Japanese by this measure, but it is not usable Chinese either; the
// caller's length check is what rejects those in practice, and a genuinely
// Latin-only summary would fail the reader either way.
func isJapanese(s string) bool {
	var kana, han int
	for _, r := range s {
		switch {
		case unicode.In(r, unicode.Hiragana, unicode.Katakana):
			kana++
		case unicode.Is(unicode.Han, r):
			han++
		}
	}
	total := kana + han
	if total == 0 {
		return false
	}
	return float64(kana)/float64(total) > maxKanaRatio
}
