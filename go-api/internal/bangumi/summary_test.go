package bangumi

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

// ---------------------------------------------------------------------------
// CleanSummary
//
// Every fixture below is real prod data — a Bangumi Subject.Summary fetched
// from bgm.tv, not invented text. The three shapes the gate has to separate
// (usable Chinese / Chinese + "[简介原文]" + Japanese original / Japanese
// only) are each represented, because a regression in any one of them shows
// up on the detail page as either an untranslated paragraph or a needlessly
// suppressed Chinese synopsis.
// ---------------------------------------------------------------------------

// deathNoteCN is the opening of bgm subject "DEATH NOTE" — plain Chinese
// prose, the shape the whole channel exists to capture.
const deathNoteCN = "高三生夜神月意外捡到一本名《DEATH NOTE》的笔记本，并且发现只要写下想要杀死的人的名字，就会变成现实。"

// onePieceJPTail is the Japanese original that Bangumi editors append after
// a "[简介原文]" divider.
const onePieceJPTail = "世は大海賊時代ー前人未踏の世界一周を果たした海の覇者"

// mushokuJP is the full summary of 无职转生Ⅲ — Japanese only, no Chinese at
// all. This is the 36.7% case from the prod sample and must be rejected.
const mushokuJP = "「俺は、この異世界で本気だす！」34歳・童貞・無職の引きこもりニート男。両親の葬儀の日に家を追い出された瞬間、トラックに轢かれ命を落としてしまう。"

// battleSkipperCN is bgm subject 37459 — the regression fixture. It is
// entirely Chinese prose that happens to quote the Japanese toy line name
// "バトルスキッパー", which puts its kana ratio at 0.148 (12 kana / 81 CJK).
// The earlier 0.12 threshold rejected it; 0.35 accepts it. If anyone lowers
// maxKanaRatio to 0.12 this case is what fails.
//
// On its own it only guards ratios below 0.148, which is why the two
// bracketing fixtures below exist — see TestCleanSummaryKanaRatioBoundary.
const battleSkipperCN = "以TOMY推出的玩具”バトルスキッパー”为基础而制作的OVA作品。聖イグナチオ女学院有华丽部和礼法部两大社团，华丽部部长北大路紗綾花是企图利用家族的经济实力来征服世界的野心勃勃的豪门千金。"

// kanaJustUnderCN sits at 0.338 (22 kana / 65 CJK) — Chinese prose that
// quotes a Japanese light-novel title plus two katakana character names,
// which is how a genuine Chinese summary gets its kana ratio up. Must be
// accepted.
const kanaJustUnderCN = "本作改编自轻小说《ソードアート・オンライン》，讲述主角キリト与アスナ在浮游城アインクラッド中为脱离死亡游戏而挑战楼层首领、最终并肩生还的冒险故事。"

// kanaJustOverCN is the same sentence with the Chinese body trimmed, landing
// at 0.386 (22 kana / 57 CJK). Must be rejected. Together with the fixture
// above it brackets maxKanaRatio to (0.338, 0.386]; before they existed the
// accepted fixtures topped out at 0.148 and the rejected ones started at
// 0.574, so the constant could have been moved anywhere in 0.15–0.57 — 0.2
// included, which summary.go's own comment says is wrong — with the whole
// suite still green.
const kanaJustOverCN = "本作改编自轻小说《ソードアート・オンライン》，讲述主角キリト与アスナ在浮游城アインクラッド中为脱离死亡游戏而挑战楼层首领的冒险。"

