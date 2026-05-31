package bangumi

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// ---------------------------------------------------------------------------
// NormalizeTitle
// ---------------------------------------------------------------------------

func TestNormalizeTitle(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		input string
		want  string
	}{
		{
			name:  "empty string",
			input: "",
			want:  "",
		},
		{
			name:  "plain ASCII lowercase unchanged",
			input: "naruto",
			want:  "naruto",
		},
		{
			name:  "ASCII uppercase lowercased",
			input: "NARUTO",
			want:  "naruto",
		},
		{
			// NFKC converts full-width ASCII (U+FF21…U+FF5A) to half-width,
			// then ToLower folds to lowercase.
			name:  "full-width ASCII letters via NFKC then lower",
			input: "ＮＡＲＵＴＯ",
			want:  "naruto",
		},
		{
			name:  "ASCII spaces stripped",
			input: "Attack on Titan",
			want:  "attackontitan",
		},
		{
			// U+3000 IDEOGRAPHIC SPACE is in Unicode category Zs → stripped by
			// unicode.IsSpace, and 第2期 is removed by the season replacer.
			name:  "full-width space (U+3000) stripped",
			input: "進撃の巨人　第2期",
			want:  "進撃の巨人",
		},
		{
			// Punctuation chars in punctuationCutSet including '-' and ':'.
			name:  "ASCII punctuation stripped",
			input: "Re:Zero - Starting Life in Another World",
			want:  "rezerostartinglifeinanotherworld",
		},
		{
			// 【】 are in punctuationCutSet; content inside is kept.
			name:  "Japanese punctuation stripped",
			input: "涼宮ハルヒの憂鬱【完全版】",
			want:  "涼宮ハルヒの憂鬱完全版",
		},
		{
			// NFKC converts Ⅱ (U+2161) → "II" → lower → "ii" → replaced by seasonSuffixReplacer.
			name:  "NFKC roman numeral Ⅱ stripped as season marker",
			input: "進撃の巨人 Ⅱ",
			want:  "進撃の巨人",
		},
		{
			// 第2期 is stripped by the replacer (spaces already removed before replacer runs).
			name:  "season marker 第2期 stripped",
			input: "アオアシ 第2期",
			want:  "アオアシ",
		},
		{
			// "Overlord 2nd Season" →
			//   lower: "overlord 2nd season"
			//   strip spaces+punct: "overlord2ndseason"
			//   replacer: "2ndseason" removed → "overlord"
			name:  "season marker 2nd season stripped (after space removal)",
			input: "Overlord 2nd Season",
			want:  "overlord",
		},
		{
			// "ダイヤのA OAD" →
			//   NFKC: unchanged
			//   lower: "ダイヤのa oad"   (ASCII 'A' → 'a')
			//   strip spaces: "ダイヤのaoad"
			//   replacer removes "oad" → "ダイヤのa"
			name:  "OAD stripped",
			input: "ダイヤのA OAD",
			want:  "ダイヤのa",
		},
		{
			// "終わりのセラフ OVA" → strip space → "終わりのセラフova" → remove "ova" → "終わりのセラフ"
			name:  "OVA stripped",
			input: "終わりのセラフ OVA",
			want:  "終わりのセラフ",
		},
		{
			// '(' ')' and '.' are in punctuationCutSet; "movie" removed by replacer.
			// "君の名は。(Movie)" →
			//   lower: "君の名は。(movie)"
			//   strip punct (。 is in cutset, ( ) are in cutset): "君の名はmovie"
			//   replacer removes "movie" → "君の名は"
			name:  "Movie stripped",
			input: "君の名は。(Movie)",
			want:  "君の名は",
		},
		{
			// "Sword Art Online Part2" →
			//   lower: "sword art online part2"
			//   strip spaces: "swordartonlinepart2"
			//   replacer removes "part2" → "swordartonline"
			name:  "Part2 stripped",
			input: "Sword Art Online Part2",
			want:  "swordartonline",
		},
		{
			// "Shingeki no Kyojin Season3" →
			//   lower: "shingeki no kyojin season3"
			//   strip spaces: "shingekinokyojinseason3"
			//   replacer removes "season3" → "shingekinokyojin"
			name:  "mixed case season marker Season3",
			input: "Shingeki no Kyojin Season3",
			want:  "shingekinokyojin",
		},
		{
			// ☆ (U+2605 BLACK STAR) is not in punctuationCutSet and is not
			// whitespace — it stays in the output.
			name:  "star character (☆) not in cutset — stays unchanged",
			input: "魔法少女まどか☆マギカ",
			want:  "魔法少女まどか☆マギカ",
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := NormalizeTitle(tc.input)
			assert.Equal(t, tc.want, got)
		})
	}
}

// ---------------------------------------------------------------------------
// TitleSimilarity
// ---------------------------------------------------------------------------

