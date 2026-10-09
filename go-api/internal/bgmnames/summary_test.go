package bgmnames

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// TestCleanSummary — a Bangumi summary rewritten into the markup the
// character page renders for AniList's descriptions: [mask] spoilers as
// ~!...!~, a link as its text, the formatting tags dropped, an image
// dropped whole, \n line breaks, and the text itself kept as it is,
// brackets that are not BBCode included.
func TestCleanSummary(t *testing.T) {
	for name, tc := range map[string]struct{ in, want string }{
		"plain text is kept": {
			"フリーレンとフェルンと共に旅をすることになる戦士で、アイゼンの弟子。",
			"フリーレンとフェルンと共に旅をすることになる戦士で、アイゼンの弟子。",
		},
		"CRLF and CR become LF": {
			"第一行\r\n第二行\r第三行",
			"第一行\n第二行\n第三行",
		},
		"a spoiler, across lines": {
			"秀树的老师。[mask]虽已婚但被抛弃，\r\n最后与新保弘结婚。[/mask]",
			"秀树的老师。~!虽已婚但被抛弃，\n最后与新保弘结婚。!~",
		},
		"an unclosed spoiler runs to the end, as AniList's do": {
			"开头[mask]结局是",
			"开头~!结局是",
		},
		"tags in any case": {
			"[MASK]x[/Mask] [B]y[/B]",
			"~!x!~ y",
		},
		"a link keeps its text": {
			"由[url=https://bangumi.tv/person/13098]STUDIO COMET[/url]制作",
			"由STUDIO COMET制作",
		},
		"a bare link keeps the address": {
			"官网 [url]https://example.org/a[/url]",
			"官网 https://example.org/a",
		},
		"formatting tags are dropped, their text kept": {
			"[center][b][color=#CAEAF6][size=18]爱好和平的魔王[/size][/color][/b][/center]\n[i]台词[/i][s]删去[/s][u]下划线[/u][quote]引用[/quote]",
			"爱好和平的魔王\n台词删去下划线引用",
		},
		"an image goes, address and all": {
			"头像[img]https://lain.bgm.tv/pic/a.jpg[/img]之后",
			"头像之后",
		},
		"brackets that are not BBCode stay": {
			"[JACK]登场。[CV]福原香織 [得意科目]日本史 [He]这个人",
			"[JACK]登场。[CV]福原香織 [得意科目]日本史 [He]这个人",
		},
		"blank runs fold to one empty line, edges trimmed": {
			"\n\n  第一段\n\n\n\n第二段  \n\n",
			"第一段\n\n第二段",
		},
		"trailing spaces on a line go": {
			"第一行   \n第二行",
			"第一行\n第二行",
		},
		"nothing left is nothing": {
			" \r\n [b][/b] ",
			"",
		},
	} {
		t.Run(name, func(t *testing.T) {
			assert.Equal(t, tc.want, CleanSummary(tc.in))
		})
	}
}
