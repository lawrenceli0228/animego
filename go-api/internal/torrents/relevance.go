// Package torrents — relevance.go
//
// Drops keyword-search hits that belong to a different show.
//
// The upstream keyword searches are loose.  dmhy in particular matches any
// release sharing a token with the query, so searching Re:Zero's native
// title "Re:ゼロから始める異世界生活 4th season" brought back every
// "4th Season" on the tracker: of 317 rows the panel showed for that
// show, 189 were other series (一念永恒 第4季, 转生史莱姆 第四季,
// Boku no Hero Academia 4th Season, 文豪野犬 第四季, ...).
//
// The check: reduce each of the anime's titles to its "core" name — the
// title with season, part and arc markers removed, since those are exactly
// the tokens a wrong show shares — and keep a hit only when some core is
// mostly present in the hit's title.  Latin text is compared word by word
// (so "re" never matches inside "hero" or "release"); CJK text by
// adjacent-character bigrams (so 葬送的芙莉莲 and 葬送的芙莉蓮 still share
// most of their pairs, and word boundaries, which CJK titles lack, are not
// needed).  A title mixing both scripts counts both kinds of unit.
//
// Only keyword hits are checked.  Rows from the id-keyed feeds (Mikan's
// per-bangumi feed, AnimeTosho's AniDB feed) are this show by
// construction and are never filtered, whatever their titles say.
package torrents

import (
	"regexp"
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

// relevanceThresholdPct is the share, in percent, of a core's units (Latin
// words plus CJK bigrams) a hit's title must contain.  Sixty percent
// tolerates the usual fansub abbreviation of one or two words of a long
// romaji title while staying far above the one or two incidental units
// (异世界, "zero") an unrelated show shares.  On the two live fixtures
// every true release scored 100% and no stray scored above 30%.  Compared
// in integers so a core of exactly 5 units needs exactly 3.
const relevanceThresholdPct = 60

// coreStripPatterns remove season, part and arc markers from a folded
// (NFKC, lower-cased) title.  These tokens are never part of the core: a
// "4th Season" or 第四季 says nothing about which show a release is, and
// counting it would let every other fourth season through.
var coreStripPatterns = []*regexp.Regexp{
	// 第四季 / 第2期 / 第3部分 / 第2クール / 第4シリーズ
	regexp.MustCompile(`第\s*[0-9一二三四五六七八九十百]+\s*(?:季|期|部分|部|クール|シリーズ|章)`),
	// 4th season / 2nd cour / 3rd part
	regexp.MustCompile(`\b[0-9]+(?:st|nd|rd|th)\s*(?:season|cour|part)\b`),
	// season 4 / part 2 / cour 2 / final season
	regexp.MustCompile(`\b(?:season|part|cour)\s*(?:[0-9]+|viii|vii|vi|iv|v|iii|ii|i|ix|x)\b`),
	regexp.MustCompile(`\bfinal\s+season\b`),
	// シーズン2
	regexp.MustCompile(`シーズン\s*[0-9]+`),
	// S2 / s04
	regexp.MustCompile(`\bs[0-9]{1,2}\b`),
	// An arc name after the show name: "第四季 丧失篇", "刀鍛冶の里編".
	regexp.MustCompile(`\s\S{1,12}[篇編编]\s*$`),
}

// trailingOrdinalPatterns remove a bare season number at the end of a
// title once the explicit markers are gone: "Re：從零開始的異世界生活 4",
// "Mushoku Tensei II", "無職転生ii" (NFKC folds Ⅱ to "ii").  Only one or
// two digits, so a title such as "Mob Psycho 100" keeps its number.
var trailingOrdinalPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?:^|\s)(?:[0-9]{1,2}|ii|iii|iv|vi|vii|viii|ix)\s*$`),
	regexp.MustCompile(`([\p{Han}\p{Hiragana}\p{Katakana}])(?:ii|iii|iv|vi|vii|viii|ix)\s*$`),
}

// titleCore is one title reduced to the units a hit is checked against.
type titleCore struct {
	words   []string // distinct Latin/digit words
	bigrams []string // distinct CJK bigrams (or a lone CJK character)
}

func (c titleCore) size() int { return len(c.words) + len(c.bigrams) }

// relevanceMatcher holds the cores of one anime's titles.
type relevanceMatcher struct {
	cores []titleCore
}

// newRelevanceMatcher builds the cores for titles.  Blank titles, and
// titles that are nothing but markers, contribute no core.
func newRelevanceMatcher(titles []string) relevanceMatcher {
	cores := make([]titleCore, 0, len(titles))
	for _, t := range titles {
		if c := coreOf(t); c.size() > 0 {
			cores = append(cores, c)
		}
	}
	return relevanceMatcher{cores: cores}
}

// active reports whether the matcher has anything to check against.  An
// anime with no usable title is not filtered at all: dropping every hit
// would be worse than showing a few strays.
func (m relevanceMatcher) active() bool { return len(m.cores) > 0 }

// matches reports whether title carries enough of any one core.
func (m relevanceMatcher) matches(title string) bool {
	h := unitsOf(foldTitle(title))
	words := make(map[string]struct{}, len(h.words))
	for _, w := range h.words {
		words[w] = struct{}{}
	}
	cjk := strings.Join(h.segments, "\x00")

	for _, c := range m.cores {
		hit := 0
		for _, w := range c.words {
			if _, ok := words[w]; ok {
				hit++
			}
		}
		for _, b := range c.bigrams {
			if strings.Contains(cjk, b) {
				hit++
			}
		}
		if hit*100 >= relevanceThresholdPct*c.size() {
			return true
		}
	}
	return false
}

// filterRelevant returns the items whose titles match titles' cores, in
// their original order.  With no usable title it returns items unchanged.
// The input slice is not modified.
func filterRelevant(items []TorrentItem, titles []string) []TorrentItem {
	return newRelevanceMatcher(titles).filter(items)
}

// filter is filterRelevant for an already-built matcher, so a request
// checking several variants' hits builds the cores once.
func (m relevanceMatcher) filter(items []TorrentItem) []TorrentItem {
	if !m.active() || len(items) == 0 {
		return items
	}
	out := make([]TorrentItem, 0, len(items))
	for _, it := range items {
		if m.matches(it.Title) {
			out = append(out, it)
		}
	}
	return out
}

// foldTitle applies NFKC (full-width letters and digits to ASCII, Ⅱ to
// "II", half-width katakana to full-width) and lower-cases.  Apostrophes
// are dropped rather than treated as separators so "Journey's" and
// "Journeys" fold to the same word.
func foldTitle(s string) string {
	s = strings.ToLower(norm.NFKC.String(s))
	return strings.NewReplacer("'", "", "’", "", "‘", "", "`", "").Replace(s)
}