func TestTitleSimilarity(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name      string
		a, b      string
		wantExact float64 // only used when > 0 (or the explicit 1.0 case)
		wantMin   float64
		wantMax   float64
		exactSet  bool // true when we want exact comparison
	}{
		{
			name:      "identical strings",
			a:         "進撃の巨人",
			b:         "進撃の巨人",
			exactSet:  true,
			wantExact: 1.0,
		},
		{
			name:      "identical after normalisation (full-width vs half-width)",
			a:         "ＮＡＲＵＴＯ",
			b:         "NARUTO",
			exactSet:  true,
			wantExact: 1.0,
		},
		{
			name:    "completely disjoint strings",
			a:       "進撃の巨人",
			b:       "ボボーボ・ボーボボ",
			wantMin: 0.0,
			wantMax: 0.3, // some accidental bigram overlap possible; keep ceiling low
		},
		{
			// After normalisation "Season2" is stripped from b so both normalise
			// to "進撃の巨人" → identical → 1.0.
			name:      "partial overlap — sequel vs original (season marker stripped)",
			a:         "進撃の巨人",
			b:         "進撃の巨人 Season2",
			exactSet:  true,
			wantExact: 1.0,
		},
		{
			name:      "two empty strings are equal",
			a:         "",
			b:         "",
			exactSet:  true,
			wantExact: 1.0,
		},
		{
			name:    "one empty — other has bigrams — returns 0",
			a:       "進撃の巨人",
			b:       "",
			wantMin: 0.0,
			wantMax: 0.0,
		},
		{
			// "アオアシ 第2期" normalises to "アオアシ" (same as "アオアシ") → 1.0.
			name:      "season marker stripped yields equality",
			a:         "アオアシ",
			b:         "アオアシ 第2期",
			exactSet:  true,
			wantExact: 1.0,
		},
		{
			name:    "very different titles — audit pair 1",
			a:       "むさしの！ボーナス",
			b:       "ボボーボ・ボーボボ",
			wantMin: 0.0,
			wantMax: 0.35,
		},
		{
			name:    "very different titles — audit pair 2",
			a:       "アオアシ",
			b:       "アリス探偵局",
			wantMin: 0.0,
			wantMax: 0.35,
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := TitleSimilarity(tc.a, tc.b)
			if tc.exactSet {
				assert.InDelta(t, tc.wantExact, got, 1e-9,
					"TitleSimilarity(%q, %q) want exact %.4f", tc.a, tc.b, tc.wantExact)
				return
			}
			assert.GreaterOrEqual(t, got, tc.wantMin,
				"TitleSimilarity(%q, %q) below min %.4f", tc.a, tc.b, tc.wantMin)
			assert.LessOrEqual(t, got, tc.wantMax,
				"TitleSimilarity(%q, %q) above max %.4f", tc.a, tc.b, tc.wantMax)
		})
	}
}

// ---------------------------------------------------------------------------
// ScoreCandidate — year / episode weighting
// ---------------------------------------------------------------------------