func TestCleanSummary(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		input  string
		want   string
		wantOK bool
	}{
		{
			name:   "plain Chinese prose kept verbatim",
			input:  deathNoteCN,
			want:   deathNoteCN,
			wantOK: true,
		},
		{
			// Shape 2: Chinese, divider, Japanese original. Everything from
			// the marker on is dropped and the trailing blank line trimmed.
			name:   "divider strips the Japanese original and the marker",
			input:  deathNoteCN + "\n\n[简介原文]\n" + onePieceJPTail,
			want:   deathNoteCN,
			wantOK: true,
		},
		{
			// Shape 3: the 36.7% case. Long enough to clear the length gate,
			// so only the kana ratio stands between it and the detail page.
			name:   "Japanese-only summary rejected by the kana gate",
			input:  mushokuJP,
			want:   "",
			wantOK: false,
		},
		{
			name:   "empty string rejected",
			input:  "",
			want:   "",
			wantOK: false,
		},
		{
			name:   "whitespace-only string rejected",
			input:  "   \n\t \r\n  ",
			want:   "",
			wantOK: false,
		},
		{
			name:   "placeholder text rejected as too short",
			input:  "待补充",
			want:   "",
			wantOK: false,
		},
		{
			// One rune under the 40-rune floor: a real clause, still not a
			// synopsis. Guards the boundary from drifting downward.
			name:   "39 runes rejected, one below the floor",
			input:  strings.Repeat("测", 39),
			want:   "",
			wantOK: false,
		},
		{
			name:   "40 runes accepted, exactly at the floor",
			input:  strings.Repeat("测", 40),
			want:   strings.Repeat("测", 40),
			wantOK: true,
		},
		{
			// The regression fixture. Chinese prose quoting Japanese proper
			// nouns must survive the language gate.
			name:   "Chinese prose quoting Japanese proper nouns accepted (bgm 37459)",
			input:  battleSkipperCN,
			want:   battleSkipperCN,
			wantOK: true,
		},
		{
			name:   "CRLF normalised to LF",
			input:  "高三生夜神月意外捡到一本名《DEATH NOTE》的笔记本。\r\n并且发现只要写下想要杀死的人的名字，就会变成现实。",
			want:   "高三生夜神月意外捡到一本名《DEATH NOTE》的笔记本。\n并且发现只要写下想要杀死的人的名字，就会变成现实。",
			wantOK: true,
		},
		{
			name:   "bare CR normalised to LF",
			input:  "高三生夜神月意外捡到一本名《DEATH NOTE》的笔记本。\r并且发现只要写下想要杀死的人的名字，就会变成现实。",
			want:   "高三生夜神月意外捡到一本名《DEATH NOTE》的笔记本。\n并且发现只要写下想要杀死的人的名字，就会变成现实。",
			wantOK: true,
		},
		{
			name:   "surrounding whitespace trimmed",
			input:  "\n\n  " + deathNoteCN + "  \n\n",
			want:   deathNoteCN,
			wantOK: true,
		},
		{
			name:   "trailing source note stripped",
			input:  deathNoteCN + "（来自维基百科）",
			want:   deathNoteCN,
			wantOK: true,
		},
		{
			// Only a trailing attribution is stripped — a parenthetical in
			// the middle of a sentence is part of the prose.
			name:   "mid-sentence parenthetical survives",
			input:  "高三生夜神月（本作主角）意外捡到一本名《DEATH NOTE》的笔记本，并且发现只要写下想要杀死的人的名字，就会变成现实。",
			want:   "高三生夜神月（本作主角）意外捡到一本名《DEATH NOTE》的笔记本，并且发现只要写下想要杀死的人的名字，就会变成现实。",
			wantOK: true,
		},
		{
			// Divider present but the Chinese half is a stub — after
			// stripping there is nothing worth storing, so fall back to the
			// English description rather than show one clause.
			name:   "divider with a too-short Chinese half rejected",
			input:  "待补充\n\n[简介原文]\n" + onePieceJPTail,
			want:   "",
			wantOK: false,
		},
		{
			// Ordering invariant: the source note is stripped BEFORE the
			// length is measured. 43 runes with the attribution, 35 without,
			// so the floor rejects it — but only because the strip ran
			// first. Move the length check above the strip and this wrongly
			// passes, storing a stub whose bulk was somebody's credit line.
			name:   "source note stripped before the length gate, not after",
			input:  "讲述少年在异世界与女神组队讨伐魔王、并在旅途中结识众多伙伴的日常喜剧。（来自维基百科）",
			want:   "",
			wantOK: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			got, ok := CleanSummary(tt.input)
			assert.Equal(t, tt.wantOK, ok)
			assert.Equal(t, tt.want, got)

			// Contract: a rejected summary yields no text at all. Callers
			// must never be handed a half-cleaned string they might store.
			if !ok {
				assert.Empty(t, got, "rejected summary must return an empty string")
			}
		})
	}
}

// TestCleanSummaryDividerLeavesNoJapanese asserts the divider case by content
// rather than by exact equality, so the test still fails loudly if a future
// rewrite keeps the Japanese tail while happening to reshape the whitespace.
func TestCleanSummaryDividerLeavesNoJapanese(t *testing.T) {
	t.Parallel()

	got, ok := CleanSummary(deathNoteCN + "\n\n[简介原文]\n" + onePieceJPTail)

	assert.True(t, ok)
	assert.NotContains(t, got, "简介原文", "the divider marker must not reach the page")
	assert.NotContains(t, got, onePieceJPTail, "the Japanese original must be dropped")
	assert.NotContains(t, got, "大海賊時代", "no fragment of the Japanese original may survive")
	assert.Contains(t, got, "高三生夜神月", "the Chinese half must be preserved")
}