// coreOf folds title, strips its markers and splits the rest into units.
func coreOf(title string) titleCore {
	s := foldTitle(title)
	for _, re := range coreStripPatterns {
		s = re.ReplaceAllString(s, " ")
	}
	s = strings.TrimSpace(s)
	s = trailingOrdinalPatterns[0].ReplaceAllString(s, "")
	s = trailingOrdinalPatterns[1].ReplaceAllString(s, "$1")

	u := unitsOf(s)
	return titleCore{words: dedupe(u.words), bigrams: dedupe(cjkBigrams(u.segments))}
}

// titleUnits is a folded string split by script: Latin/digit words and
// runs of CJK characters.  Everything else (spaces, punctuation, symbols)
// separates.
type titleUnits struct {
	words    []string
	segments []string
}

func unitsOf(folded string) titleUnits {
	var (
		out        titleUnits
		word, cjkB strings.Builder
	)
	flush := func() {
		if word.Len() > 0 {
			out.words = append(out.words, word.String())
			word.Reset()
		}
		if cjkB.Len() > 0 {
			out.segments = append(out.segments, cjkB.String())
			cjkB.Reset()
		}
	}
	for _, r := range folded {
		switch {
		case isCJK(r):
			if word.Len() > 0 {
				flush()
			}
			cjkB.WriteRune(r)
		case r < unicode.MaxASCII && (unicode.IsLetter(r) || unicode.IsDigit(r)):
			if cjkB.Len() > 0 {
				flush()
			}
			word.WriteRune(r)
		default:
			flush()
		}
	}
	flush()
	return out
}

// isCJK reports whether r is a Han, kana or the prolonged-sound/iteration
// mark that sits inside Japanese words.
func isCJK(r rune) bool {
	return unicode.In(r, unicode.Han, unicode.Hiragana, unicode.Katakana) || r == 'ー' || r == '々'
}

// cjkBigrams returns the adjacent-character pairs of each segment.  A
// one-character segment is kept whole so a single-character name still
// has a unit to match.
func cjkBigrams(segments []string) []string {
	out := make([]string, 0, len(segments)*4)
	for _, seg := range segments {
		rs := []rune(seg)
		if len(rs) == 1 {
			out = append(out, seg)
			continue
		}
		for i := 0; i+1 < len(rs); i++ {
			out = append(out, string(rs[i:i+2]))
		}
	}
	return out
}

// dedupe returns ss without repeats, first occurrence kept.
func dedupe(ss []string) []string {
	seen := make(map[string]struct{}, len(ss))
	out := make([]string, 0, len(ss))
	for _, s := range ss {
		if _, ok := seen[s]; ok {
			continue
		}
		seen[s] = struct{}{}
		out = append(out, s)
	}
	return out
}