func TestScoreCandidate(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		in      MatchInput
		c       SearchResult
		wantMin float64
		wantMax float64
	}{
		{
			// score = 0.70*1.0 + 0.20*1.0 + 0.10*1.0 = 1.0
			name: "perfect match — same title, year, eps",
			in: MatchInput{
				TitleNative: "新世紀エヴァンゲリオン",
				SeasonYear:  1995,
				Episodes:    26,
			},
			c: SearchResult{
				Name: "新世紀エヴァンゲリオン",
				Date: "1995-10-04",
				Eps:  26,
			},
			wantMin: 0.95,
			wantMax: 1.0,
		},
		{
			// score = 0.70*1.0 + 0.20*0.6 + 0.10*1.0 = 0.70+0.12+0.10 = 0.92
			name: "perfect title, year off by 1, eps match",
			in: MatchInput{
				TitleNative: "新世紀エヴァンゲリオン",
				SeasonYear:  1996,
				Episodes:    26,
			},
			c: SearchResult{
				Name: "新世紀エヴァンゲリオン",
				Date: "1995-10-04",
				Eps:  26,
			},
			wantMin: 0.90,
			wantMax: 0.95,
		},
		{
			// yearScore=0.0 (Δ=3); score = 0.70 + 0.0 + 0.10 = 0.80
			name: "perfect title, year off by 3",
			in: MatchInput{
				TitleNative: "新世紀エヴァンゲリオン",
				SeasonYear:  1998,
				Episodes:    26,
			},
			c: SearchResult{
				Name: "新世紀エヴァンゲリオン",
				Date: "1995-10-04",
				Eps:  26,
			},
			wantMin: 0.78,
			wantMax: 0.82,
		},
		{
			// titleSim low, year wildly wrong, eps wrong → very low score
			name: "completely wrong candidate",
			in: MatchInput{
				TitleNative: "むさしの！ボーナス",
				SeasonYear:  2025,
				Episodes:    12,
			},
			c: SearchResult{
				Name: "ボボーボ・ボーボボ",
				Date: "2003-10-05",
				Eps:  76,
			},
			wantMin: 0.0,
			wantMax: 0.40,
		},
		{
			// in.SeasonYear==0 → yearScore=0.5 (neutral)
			// score = 0.70*1.0 + 0.20*0.5 + 0.10*1.0 = 0.70+0.10+0.10 = 0.90
			name: "unknown year on input — neutral contribution",
			in: MatchInput{
				TitleNative: "新世紀エヴァンゲリオン",
				SeasonYear:  0,
				Episodes:    26,
			},
			c: SearchResult{
				Name: "新世紀エヴァンゲリオン",
				Date: "1995-10-04",
				Eps:  26,
			},
			wantMin: 0.88,
			wantMax: 0.92,
		},
		{
			// c.Eps==0 → epsScore=0.5 (neutral)
			// score = 0.70*1.0 + 0.20*1.0 + 0.10*0.5 = 0.70+0.20+0.05 = 0.95
			name: "unknown eps on candidate — neutral contribution",
			in: MatchInput{
				TitleNative: "新世紀エヴァンゲリオン",
				SeasonYear:  1995,
				Episodes:    26,
			},
			c: SearchResult{
				Name: "新世紀エヴァンゲリオン",
				Date: "1995-10-04",
				Eps:  0,
			},
			wantMin: 0.93,
			wantMax: 0.97,
		},
		{
			// c.Date=="" → yearScore=0.5 (neutral)
			// score = 0.70*1.0 + 0.20*0.5 + 0.10*1.0 = 0.90
			name: "no date on candidate — year neutral",
			in: MatchInput{
				TitleNative: "新世紀エヴァンゲリオン",
				SeasonYear:  1995,
				Episodes:    26,
			},
			c: SearchResult{
				Name: "新世紀エヴァンゲリオン",
				Date: "",
				Eps:  26,
			},
			wantMin: 0.88,
			wantMax: 0.92,
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := ScoreCandidate(tc.in, tc.c)
			assert.GreaterOrEqual(t, got, tc.wantMin,
				"ScoreCandidate score %v below min %v", got, tc.wantMin)
			assert.LessOrEqual(t, got, tc.wantMax,
				"ScoreCandidate score %v above max %v", got, tc.wantMax)
		})
	}
}

// ---------------------------------------------------------------------------
// PickBest — tier assignment
// ---------------------------------------------------------------------------

func TestPickBest_EmptyList(t *testing.T) {
	t.Parallel()

	best, score, tier := PickBest(MatchInput{TitleNative: "test"}, nil)
	assert.Nil(t, best)
	assert.Equal(t, 0.0, score)
	assert.Equal(t, TierNone, tier)
}

func TestPickBest_TierHigh_ExactMatch(t *testing.T) {
	t.Parallel()

	in := MatchInput{
		TitleNative: "新世紀エヴァンゲリオン",
		SeasonYear:  1995,
		Episodes:    26,
	}
	list := []SearchResult{
		{Name: "新世紀エヴァンゲリオン", Date: "1995-10-04", Eps: 26},
	}

	best, score, tier := PickBest(in, list)
	assert.NotNil(t, best)
	assert.Equal(t, TierHigh, tier,
		"expected TierHigh for exact match, got %s (score=%.3f)", tier, score)
}

func TestPickBest_TierHigh_PicksBestFromMultiple(t *testing.T) {
	t.Parallel()

	in := MatchInput{
		TitleNative: "進撃の巨人",
		SeasonYear:  2013,
		Episodes:    25,
	}
	list := []SearchResult{
		{ID: 1, Name: "ボボーボ・ボーボボ", Date: "2003-10-05", Eps: 76},     // wrong
		{ID: 2, Name: "進撃の巨人", Date: "2013-04-07", Eps: 25},         // correct
		{ID: 3, Name: "進撃の巨人 Season2", Date: "2017-04-01", Eps: 12}, // sequel
	}

	best, _, tier := PickBest(in, list)
	assert.NotNil(t, best)
	assert.Equal(t, 2, best.ID, "expected candidate ID 2 (exact), got %d", best.ID)
	assert.Equal(t, TierHigh, tier)
}

func TestPickBest_TierNone_NoGoodMatch(t *testing.T) {
	t.Parallel()

	in := MatchInput{
		TitleNative: "全然違うアニメ",
		SeasonYear:  2020,
		Episodes:    12,
	}
	list := []SearchResult{
		{Name: "ボボーボ・ボーボボ", Date: "2003-10-05", Eps: 76},
		{Name: "マッハGoGoGo", Date: "1997-04-07", Eps: 52},
	}

	_, _, tier := PickBest(in, list)
	assert.Equal(t, TierNone, tier)
}

