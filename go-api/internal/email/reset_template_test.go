package email

// reset_template_test.go — render checks for BuildResetEmailHTML.
// Verifies URL appears in both interpolation spots, the Chinese
// literals survive, and html.EscapeString defends against XSS via a
// hostile URL.

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestBuildResetEmailHTML_ContainsResetURL_InTwoSpots(t *testing.T) {
	t.Parallel()

	const sentinel = "https://anime.example.com/reset-password/UNIQUE-TOKEN-123"
	out := BuildResetEmailHTML(sentinel)
	count := strings.Count(out, sentinel)
	assert.Equal(t, 2, count, "resetURL must appear exactly twice (anchor href + fallback paragraph), got %d", count)
}

func TestBuildResetEmailHTML_ContainsLiteralChineseStrings(t *testing.T) {
	t.Parallel()

	out := BuildResetEmailHTML("https://example.com/reset/abc")
	for _, want := range []string{
		"重置你的密码",
		"1 小时",
		"如果按钮无法点击，请复制",
		"如果你没有请求重置密码",
		"AnimeGo",
	} {
		assert.Contains(t, out, want, "expected literal Chinese / brand string missing")
	}
}

func TestBuildResetEmailHTML_HTMLEscapesURL(t *testing.T) {
	t.Parallel()

	// Defense in depth: even though the token is hex on the auth side,
	// the template must escape so a future change can't accidentally
	// open an XSS sink in HTML-rendering mail clients.
	hostile := "https://example.com/<script>alert(1)</script>"
	out := BuildResetEmailHTML(hostile)

	assert.NotContains(t, out, "<script>alert(1)</script>", "raw <script> must not appear in output")
	assert.Contains(t, out, "&lt;script&gt;", "angle brackets must be HTML-escaped")
}

func TestBuildResetEmailHTML_AmpersandsInURL_Escaped(t *testing.T) {
	t.Parallel()

	withAmp := "https://example.com/?a=1&b=2"
	out := BuildResetEmailHTML(withAmp)

	assert.Contains(t, out, "a=1&amp;b=2", "ampersand must be HTML-escaped")
	assert.NotContains(t, out, "a=1&b=2", "raw & must not leak through")
}

func TestBuildResetEmailHTML_EmptyURL_StillReturns(t *testing.T) {
	t.Parallel()

	out := BuildResetEmailHTML("")
	assert.NotEmpty(t, out, "empty URL must still produce the template skeleton")
	// Even with no URL, the static body should render.
	assert.Contains(t, out, "重置你的密码")
	// And the href should be empty (degraded but not panicking).
	assert.Contains(t, out, `<a href=""`)
}
