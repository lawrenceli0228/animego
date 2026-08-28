package hant

import "testing"

// The vendored table, measured against the titles it has to fold in production.
//
// /api/anime/search runs an incoming Simplified keyword through this converter
// and matches the result against title_hant. That only works if the table's
// output is byte-identical to what is stored — a near miss is a miss, because
// the match is ILIKE, not similarity.
//
// The rows below are real. Every one of them has a title_hant and NO
// title_chinese, which is the 1,262-row set folding exists for: a Simplified
// reader could not reach any of them. The cause is upstream and specific —
// Simplified titles come from Bangumi enrichment, and this set has 9.4% bgm_id
// coverage against 70.8% for the catalogue, so there was no subject to read one
// from. They are not obscure: 315 of the set are TV series, and these include
// some of the best-known franchises in it.
//
// The `left` column is what a reader would actually type. It is written here as
// Simplified rather than derived from the stored value, because deriving it
// would need the reverse table, which is exactly what the repository does not
// vendor — and a test that generated its own input from its own output would
// agree with a broken table.
//
// These eight are hand-picked and therefore NOT a measure of how well folding
// works — read them as "the table does what it says on titles like these". The
// population number was measured separately, over the 5,160 rows carrying both
// a Simplified title and an authoritative (non-opencc) Traditional one: folding
// produces a substring of the stored Traditional title for 40.7% of them,
// against 7.4% without it. The gap is not the table's fault. Taiwan and the
// mainland publish many of these under different names — 海賊王 against 航海王,
// 三眼小子 against 三眼神童 — and 2,237 of the misses differ in length from the
// stored title, i.e. are a different translation rather than a different script.
func TestConvert_FoldsRealCatalogueTitles(t *testing.T) {
	t.Parallel()
	c := testConverter(t)

	// left: the Simplified a reader types. right: the exact stored title_hant.
	cases := []struct {
		typed, stored string
		anilistID     int
	}{
		{"进击的巨人 The Final Season", "進擊的巨人 The Final Season", 146984},
		{"海盗战记 第二季", "海盜戰記 第二季", 136430},
		{"药师少女的独语 第二季", "藥師少女的獨語 第二季", 176301},
		{"灵能百分百 II", "靈能百分百 II", 101338},
		{"排球少年!! 乌野高中 VS 白鸟泽学园高中", "排球少年!! 烏野高中 VS 白鳥澤學園高中", 21698},
		{"BLEACH 死神 千年血战篇-祸进谭-", "BLEACH 死神 千年血戰篇-禍進譚-", 185874},
		{"新世纪福音战士 新剧场版", "新世紀福音戰士 新劇場版", 3786},
		{"辉夜姬想让人告白", "輝夜姬想讓人告白", 151384},
	}

	for _, tc := range cases {
		t.Run(tc.typed, func(t *testing.T) {
			got := c.Convert(tc.typed)
			if got != tc.stored {
				t.Errorf(
					"anilist_id %d: folding the typed form does not reproduce the stored title_hant\n"+
						"  typed:  %s\n  got:    %s\n  stored: %s",
					tc.anilistID, tc.typed, got, tc.stored,
				)
			}
		})
	}
}

// Folding must not damage what already works.
//
// s2twp is not a pure script conversion — the `wp` suffix is Taiwan phrase
// substitution, which rewrites vocabulary (软件 → 軟體). That is right for
// prose and wrong for a title that is matched literally, so the risk worth
// pinning is a keyword that gets vocabulary-substituted into something the
// catalogue does not contain. The failure would be silent: fewer results, not
// an error.
func TestConvert_LeavesNonChineseKeywordsAlone(t *testing.T) {
	t.Parallel()
	c := testConverter(t)

	for _, s := range []string{
		"Frieren",
		"Attack on Titan",
		"進撃の巨人", // Japanese: already non-Simplified, must survive intact
		"BLEACH",
		"100%",
		"_",
		"", // the empty keyword never reaches the converter, but must not panic
	} {
		if got := c.Convert(s); got != s {
			t.Errorf("Convert(%q) = %q, want it unchanged — a keyword that is not "+
				"Simplified Chinese has nothing to fold, and rewriting it can only "+
				"lose matches", s, got)
		}
	}
}
