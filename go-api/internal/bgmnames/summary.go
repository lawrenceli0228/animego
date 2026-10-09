package bgmnames

import (
	"regexp"
	"strings"
)

// A Bangumi summary is plain text with a little BBCode from Bangumi's editor
// in about one record in a hundred: mostly [mask] spoilers, then links,
// emphasis, sizes and colours.  The character page renders AniList's
// description markup (next-app lib/people/anilistMarkdown.ts), so the import
// rewrites a summary into that: one markup for every description the page
// shows, whether AniList's, Bangumi's or an accepted reader edit (0047),
// and in the edit state's text box.
var (
	// An image goes whole: its address is not text a reader should see.
	summaryImage = regexp.MustCompile(`(?is)\[img(?:=[^\]\n]*)?\].*?\[/img\]`)
	// A spoiler is AniList's ~!...!~.  Each marker on its own, so a [mask]
	// with no [/mask] runs to the end, as an unclosed ~! does there: a
	// spoiler that leaks for want of a closing tag is the failure to avoid.
	summaryMaskOpen  = regexp.MustCompile(`(?i)\[mask\]`)
	summaryMaskClose = regexp.MustCompile(`(?i)\[/mask\]`)
	// The tags whose text stays and whose markup goes.  A link keeps its
	// text ([url=...]text[/url]) or its address ([url]address[/url]), as the
	// page shows AniList's links.  Only these names: a bracket that is not
	// one of Bangumi's tags ([CV], [JACK]) is part of the text.
	summaryFormatting = regexp.MustCompile(`(?i)\[/?(?:b|i|u|s|url|size|color|center|left|right|align|font|quote|code|sup|sub)(?:=[^\]\n]*)?\]`)
	summaryBlankRun   = regexp.MustCompile(`\n{3,}`)
)

// CleanSummary rewrites a Bangumi summary into the character page's
// description markup: \n line breaks, spoilers as ~!...!~, links as their
// text, other formatting dropped, trailing spaces off each line, a run of
// blank lines folded to one, and the whole trimmed.  "" when nothing is
// left.
func CleanSummary(raw string) string {
	s := strings.ReplaceAll(raw, "\r\n", "\n")
	s = strings.ReplaceAll(s, "\r", "\n")
	s = summaryImage.ReplaceAllString(s, "")
	s = summaryMaskOpen.ReplaceAllString(s, "~!")
	s = summaryMaskClose.ReplaceAllString(s, "!~")
	s = summaryFormatting.ReplaceAllString(s, "")
	lines := strings.Split(s, "\n")
	for i, line := range lines {
		lines[i] = strings.TrimRight(line, " \t　")
	}
	s = summaryBlankRun.ReplaceAllString(strings.Join(lines, "\n"), "\n\n")
	return strings.TrimSpace(s)
}