func TestPickBest_TierLow_YearContradicted(t *testing.T) {
	t.Parallel()

	// Title similarity high after normalisation (season stripped), but year is
	// wildly off (|Δ|=4) → yearScore=0.0.
	// score = 0.70*~1.0 + 0.0 + 0.0*(eps mismatch) = ~0.70
	// 0.70 ≥ ScoreLow(0.55) but NOT ≥ ScoreHigh(0.82) AND yearScore==0.0 blocks
	// the "ts≥0.95 AND ys≠0.0" fast path → TierLow.
	in := MatchInput{
		TitleNative: "アオアシ",
		SeasonYear:  2022,
		Episodes:    24,
	}
	list := []SearchResult{
		{Name: "アオアシ 第2期", Date: "2026-01-01", Eps: 12},
	}

	_, score, tier := PickBest(in, list)
	assert.Equal(t, TierLow, tier,
		"expected TierLow for year-contradicted match, got %s (score=%.3f)", tier, score)
}

// ---------------------------------------------------------------------------
// REGRESSION TESTS — real audit failures.
// Each was incorrectly bound (TierHigh) in production; now must NOT be TierHigh.
// ---------------------------------------------------------------------------

func TestPickBest_RegressionWrongBindings(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name           string
		in             MatchInput
		wrongCandidate SearchResult
	}{
		{
			name: "むさしの！ボーナス vs ボボーボ・ボーボボ",
			in: MatchInput{
				TitleNative: "むさしの！ボーナス",
				SeasonYear:  2025,
			},
			wrongCandidate: SearchResult{
				Name: "ボボーボ・ボーボボ",
				Date: "2003-10-05",
			},
		},
		{
			name: "リック・アンド・モーティ サマー・ミーツ・ゴッド vs マッハGoGoGo",
			in: MatchInput{
				TitleNative: "リック・アンド・モーティ サマー・ミーツ・ゴッド",
				SeasonYear:  2021,
			},
			wrongCandidate: SearchResult{
				Name: "マッハGoGoGo",
				Date: "1997-04-07",
			},
		},
		{
			name: "アオアシ 第2期 vs アリス探偵局 第2期",
			in: MatchInput{
				TitleNative: "アオアシ 第2期",
				SeasonYear:  2026,
			},
			wrongCandidate: SearchResult{
				Name: "アリス探偵局 第2期",
				Date: "1996-01-01",
			},
		},
		{
			name: "ソニックX 第2期 vs トニカクカワイイ 第2期",
			in: MatchInput{
				TitleNative: "ソニックX 第2期",
				SeasonYear:  2005,
			},
			wrongCandidate: SearchResult{
				Name: "トニカクカワイイ 第2期",
				Date: "2023-04-01",
			},
		},
		{
			name: "ダイヤのA[エース] OAD vs 終わりのセラフ OAD",
			in: MatchInput{
				TitleNative: "ダイヤのA[エース] OAD",
				SeasonYear:  2014,
			},
			wrongCandidate: SearchResult{
				Name: "終わりのセラフ OAD",
				Date: "2016-01-01",
			},
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			// The list contains ONLY the wrong candidate — we assert the scorer
			// does NOT confidently bind it (must be TierLow or TierNone).
			list := []SearchResult{tc.wrongCandidate}
			_, score, tier := PickBest(tc.in, list)

			assert.NotEqual(t, TierHigh, tier,
				"regression: %s — wrong candidate must NOT yield TierHigh (score=%.3f, tier=%s)",
				tc.name, score, tier)
		})
	}
}

// TestPickBest_KnownHardCrossScript asserts that cross-script same-work cases
// land TierLow (needs-review) rather than TierHigh.  The title similarity
// between Japanese katakana and Latin script is unreliable, so we prefer
// needs-review over a wrong bind.  Per spec: TierLow or TierNone are both
// acceptable outcomes here.
func TestPickBest_KnownHardCrossScript(t *testing.T) {
	t.Parallel()

	in := MatchInput{
		TitleNative: "バイオハザード:インフィニットダークネス",
		SeasonYear:  2021,
		Episodes:    4,
	}
	list := []SearchResult{
		{Name: "BIOHAZARD：Infinite Darkness", Date: "2021-07-08", Eps: 4},
	}

	_, score, tier := PickBest(in, list)
	// Must not be TierHigh (cannot reliably match cross-script titles).
	assert.NotEqual(t, TierHigh, tier,
		"cross-script match must not reach TierHigh (score=%.3f, tier=%s)", score, tier)
	// Should be TierLow or TierNone per spec.
	assert.Contains(t, []MatchTier{TierLow, TierNone}, tier,
		"cross-script match should be TierLow or TierNone (score=%.3f)", score)
}
