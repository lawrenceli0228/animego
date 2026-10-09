package community

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestNormalizeBody(t *testing.T) {
	cases := []struct {
		name, in, want string
	}{
		{"CRLF and CR become LF", "a\r\nb\rc", "a\nb\nc"},
		{"ends trimmed, inside kept", "  第一段\n\n第二段  ", "第一段\n\n第二段"},
		{"NUL and other controls dropped", "a\x00b\x07c\u0085d", "abcd"},
		{"tab kept", "a\tb", "a\tb"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, tc.want, normalizeBody(tc.in))
		})
	}
}

func TestNormalizeLine_CollapsesEveryWhitespaceRun(t *testing.T) {
	assert.Equal(t, "一句 话总结", normalizeLine("  一句\n\n 话总结\t "))
	assert.Equal(t, "full width space", normalizeLine("full width\u3000space"),
		"an ideographic space is whitespace like any other")
}

func TestVisibleLength(t *testing.T) {
	cases := []struct {
		in   string
		want int
	}{
		{"", 0},
		{"好", 1},
		{"好" + strings.Repeat(" ", 400) + "好", 3},
		{"  first para\n\nsecond  ", len("first para second")},
		{"一\u200b二\ufeff三", 3},
		{"\u200b\u200b", 0},
		{"a b", 3},
	}
	for _, tc := range cases {
		assert.Equal(t, tc.want, visibleLength(tc.in), "%q", tc.in)
	}
}

func TestIsBlank(t *testing.T) {
	for _, s := range []string{"", "   ", "\n\t", "\u200b\u200b", " \u2060 \ufeff ", "\u3000"} {
		assert.True(t, isBlank(s), "%q", s)
	}
	for _, s := range []string{"a", " 字 ", "\u200b字"} {
		assert.False(t, isBlank(s), "%q", s)
	}
}

func TestValidateReview(t *testing.T) {
	ok := strings.Repeat("好", reviewBodyMin)
	cases := []struct {
		name, summary, body, want string
	}{
		{"valid at both minimums", strings.Repeat("一", 10), ok, ""},
		{"valid at the summary maximum", strings.Repeat("一", 60), ok, ""},
		{"summary one short", strings.Repeat("一", 9), ok, msgSummaryLength},
		{"summary one long", strings.Repeat("一", 61), ok, msgSummaryLength},
		{"summary only whitespace", strings.Repeat(" ", 20), ok, msgSummaryLength},
		{"summary only zero-width spaces", strings.Repeat("\u200b", 20), ok, msgSummaryLength},
		{"summary padded to length with zero-width spaces", "短" + strings.Repeat("\u200b", 20), ok, msgSummaryLength},
		{"summary padded to length with spaces", "  短  " + strings.Repeat(" ", 20), ok, msgSummaryLength},
		{"body one short", strings.Repeat("一", 10), strings.Repeat("好", reviewBodyMin-1), msgReviewTooShort},
		{"body padded with whitespace to length", strings.Repeat("一", 10), "好" + strings.Repeat(" ", 400) + "好", msgReviewTooShort},
		{"body only whitespace", strings.Repeat("一", 10), strings.Repeat("\n", 400), msgReviewTooShort},
		{"body over the maximum", strings.Repeat("一", 10), strings.Repeat("好", reviewBodyMax+1), msgReviewTooLong},
		{"body at the maximum", strings.Repeat("一", 10), strings.Repeat("好", reviewBodyMax), ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, msg := validateReview(tc.summary, tc.body, false, false)
			assert.Equal(t, tc.want, msg)
		})
	}
}

func TestValidateReview_CountsCharactersNotBytes(t *testing.T) {
	// 300 CJK characters are 900 bytes; 299 emoji are 1196.  Characters
	// are what the limit is, and what Postgres's char_length counts.
	_, msg := validateReview(strings.Repeat("一", 10), strings.Repeat("好", 300), false, false)
	assert.Empty(t, msg)
	_, msg = validateReview(strings.Repeat("一", 10), strings.Repeat("😀", 299), false, false)
	assert.Equal(t, msgReviewTooShort, msg)
}

func TestValidateReview_ReturnsNormalizedText(t *testing.T) {
	in, msg := validateReview("  一句话\n总结一下这部番  ", "\r\n"+strings.Repeat("好", 300)+"\r\n", true, true)
	assert.Empty(t, msg)
	assert.Equal(t, "一句话 总结一下这部番", in.Summary)
	assert.Equal(t, strings.Repeat("好", 300), in.Body)
	assert.True(t, in.IsSpoiler)
	assert.True(t, in.IsPrivate)
}

func TestValidateThread(t *testing.T) {
	cases := []struct {
		name, title, body, want string
	}{
		{"valid", "第五集讨论", "说说看", ""},
		{"title at the minimum", "四个字的", "x", ""},
		{"title too short", "三个字", "x", msgTitleLength},
		{"title too long", strings.Repeat("长", 81), "x", msgTitleLength},
		{"title blank", "\u200b\u200b\u200b\u200b\u200b", "x", msgTitleLength},
		{"title padded with spaces", "第 五", "x", msgTitleLength},
		{"body blank", "第五集讨论", " \n ", msgContentRequired},
		{"body too long", "第五集讨论", strings.Repeat("长", threadBodyMax+1), msgContentTooLong},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, _, msg := validateThread(tc.title, tc.body)
			assert.Equal(t, tc.want, msg)
		})
	}
}

func TestValidateReply(t *testing.T) {
	body, msg := validateReply("  我也看完了！ ")
	assert.Empty(t, msg)
	assert.Equal(t, "我也看完了！", body)

	_, msg = validateReply("\u200b \n")
	assert.Equal(t, msgContentRequired, msg)
	_, msg = validateReply(strings.Repeat("字", replyBodyMax))
	assert.Empty(t, msg)
	_, msg = validateReply(strings.Repeat("字", replyBodyMax+1))
	assert.Equal(t, msgContentTooLong, msg)
}

func TestExcerptOf(t *testing.T) {
	assert.Equal(t, "一行 两行", excerptOf("一行\n\n两行", 10))
	assert.Equal(t, "一二三…", excerptOf("一二三四五", 3))
	assert.Equal(t, "一二三", excerptOf("一二三", 3))
}

func TestPageOffsetAndPageOf(t *testing.T) {
	assert.Equal(t, int32(0), pageOffset(1, 10))
	assert.Equal(t, int32(20), pageOffset(3, 10))
	assert.Equal(t, int32(maxPageOffset), pageOffset(1_000_000_000, 30), "clamped, not wrapped")

	p := pageOf([]int{1, 2}, 12, 1, 10)
	assert.True(t, p.HasMore)
	assert.Equal(t, 2, *p.NextPage)
	p = pageOf([]int(nil), 0, 1, 10)
	assert.NotNil(t, p.Items, "an empty list is [], never null")
	assert.False(t, p.HasMore)
	assert.Nil(t, p.NextPage)
}
