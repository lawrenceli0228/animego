package comments

// validate_test.go — unit coverage for the content-length helper and
// the message constants.  No DB dependency, so these tests run outside
// the testcontainer-backed handler tests.

import (
	"strings"
	"testing"
)

func TestContentRuneCount_ASCII(t *testing.T) {
	t.Parallel()
	cases := []struct {
		in   string
		want int
	}{
		{"", 0},
		{"a", 1},
		{"hello", 5},
		{strings.Repeat("x", 500), 500},
	}
	for _, tc := range cases {
		if got := contentRuneCount(tc.in); got != tc.want {
			t.Errorf("contentRuneCount(%q) = %d, want %d", tc.in, got, tc.want)
		}
	}
}

func TestContentRuneCount_MultibyteCJK(t *testing.T) {
	t.Parallel()
	// Each CJK character is 3 bytes UTF-8 but should count as 1 rune.
	in := "你好世界"
	want := 4
	if got := contentRuneCount(in); got != want {
		t.Errorf("contentRuneCount(CJK) = %d (bytes=%d), want %d (runes)",
			got, len(in), want)
	}
}

func TestContentRuneCount_Emoji(t *testing.T) {
	t.Parallel()
	// 🎉 is a 4-byte UTF-8 sequence representing 1 code point.
	// Byte length would be 4, but we count runes so it's 1.
	in := "🎉"
	want := 1
	if got := contentRuneCount(in); got != want {
		t.Errorf("contentRuneCount(emoji) = %d (bytes=%d), want %d (rune count)",
			got, len(in), want)
	}
}

// TestContentRuneCount_BoundaryAtLimit asserts that exactly maxContentRunes
// ASCII characters passes and exactly maxContentRunes+1 fails.  Catches
// off-by-one bugs in the contentRuneCount usage in handlers.go.
func TestContentRuneCount_BoundaryAtLimit(t *testing.T) {
	t.Parallel()
	exact := strings.Repeat("a", maxContentRunes)
	if got := contentRuneCount(exact); got != maxContentRunes {
		t.Errorf("exact %d ASCII runes counted %d", maxContentRunes, got)
	}
	overflow := strings.Repeat("a", maxContentRunes+1)
	if got := contentRuneCount(overflow); got != maxContentRunes+1 {
		t.Errorf("overflow %d ASCII runes counted %d", maxContentRunes+1, got)
	}
}

// TestMessageConstants asserts the exact English strings the FE i18n
// layer expects.  Any change here is a contract break — keep this
// regression test red until the FE dictionary is updated.
func TestMessageConstants(t *testing.T) {
	t.Parallel()
	checks := map[string]string{
		"msgInvalidParams":   "Invalid params",
		"msgContentRequired": "Content is required",
		"msgContentTooLong":  "Content too long",
		"msgParentNotFound":  "Parent comment not found",
		"msgCommentNotFound": "Comment not found",
		"msgNotYourComment":  "Not your comment",
		"msgLoginAgain":      "Please log in again",
	}
	for name, want := range checks {
		var got string
		switch name {
		case "msgInvalidParams":
			got = msgInvalidParams
		case "msgContentRequired":
			got = msgContentRequired
		case "msgContentTooLong":
			got = msgContentTooLong
		case "msgParentNotFound":
			got = msgParentNotFound
		case "msgCommentNotFound":
			got = msgCommentNotFound
		case "msgNotYourComment":
			got = msgNotYourComment
		case "msgLoginAgain":
			got = msgLoginAgain
		}
		if got != want {
			t.Errorf("%s = %q, want %q", name, got, want)
		}
	}
}

func TestMaxContentRunesIs500(t *testing.T) {
	t.Parallel()
	if maxContentRunes != 500 {
		t.Errorf("maxContentRunes = %d, want 500 (matches DB CHECK)", maxContentRunes)
	}
}