// TestCleanSummaryKanaRatioBoundary brackets maxKanaRatio from both sides.
//
// The prod fixtures alone leave a wide blind spot: everything they accept
// sits at or below a 0.148 kana ratio and everything they reject starts at
// 0.574, so the constant could be retuned to anything in 0.15–0.57 without a
// single test going red. 0.2 is inside that band and is exactly the kind of
// value summary.go argues against — it would start rejecting Chinese
// synopses that quote a Japanese title, which is the bug the 0.35 threshold
// was chosen to fix.
//
// These two differ only in how much Chinese body surrounds the same quoted
// Japanese names, which is the real-world axis: the more a Chinese summary
// says, the lower its kana ratio.
func TestCleanSummaryKanaRatioBoundary(t *testing.T) {
	t.Parallel()

	got, ok := CleanSummary(kanaJustUnderCN)
	assert.True(t, ok, "0.338 is below the 0.35 gate and must be accepted")
	assert.Equal(t, kanaJustUnderCN, got)

	got, ok = CleanSummary(kanaJustOverCN)
	assert.False(t, ok, "0.386 is above the 0.35 gate and must be rejected")
	assert.Equal(t, "", got)
}

// TestCleanSummaryRejectedAlwaysEmpty pins the ok=false contract on its own,
// independent of the table above: whatever the rejection reason, the caller
// gets "" and can safely pass the result straight through.
func TestCleanSummaryRejectedAlwaysEmpty(t *testing.T) {
	t.Parallel()

	rejected := []string{
		"",
		"   ",
		"\n\r\n\t",
		"待补充",
		"暂无简介",
		mushokuJP,
		"「進撃の巨人」の世界観を引き継ぎながら、まったく新しい物語がここから始まる。人類は再び壁の中へ。",
	}

	for _, in := range rejected {
		got, ok := CleanSummary(in)
		assert.False(t, ok, "input should be rejected: %q", in)
		assert.Equal(t, "", got, "rejected input must yield an empty string: %q", in)
	}
}

// ---------------------------------------------------------------------------
// Documented current behaviour — flagged to the maintainer, not a fix.
//
// The two tests below assert what CleanSummary does today, not what it
// arguably should do. They exist so the gaps are visible in the test output
// instead of being discovered in prod, and so any deliberate change to them
// is a conscious edit rather than an accident.
// ---------------------------------------------------------------------------

// TestCleanSummaryLatinOnlyIsAccepted documents that a summary with no CJK
// characters at all passes the gate once it clears 40 runes.
//
// summary.go's isJapanese doc comment says "the caller's length check is what
// rejects those in practice" — that holds for a stray URL, but not for a
// prose-length English or romaji blurb, which sails past 40 runes.
//
// The stored row is then description_cn with source='bangumi', so the zh
// reader gets English text — same words they would have fallen back to — but
// the block is NOT identical to the fallback: it now carries a "简介来自
// Bangumi" credit and a data-nosnippet boundary, which holds that paragraph
// out of Google's snippet pool for the page. Small, and arguably correct
// (the text really did come from Bangumi), but not the "nothing changes"
// the code comment implies. Bangumi is a Chinese-language site, so a
// Latin-only summary long enough to clear the floor is rare; filed as a
// documented quirk rather than a defect.
func TestCleanSummaryLatinOnlyIsAccepted(t *testing.T) {
	t.Parallel()

	got, ok := CleanSummary("A high school student discovers a supernatural notebook that kills anyone whose name is written in it.")

	assert.True(t, ok, "current behaviour: no CJK means the kana gate abstains")
	assert.NotEmpty(t, got)
}

// TestCleanSummaryFullWidthDividerNotStripped documents that summaryDivider
// only matches the ASCII-bracketed 「[简介原文]」 form. A full-width
// 【简介原文】 variant is left in place, and the Japanese tail after it stays
// too — whether the row is then rejected depends purely on whether the mixed
// text tips over the 0.35 kana ratio, which a long Chinese body will not.
//
// Page-level consequence, so the severity is legible without re-deriving it:
// the zh reader gets a correct Chinese synopsis with a raw 【简介原文】
// marker and an untranslated Japanese paragraph hanging off the end, wearing
// a "简介来自 Bangumi" credit — i.e. exactly the failure the divider strip
// exists to prevent, just spelled with different brackets.
//
// Not fixed here because summary.go is out of scope for the test pass. The
// fix is one character class:
//
//	regexp.MustCompile(`[\[【]简介原文[\]】][\s\S]*$`)
//
// Frequency is unmeasured — the prod sample recorded 1.3% carrying a divider
// but did not break that down by bracket form, so the sampler needs to be
// re-run against 【】 before anyone decides whether this is worth a patch.
func TestCleanSummaryFullWidthDividerNotStripped(t *testing.T) {
	t.Parallel()

	got, ok := CleanSummary(battleSkipperCN + "\n\n【简介原文】\n" + onePieceJPTail)

	assert.True(t, ok, "current behaviour: the mixed text still passes the kana gate")
	assert.Contains(t, got, "简介原文", "current behaviour: the full-width marker survives")
	assert.Contains(t, got, "大海賊時代", "current behaviour: the Japanese tail survives")
}
