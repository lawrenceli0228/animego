package hant

import (
	"reflect"
	"testing"
)

// ─── rule 5: the CGroup join key ─────────────────────────────────────────────

// The normalisation is three steps and the test says which three, because
// "normalise both sides identically" is only a rule if the normalisation
// is written down.
func TestNormalizeJoinKey(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"nfkc folds full-width latin", "ＳＯＵＬ　ＥＡＴＥＲ", "souleater"},
		{"nfkc folds roman numerals", "ジョジョⅡ", "ジョジョii"},
		{"lowercases", "ALL YOU NEED IS KILL", "allyouneediskill"},
		{"drops ascii space", "SOUL EATER", "souleater"},
		{"drops ideographic space", "心之谷　幸福", "心之谷幸福"},
		{"drops tabs and newlines", "a\tb\nc", "abc"},
		{"keeps punctuation", "3×3 EYES", "3×3eyes"},
		{"keeps slashes", ".hack//SIGN", ".hack//sign"},
		{"leaves clean han alone", "夢幻街少女", "夢幻街少女"},
		{"empty stays empty", "", ""},
		{"whitespace only collapses to empty", " 　 ", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := normalizeJoinKey(tc.in); got != tc.want {
				t.Fatalf("normalizeJoinKey(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// Punctuation and season markers survive on purpose.  bangumi.NormalizeTitle
// strips both, which is right for fuzzy similarity scoring and wrong for an
// exact-key join: it would fold 心之谷 and 心之谷 幸せな時間 together and
// manufacture a collision between a film and its sequel.
func TestNormalizeJoinKeyKeepsSeasonAndPunctuationDistinctions(t *testing.T) {
	a := normalizeJoinKey("心之谷")
	b := normalizeJoinKey("心之谷：幸福的時光")
	if a == b {
		t.Fatalf("a film and its sequel normalised to the same key %q", a)
	}
	if normalizeJoinKey("3×3 EYES") == normalizeJoinKey("33EYES") {
		t.Fatal("stripping × would collide 3×3 EYES with an unrelated title")
	}
}

// ─── rule 4: collisions are skipped, never resolved ──────────────────────────

// 17 keys in the vendored file map to more than one Hong Kong title.
// They are genuine upstream ambiguity, and last-write-wins would resolve
// them by JSON file order — a coin flip dressed up as a decision.
func TestCgroupCollidingKeysAreDropped(t *testing.T) {
	// Verbatim from cgroup-hk.json: Whisper of the Heart and its sequel.
	records := []cgroupRecord{
		{ZhHK: "夢幻街少女", Keys: []string{"侧耳倾听", "夢幻街少女", "心之谷", "梦幻街少女", "耳をすませば"}},
		{ZhHK: "心之谷", Keys: []string{"侧耳倾听：幸福的时光", "心之谷", "耳をすませば 幸せな時間"}},
	}
	set, err := buildCgroupSet(records)
	if err != nil {
		t.Fatalf("buildCgroupSet: %v", err)
	}

	if _, ok := set.byKey["心之谷"]; ok {
		t.Fatal("心之谷 maps to two different Hong Kong titles and must not be resolvable")
	}
	if want := []string{"心之谷"}; !reflect.DeepEqual(set.Dropped, want) {
		t.Fatalf("Dropped = %v, want %v", set.Dropped, want)
	}

	// Keys unique to one record still work — dropping the ambiguous key
	// must not poison the whole record.
	if got := set.byKey["耳をすませば"]; got != "夢幻街少女" {
		t.Fatalf("耳をすませば = %q, want 夢幻街少女", got)
	}
	if got := set.byKey["耳をすませば幸せな時間"]; got != "心之谷" {
		t.Fatalf("耳をすませば 幸せな時間 = %q, want 心之谷", got)
	}
}

// A key that appears twice pointing at the *same* Hong Kong title is not
// ambiguous — it is a duplicate, and dropping it would lose a good join.
func TestCgroupDuplicateKeysWithOneValueSurvive(t *testing.T) {
	set, err := buildCgroupSet([]cgroupRecord{
		{ZhHK: "夢幻街少女", Keys: []string{"耳をすませば", "夢幻街少女"}},
		{ZhHK: "夢幻街少女", Keys: []string{"耳をすませば"}},
	})
	if err != nil {
		t.Fatalf("buildCgroupSet: %v", err)
	}
	if len(set.Dropped) != 0 {
		t.Fatalf("Dropped = %v, want none", set.Dropped)
	}
	if got := set.byKey["耳をすませば"]; got != "夢幻街少女" {
		t.Fatalf("got %q, want 夢幻街少女", got)
	}
}

// Collisions are detected after normalisation, because normalisation can
// create them: two keys differing only in case fold together.
func TestCgroupCollisionsAreDetectedAfterNormalisation(t *testing.T) {
	set, err := buildCgroupSet([]cgroupRecord{
		{ZhHK: "SOUL EATER 噬魂師", Keys: []string{"SOUL EATER", "噬魂者"}},
		{ZhHK: "噬魂師", Keys: []string{"soul  eater"}},
	})
	if err != nil {
		t.Fatalf("buildCgroupSet: %v", err)
	}
	if _, ok := set.byKey["souleater"]; ok {
		t.Fatal("two raw keys that normalise together and disagree must be dropped")
	}
}

// The vendored file is the real assertion: exactly the 17 documented
// collisions, no more (which would mean the normalisation is too
// aggressive) and no fewer (which would mean it is not running).
func TestVendoredCgroupHasSeventeenCollisions(t *testing.T) {
	set := testResolver(t).cgroup
	if len(set.Dropped) != 17 {
		t.Fatalf("cgroup-hk.json dropped %d ambiguous keys, want 17: %v", len(set.Dropped), set.Dropped)
	}
}

// ─── rule 5: native before chinese ───────────────────────────────────────────

// CGroup's first argument is usually the Japanese original, and it is
// measurably the better key — 485 normalised hits against title_chinese's
// 405 over the 17,511 production rows.  Trying Chinese first would hand
// those rows to whichever key happened to match.
func TestCgroupLookupPrefersTitleNative(t *testing.T) {
	set, err := buildCgroupSet([]cgroupRecord{
		{ZhHK: "從日語標題命中", Keys: []string{"耳をすませば"}},
		{ZhHK: "從中文標題命中", Keys: []string{"侧耳倾听"}},
	})
	if err != nil {
		t.Fatalf("buildCgroupSet: %v", err)
	}

	hit, ok := set.lookup(ptr("耳をすませば"), ptr("侧耳倾听"))
	if !ok {
		t.Fatal("expected a hit when both sides match")
	}
	if hit.Value != "從日語標題命中" || hit.Via != "title_native" {
		t.Fatalf("got %+v, want the title_native side to win", hit)
	}

	// Chinese is still tried when native misses.
	hit, ok = set.lookup(ptr("no such title"), ptr("侧耳倾听"))
	if !ok || hit.Value != "從中文標題命中" || hit.Via != "title_chinese" {
		t.Fatalf("got %+v ok=%v, want the title_chinese fallback", hit, ok)
	}

	// Nil columns are skipped rather than dereferenced.
	if _, ok := set.lookup(nil, nil); ok {
		t.Fatal("two NULL columns cannot produce a hit")
	}
	if hit, ok := set.lookup(nil, ptr("侧耳倾听")); !ok || hit.Via != "title_chinese" {
		t.Fatalf("a NULL title_native must fall through to title_chinese, got %+v ok=%v", hit, ok)
	}
}

// ─── anilist-chinese ─────────────────────────────────────────────────────────

// Rule 2's second half: on rejection, fall through to the record's
// synonyms in upstream order, because that order encodes the curator's
// preference.
func TestAnilistPickFallsThroughToSynonyms(t *testing.T) {
	g := testGate(t)
	set := &anilistSet{byID: map[int32]anilistRecord{
		1:  {ID: 1, Title: "星際牛仔"},
		6:  {ID: 6, Title: "Trigun", Synonyms: []string{"槍神Trigun"}},
		21: {ID: 21, Title: "One Piece", Synonyms: []string{"海賊王", "航海王"}},
		99: {ID: 99, Title: "Akira"},
		98: {ID: 98, Title: "淫獣学園 La Blue Girl"},
		97: {ID: 97, Title: "夜が来る!", Synonyms: []string{"夜晚來臨"}},
	}}

	t.Run("clean title wins outright", func(t *testing.T) {
		got, ok := set.pick(1, g)
		if !ok || got.Value != "星際牛仔" || got.FromSynonym || got.TitleReason != ReasonNone {
			t.Fatalf("got %+v ok=%v", got, ok)
		}
	})

	t.Run("first cjk synonym stands in for a latin title", func(t *testing.T) {
		got, _ := set.pick(21, g)
		if got.Value != "海賊王" {
			t.Fatalf("Value = %q, want 海賊王 (upstream's first synonym, not 航海王)", got.Value)
		}
		if !got.FromSynonym || got.TitleReason != ReasonNoHan {
			t.Fatalf("got %+v, want FromSynonym with reason %q", got, ReasonNoHan)
		}
	})

	t.Run("mixed synonym counts as chinese", func(t *testing.T) {
		got, _ := set.pick(6, g)
		if got.Value != "槍神Trigun" || !got.FromSynonym {
			t.Fatalf("got %+v", got)
		}
	})

	t.Run("no synonym means no candidate", func(t *testing.T) {
		got, ok := set.pick(99, g)
		if !ok {
			t.Fatal("the record exists, so pick must report it")
		}
		if got.Value != "" || got.TitleReason != ReasonNoHan {
			t.Fatalf("got %+v, want an empty value with reason %q", got, ReasonNoHan)
		}
	})

	t.Run("kana and simplified rejections also try synonyms", func(t *testing.T) {
		// The README only documents the no-Han fallback, but a synonym is
		// an alternative name from the same curator whatever dropped the
		// primary — this rescues 13 further rows in the vendored file.
		got, _ := set.pick(97, g)
		if got.Value != "夜晚來臨" || got.TitleReason != ReasonKana {
			t.Fatalf("got %+v, want the synonym with reason %q", got, ReasonKana)
		}

		got, _ = set.pick(98, g)
		if got.TitleReason != ReasonSimplified {
			t.Fatalf("reason = %q, want %q", got.TitleReason, ReasonSimplified)
		}
		if string(got.TitleSimplified) != "学" {
			t.Fatalf("TitleSimplified = %q, want 学 — the report needs these to queue hand fixes",
				string(got.TitleSimplified))
		}
	})

	t.Run("absent id reports not-found rather than empty", func(t *testing.T) {
		if _, ok := set.pick(123456, g); ok {
			t.Fatal("pick must distinguish 'no record' from 'record with nothing usable'")
		}
	})
}

// The vendored file loads, is keyed by AniList id, and is the size the
// README says it is.  A silently truncated download would otherwise show
// up as a mysteriously small anilist tier in the report.
func TestVendoredAnilistSetLoads(t *testing.T) {
	set := testResolver(t).anilist
	if len(set.byID) != 8492 {
		t.Fatalf("anilist-chinese.json has %d records, want 8492", len(set.byID))
	}
	if got := set.byID[1].Title; got != "星際牛仔" {
		t.Fatalf("id 1 = %q, want 星際牛仔", got)
	}
	if got := set.byID[21].Synonyms; len(got) != 2 || got[0] != "海賊王" {
		t.Fatalf("id 21 synonyms = %v, want upstream order [海賊王 航海王]", got)
	}
}

func TestLoadersRejectStructurallyBrokenData(t *testing.T) {
	if _, err := buildCgroupSet([]cgroupRecord{{ZhHK: "", Keys: []string{"x"}}}); err == nil {
		t.Error("a record with an empty zh_hk must be an error, not a silently skipped row")
	}
	if _, err := buildCgroupSet(nil); err == nil {
		t.Error("an empty dataset must be an error — it means the file did not load")
	}
}
