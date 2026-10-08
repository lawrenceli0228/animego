// Package bgmnames gives the people and characters AniList credits on a
// title their simplified Chinese names, from the Bangumi Archive dump
// (https://github.com/bangumi/Archive), and stores which Bangumi person or
// character each AniList id is.
//
// # Why the dump and why a match at all
//
// AniList has no Chinese names.  Bangumi has them for voice actors, staff
// and characters, in each record's wiki infobox (简体中文名), and publishes
// its whole wiki every week as a dump.  What links the two sites is a
// title: anime_cache.bgm_id says which Bangumi subject an AniList title
// is, and inside one title both sides list the same cast.  So a person is
// matched by name inside a title he is credited on -- never by name across
// the whole of Bangumi, where 田中敦子 is three different people.
//
// # The rules, which are about precision before coverage
//
// No name beats a wrong name, so every rule here refuses rather than
// guesses:
//
//   - Only titles bound to a Bangumi subject are read, and every binding is
//     treated as untrusted.  The name match is the guard: a title bound to
//     the wrong subject meets a cast whose names are not its own, and
//     nothing is matched.
//   - A voice actor is matched when their native name on AniList equals the
//     Japanese name of a person in the subject's cast (person-characters),
//     after Normalize.  Staff who voice nothing are matched the same way
//     against the persons the subject credits (subject-persons).
//   - A character is matched only through its voice actor: once the voice
//     actor is matched (and survives the conflict check below),
//     person-characters names the characters that person voices in the
//     subject, and the character's own native name must equal one of
//     theirs.  Both signals, because each alone is weak: a voice actor
//     voices several characters in one subject, and a character's name
//     recurs across unrelated works.
//   - An AniList id that would map to two Bangumi ids anywhere, or a Bangumi
//     id that two AniList ids would map to, is a conflict: neither pair is
//     written, and the conflict is reported.
//   - The Chinese name is Bangumi's own (ChineseName): never converted
//     between traditional and simplified, never derived from kana.
package bgmnames

import (
	"regexp"
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

// variantKanji folds the registry variants that AniList and Bangumi each
// spell either way for the same person: 﨑 (U+FA11) and 崎, 髙 and 高,
// 𠮷 and 吉.  NFKC folds none of them -- they are distinct characters, not
// compatibility forms -- and TestVariantKanji_OnlyWhatNFKCLeaves keeps the
// table to entries that need it.  It is deliberately short: it is for
// variants of one name, not a map between Japanese and Chinese forms (黒
// is not 黑), which would match different names.
var variantKanji = map[string]string{
	"﨑": "崎",
	"髙": "高",
	"𠮷": "吉",
}

var variantReplacer = func() *strings.Replacer {
	pairs := make([]string, 0, 2*len(variantKanji))
	for variant, standard := range variantKanji {
		pairs = append(pairs, variant, standard)
	}
	return strings.NewReplacer(pairs...)
}()

// Normalize returns the form two names are compared in: NFKC (which also
// turns half-width katakana and full-width Latin into their usual forms),
// the variant kanji folded, every space and middle dot removed, and Latin
// letters lower-cased.  AniList writes 竈門 炭治郎 and ナツキ・スバル where
// Bangumi writes 竈門炭治郎 and ナツキスバル.
func Normalize(name string) string {
	s := variantReplacer.Replace(norm.NFKC.String(name))
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		if unicode.IsSpace(r) || r == '・' || r == '·' {
			continue
		}
		b.WriteRune(unicode.ToLower(r))
	}
	return b.String()
}

// chineseNameField is the infobox field that holds a record's simplified
// Chinese name.
const chineseNameField = "简体中文名"

// ChineseName returns the simplified Chinese name a Bangumi record states:
// its infobox's 简体中文名, else the record's own name_cn, with a trailing
// disambiguation removed (田中敦子（声优） is 田中敦子).  "" when it states
// none.
//
// The value is Bangumi's, character for character.  A traditional
// character in it stays traditional and a kana name stays kana: a machine
// conversion would print a name nobody wrote.
func ChineseName(infobox, nameCn string) string {
	name := infoboxField(infobox, chineseNameField)
	if name == "" {
		name = strings.TrimSpace(nameCn)
	}
	return stripDisambiguation(name)
}

// infoboxField reads one plain field of a Bangumi wiki infobox.  The syntax
// (github.com/bangumi/wiki-syntax-spec) puts each field on its own line as
// `|name= value`, with either \n or \r\n between lines, and a list value
// opening with `{` -- a list is not a name, so it reads as "".  Reading line
// by line is what keeps an empty field empty: a pattern that skips
// whitespace after the `=` would run on into the next line.  The first
// occurrence of the field wins.
func infoboxField(infobox, field string) string {
	for _, line := range strings.Split(infobox, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "|") {
			continue
		}
		name, value, ok := strings.Cut(line[1:], "=")
		if !ok || strings.TrimSpace(name) != field {
			continue
		}
		value = strings.TrimSpace(value)
		if strings.HasPrefix(value, "{") {
			return ""
		}
		return value
	}
	return ""
}

// trailingParenthesis is one parenthesised group, full width or half width,
// at the very end of a name.  The group may not hold a parenthesis of its
// own, so 甲（乙）（丙） loses only （丙）.
var trailingParenthesis = regexp.MustCompile(`\s*[（(][^（）()]*[）)]\s*$`)

// stripDisambiguation removes the trailing parenthesis Bangumi uses to tell
// namesakes apart (田中敦子（声优）, 田中敦子（动画人）) and to give a
// character's alias (池田由纪（小雪）).  A parenthesis anywhere else is part
// of the name.  A value that is nothing but a parenthesis is no name.
func stripDisambiguation(name string) string {
	return strings.TrimSpace(trailingParenthesis.ReplaceAllString(name, ""))
}
