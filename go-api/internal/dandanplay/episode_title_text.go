// Package dandanplay — splitting one dandanplay `episodeTitle` string into
// the two columns anime_episode_titles actually has.
//
// /api/v2/bangumi/bgmtv/:bgmId returns a single field per episode,
// `episodeTitle`, shaped as a Chinese ordinal prefix followed by a body:
//
//	第1话 燃烧吧，狂犬                          body is Chinese
//	第2话 サムライ・ジュニア                     body is Japanese
//	第3话 宇宙は数学という言語で書かれている        body is Japanese
//	第1话 慢郎中跟急惊风 &amp; 大雄的新娘         body is Chinese, and escaped
//	第2话 FIRE                                 body is Latin
//
// The destination has two columns — name_cn and name — and the detail page
// renders them under two different labels, "Chinese title" and "original
// title".  So the one field has to be split before anything is written, and
// that split is the whole job of this file.
//
// Getting it wrong does not fail loudly.  It writes a Japanese string into
// name_cn, and the page then renders Japanese under a label that promises a
// translation, on a route that is public and indexed.  Both columns are
// nullable and the primary key is (anime_id, episode), so there is also
// nothing in the schema that stops a row consisting of two NULLs from being
// inserted; see the empty-body rule below for who has to prevent that.

package dandanplay

import (
	"html"
	"regexp"
	"strings"
	"unicode"
)

// episodeOrdinalPrefixRe matches the leading "第<N>话" / "第<N>話" / "第<N>集"
// ordinal, with ASCII or full-width (U+FF10–U+FF19) digits.  Both digit
// forms appear in the feed, so accepting only ASCII would leave the prefix
// glued to the front of an otherwise good title.
//
// Anchored deliberately.  Bodies contain the very same character sequence —
// "第16话 第十六次星月相交之日" — and an unanchored strip would chew into the
// title itself.  Here the kanji-numeral body happens to survive because the
// digit class holds digits only, but the anchor is what makes that a rule
// rather than a coincidence, and the next body that spells its ordinal with
// ASCII digits mid-string would not be so lucky.
//
// No trailing separator is required.  The body is trimmed after the strip,
// so a row written as "第4话标题" loses its prefix exactly like a spaced one,
// and a row with an ideographic space after the prefix loses that too.
var episodeOrdinalPrefixRe = regexp.MustCompile(`^第[0-9\x{FF10}-\x{FF19}]+[话話集]`)

// NormalizeDandanEpisodeTitle splits one dandanplay episodeTitle into the
// Chinese and original-language columns of anime_episode_titles.  Exactly one
// of the two returns is ever non-empty; both are empty when the title carries
// no storable body at all.
//
// Three steps, and the order of the first two is load-bearing.
//
// 1. Unescape.  Entity-bearing bodies are real, not hypothetical: the live
// feed carries values such as "第1话 慢郎中跟急惊风 &amp; 大雄的新娘".  This
// has to happen before classification, not after, for two separate reasons.
// The column is read back as text and rendered as text, so a stored "&amp;"
// shows up verbatim on the page instead of an ampersand; and a numeric entity
// can decode to kana (&#12354; is あ), which means unescaping after the
// classification step would let an escaped Japanese title be filed as Chinese.
//
// 2. Strip the ordinal prefix.  "第1话" is boilerplate — the site already
// knows the episode number, because it is the key the title is stored under,
// and renders its own ordinal beside the name.  Keeping the prefix in the
// column prints the number twice, and prints dandanplay's numbering rather
// than the site's wherever the two disagree.  A title with no prefix at all
// ("FUTURE ENGINE") is still classified and returned; the prefix is tolerated,
// never required.
//
// 3. Classify what is left.  A body with Han characters and no kana is
// Chinese; everything else non-empty is treated as original-language.  Kana
// is the decisive signal and it is a NEGATIVE one, because Japanese episode
// titles routinely contain Han characters too — 宇宙は数学という言語で書かれている
// is more than half Han — so a "has Han" test on its own would file most of
// the Japanese catalogue into the Chinese column.  Everything with no Han at
// all (Latin, kana-only, punctuation) falls to name for the same reason: the
// one thing name_cn must never receive is text that is not Chinese.
//
// An empty body returns ("", ""), which the caller uses to skip the row
// entirely.  A title that is nothing but its prefix ("第10话") carries no
// name in either language, and persisting it would put a row with two NULL
// name columns in front of the page for no gain.
func NormalizeDandanEpisodeTitle(raw string) (nameCn, name string) {
	body := html.UnescapeString(raw)
	body = strings.TrimSpace(body)
	body = episodeOrdinalPrefixRe.ReplaceAllString(body, "")
	body = strings.TrimSpace(body)

	if body == "" {
		return "", ""
	}
	if hasHan(body) && !hasKana(body) {
		return body, ""
	}
	return "", body
}

// hasHan reports whether s contains any Han character.
//
// unicode.Han spans every CJK block including the extensions, so this needs
// no hand-maintained range list and cannot drift out of date as new blocks
// are assigned.
func hasHan(s string) bool {
	for _, r := range s {
		if unicode.Is(unicode.Han, r) {
			return true
		}
	}
	return false
}

// hasKana reports whether s contains hiragana or katakana.
//
// The Unicode script tables are used rather than a literal U+3040–U+30FF
// range because the two disagree at both ends and the tables are right in the
// case that matters here.  U+30FB (・) and U+30FC (ー) sit inside that range
// but carry script=Common, so a range test would call a Chinese title that
// merely uses ・ as a separator Japanese; halfwidth katakana (U+FF66–U+FF9D)
// sit outside the range but are script=Katakana, so a range test would miss
// genuinely Japanese text written in the halfwidth forms.  Both errors push a
// title into the wrong column, and the script tables make neither.
func hasKana(s string) bool {
	for _, r := range s {
		if unicode.In(r, unicode.Hiragana, unicode.Katakana) {
			return true
		}
	}
	return false
}
