package dandanplay

// normalize_test.go — NormalizeTitle / TitleLooselyMatchesKeyword /
// ParseEpField / ExtractEpisodeNumber.  The 28-char strip table and
// the 6-pattern regex priority must be byte-stable; any drift here
// breaks Phase 1 loose-match accept rates.

import (
	"testing"
)

func TestNormalizeTitle_StripsBracketsAndPunct(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		// JS regex chars: \s\[\]【】()《》「」『』,.\-_~!@#$%^&*+=|\\/:;?'"
		{"[Group] Title [01]", "grouptitle01"},
		{"【字幕组】标题【01】", "字幕组标题01"},
		{"Title (2024)", "title2024"},
		{"《标题》第1集", "标题第1集"},
		// Note: ～ here is the FULL-WIDTH tilde U+FF5E, NOT ASCII ~ (U+007E).
		// Express's strip regex `~` only matches the ASCII byte; the full-
		// width form passes through both implementations.  This case
		// locks that parity so a future "let's add U+FF5E to the table"
		// change has to update both sides at once.
		{"「Title」～EP01～", "title～ep01～"},
		{"『Title』 - 01v2", "title01v2"},
		// Whitespace / tab / newline.
		{"Title\t with\nspaces", "titlewithspaces"},
		// Mixed.
		{"Kaguya-sama: Love is War", "kaguyasamaloveiswar"},
		// Empty.
		{"", ""},
		// Pure punct.
		{"!@#$%^&*()", ""},
	}
	for _, c := range cases {
		got := NormalizeTitle(c.in)
		if got != c.want {
			t.Errorf("NormalizeTitle(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestTitleLooselyMatchesKeyword(t *testing.T) {
	cases := []struct {
		title, keyword string
		want           bool
	}{
		{"Kaguya-sama: Love is War", "kaguya sama", true},          // keyword normalised → "kaguyasama" ⊂ title normalised
		{"Title", "Title", true},                                  // exact
		{"Kaguya-sama Wa", "kaguya-sama wa kokurasetai", true},   // title is substring of keyword
		{"Completely Different", "Some Other Anime", false},      // no overlap
		{"", "keyword", false},                                    // empty title
		{"title", "", false},                                      // empty keyword
		// Bracketed group prefix should be stripped by normalize.
		{"[Erai-raws] Title [01]", "title", true},
	}
	for _, c := range cases {
		got := TitleLooselyMatchesKeyword(c.title, c.keyword)
		if got != c.want {
			t.Errorf("TitleLooselyMatchesKeyword(%q, %q) = %v, want %v",
				c.title, c.keyword, got, c.want)
		}
	}
}

func TestParseEpField(t *testing.T) {
	cases := []struct {
		in       string
		wantN    int
		wantOK   bool
	}{
		{"1", 1, true},
		{"01", 1, true},
		{"123", 123, true},
		{"", 0, false},
		{"C1", 0, false},
		{"O2", 0, false},
		{"SP1", 0, false},
		{"1a", 0, false},
		{" 1 ", 0, false}, // whitespace not allowed
	}
	for _, c := range cases {
		n, ok := ParseEpField(c.in)
		if n != c.wantN || ok != c.wantOK {
			t.Errorf("ParseEpField(%q) = (%d, %v), want (%d, %v)",
				c.in, n, ok, c.wantN, c.wantOK)
		}
	}
}

func TestExtractEpisodeNumber(t *testing.T) {
	cases := []struct {
		title  string
		wantN  int
		wantOK bool
	}{
		// Pattern 1: kanji 第N
		{"第1話", 1, true},
		{"第02话 タイトル", 2, true},
		{"第13集 something", 13, true},
		// Pattern 2: EP/E
		{"EP01", 1, true},
		{"E13", 13, true},
		{"Ep 02", 2, true},
		// Pattern 3: S01E03
		{"S01E03", 3, true},
		{"s2e10 something", 10, true},
		// Pattern 4: Episode / Ep.
		{"Episode 7", 7, true},
		{"Ep.5 title", 5, true},
		// Pattern 5: bare
		{"1", 1, true},
		{"42", 42, true},
		// Pattern 6: trailing
		{"Random Title 99", 99, true},
		// Misses.
		{"", 0, false},
		{"no numbers here", 0, false},
	}
	for _, c := range cases {
		n, ok := ExtractEpisodeNumber(c.title)
		if n != c.wantN || ok != c.wantOK {
			t.Errorf("ExtractEpisodeNumber(%q) = (%d, %v), want (%d, %v)",
				c.title, n, ok, c.wantN, c.wantOK)
		}
	}
}

func TestExtractEpisodeNumber_PriorityOrder(t *testing.T) {
	// Pattern priority: kanji > EP > S?E? > Episode > bare > trailing.
	// A string with multiple potential matches must hit the highest-
	// priority pattern first.
	// "第1話 Episode 99 EP05" — kanji "第1話" wins → 1.
	n, ok := ExtractEpisodeNumber("第1話 Episode 99 EP05")
	if !ok || n != 1 {
		t.Errorf("priority: kanji should win, got (%d, %v)", n, ok)
	}

	// "Episode 99 trailing 42" — pattern 4 (Episode) wins → 99.
	n, ok = ExtractEpisodeNumber("Episode 99 trailing 42")
	if !ok || n != 99 {
		t.Errorf("priority: Episode > trailing, got (%d, %v)", n, ok)
	}
}
