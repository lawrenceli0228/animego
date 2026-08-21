package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"reflect"
	"testing"
)

// testLadder builds a resolver over hand-written datasets so the ladder's
// behaviour is readable from the test rather than inferred from 8,492
// records.  The conversion table is the real one — there is no small
// version of s2twp that still converts.
func testLadder(t *testing.T) *resolver {
	t.Helper()
	real := testResolver(t)

	cg, err := buildCgroupSet([]cgroupRecord{
		// Verbatim from cgroup-hk.json.
		{ZhHK: "夢幻街少女", Keys: []string{"侧耳倾听", "夢幻街少女", "心之谷", "梦幻街少女", "耳をすませば"}},
		{ZhHK: "心之谷", Keys: []string{"侧耳倾听：幸福的时光", "心之谷", "耳をすませば 幸せな時間"}},
		{ZhHK: "進擊的巨人", Keys: []string{"進撃の巨人"}},
	})
	if err != nil {
		t.Fatalf("buildCgroupSet: %v", err)
	}

	return &resolver{
		cgroup: cg,
		anilist: &anilistSet{byID: map[int32]anilistRecord{
			1:     {ID: 1, Title: "星際牛仔"},
			16498: {ID: 16498, Title: "進擊的巨人（台）"},
			481:   {ID: 481, Title: "遊戯王 Duel Monsters"},
			21:    {ID: 21, Title: "One Piece", Synonyms: []string{"海賊王", "航海王"}},
		}},
		gate: real.gate,
		conv: real.conv,
	}
}

func hashOf(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// ─── the ladder ──────────────────────────────────────────────────────────────

func TestResolveTitleLadder(t *testing.T) {
	r := testLadder(t)

	t.Run("wikipedia wins over anilist where it exists", func(t *testing.T) {
		// Both tiers have an answer for this row.  Hong Kong is the
		// overlay and takes precedence.
		d := r.resolveTitle(animeRow{
			AnilistID:    16498,
			TitleNative:  ptr("進撃の巨人"),
			TitleChinese: ptr("进击的巨人"),
		})
		if d.Source != srcWikipedia || d.Value != "進擊的巨人" {
			t.Fatalf("got source=%q value=%q, want wikipedia/進擊的巨人", d.Source, d.Value)
		}
		if d.Via != "title_native" {
			t.Fatalf("Via = %q, want title_native", d.Via)
		}
	})

	t.Run("anilist is the trunk when the overlay misses", func(t *testing.T) {
		d := r.resolveTitle(animeRow{
			AnilistID:    1,
			TitleNative:  ptr("カウボーイビバップ"),
			TitleChinese: ptr("星际牛仔"),
		})
		if d.Source != srcAnilist || d.Value != "星際牛仔" {
			t.Fatalf("got source=%q value=%q, want anilist/星際牛仔", d.Source, d.Value)
		}
	})

	t.Run("opencc fills the tail", func(t *testing.T) {
		d := r.resolveTitle(animeRow{
			AnilistID:    999999, // not in either dataset
			TitleNative:  ptr("鬼滅の刃"),
			TitleChinese: ptr("鬼灭之刃"),
		})
		if d.Source != srcOpenCC || d.Value != "鬼滅之刃" {
			t.Fatalf("got source=%q value=%q, want opencc/鬼滅之刃", d.Source, d.Value)
		}
		// The hash covers title_chinese, not the converted output — the
		// input is what can drift.
		if d.Input != "鬼灭之刃" || d.Hash != hashOf("鬼灭之刃") {
			t.Fatalf("Input=%q Hash=%q, want the digest of title_chinese", d.Input, d.Hash)
		}
	})

	t.Run("a gate-rejected dataset title demotes rather than writes", func(t *testing.T) {
		// 遊戯王 carries shinjitai 戯, so the anilist tier declines and
		// the row falls to the machine conversion — which the generated
		// title_hant_seo column then keeps out of search results.
		d := r.resolveTitle(animeRow{
			AnilistID:    481,
			TitleChinese: ptr("游戏王"),
		})
		if d.Source != srcOpenCC {
			t.Fatalf("Source = %q, want opencc — a Simplified dataset title must not be written", d.Source)
		}
		if d.Pick.TitleReason != reasonSimplified {
			t.Fatalf("Pick.TitleReason = %q, want %q so the report can queue it", d.Pick.TitleReason, reasonSimplified)
		}
	})

	t.Run("an ambiguous cgroup key is not an answer", func(t *testing.T) {
		// 心之谷 collides, so it is absent from the key map and the row
		// falls through instead of getting one of the two names by luck.
		d := r.resolveTitle(animeRow{
			AnilistID:    888888,
			TitleChinese: ptr("心之谷"),
		})
		if d.Source == srcWikipedia {
			t.Fatalf("a colliding key produced a wikipedia answer: %q", d.Value)
		}
		if d.Source != srcOpenCC {
			t.Fatalf("Source = %q, want opencc", d.Source)
		}
	})

	t.Run("no tier reaches the row", func(t *testing.T) {
		d := r.resolveTitle(animeRow{AnilistID: 777777})
		if d.Source != "" {
			t.Fatalf("Source = %q, want empty — nothing should be proposed", d.Source)
		}
		// And an empty proposal must never be written, because "the
		// ladder found nothing" is not a reason to blank a column.
		if differs(d, ptr("既有的值"), ptr(srcManual), nil) {
			t.Fatal("an empty decision must never count as a change")
		}
	})

	t.Run("anilist synonym fallback carries into the decision", func(t *testing.T) {
		d := r.resolveTitle(animeRow{AnilistID: 21, TitleChinese: ptr("海贼王")})
		if d.Source != srcAnilist || d.Value != "海賊王" {
			t.Fatalf("got source=%q value=%q", d.Source, d.Value)
		}
		if !d.Pick.FromSynonym {
			t.Fatal("FromSynonym must survive into the decision for the report")
		}
	})
}

// The dataset tiers hash the dataset value; the opencc tier hashes
// title_chinese.  Getting these the wrong way round would make --restale
// answer a question nobody asked.
func TestSourceHashCoversTheInput(t *testing.T) {
	r := testLadder(t)

	d := r.resolveTitle(animeRow{AnilistID: 1, TitleChinese: ptr("星际牛仔")})
	if d.Input != "星際牛仔" || d.Hash != hashOf("星際牛仔") {
		t.Fatalf("anilist tier hashed %q; want the dataset value", d.Input)
	}

	d = r.resolveTitle(animeRow{AnilistID: 16498, TitleNative: ptr("進撃の巨人")})
	if d.Input != "進擊的巨人" || d.Hash != hashOf("進擊的巨人") {
		t.Fatalf("wikipedia tier hashed %q; want the zh_hk value", d.Input)
	}

	if sourceHash("") == "" {
		t.Fatal("sourceHash must always produce a digest")
	}
	if sourceHash("a") == sourceHash("b") {
		t.Fatal("sourceHash collided on one-byte inputs")
	}
}

// ─── description ─────────────────────────────────────────────────────────────

func TestResolveDescription(t *testing.T) {
	r := testLadder(t)

	d := r.resolveDescription(animeRow{DescriptionCN: ptr("人类得以在太阳系范围内自由移动。")})
	if d.Source != srcOpenCC {
		t.Fatalf("Source = %q, want opencc — no dataset carries Traditional synopses", d.Source)
	}
	if d.Value == *ptr("人类得以在太阳系范围内自由移动。") {
		t.Fatal("the description was not converted")
	}
	if d.Hash != hashOf("人类得以在太阳系范围内自由移动。") {
		t.Fatal("the description hash must cover description_cn")
	}

	if got := r.resolveDescription(animeRow{}); got.Source != "" {
		t.Fatalf("a row with no description_cn proposed %q", got.Source)
	}
	if got := r.resolveDescription(animeRow{DescriptionCN: ptr("")}); got.Source != "" {
		t.Fatal("an empty description_cn is not an input")
	}
}

// ─── manual ──────────────────────────────────────────────────────────────────

// "manual is never overwritten by this tool, ever."  Three checks guard
// it; this one covers the two in Go.  The third lives in the UPDATE's
// WHERE clause and is the one that survives a bug here.
func TestManualIsNeverProposedOverOrCountedAsWritable(t *testing.T) {
	r := testLadder(t)

	row := animeRow{
		AnilistID:       16498,
		TitleNative:     ptr("進撃の巨人"),
		TitleChinese:    ptr("进击的巨人"),
		DescriptionCN:   ptr("人类得以自由移动。"),
		TitleHant:       ptr("人手訂的名字"),
		TitleHantSource: ptr(srcManual),
		DescHant:        ptr("人手訂的簡介"),
		DescHantSource:  ptr(srcManual),
	}

	if !isManual(row.TitleHantSource) || !isManual(row.DescHantSource) {
		t.Fatal("isManual failed on a manual row")
	}

	results := classifyAll(r, []animeRow{row})
	got := results[0]
	if !got.titleManual || !got.descManual {
		t.Fatal("classifyAll did not flag the row as manual")
	}
	if got.title.Source != "" || got.desc.Source != "" {
		t.Fatalf("the ladder ran on a manual row: title=%q desc=%q", got.title.Source, got.desc.Source)
	}
	if got.titleChanged || got.descChanged {
		t.Fatal("a manual row must never be marked as changed")
	}

	titles, descs := writable(results, false)
	if len(titles) != 0 || len(descs) != 0 {
		t.Fatalf("manual rows reached the write set: %d titles, %d descriptions", len(titles), len(descs))
	}

	// It is still counted, not silently dropped, so an operator can see
	// how much of the table is hand-maintained.
	rep := buildReport(r, results, false)
	if rep.Title.ManualUntouched != 1 || rep.Title.ProposedSources[srcManual] != 1 {
		t.Fatalf("manual row missing from the report: %+v", rep.Title)
	}
	if isManual(nil) {
		t.Fatal("a NULL source is not manual")
	}
}

// ─── change detection ────────────────────────────────────────────────────────

func TestDiffersComparesTheWholeTriple(t *testing.T) {
	d := decision{Source: srcAnilist, Value: "星際牛仔", Hash: hashOf("星際牛仔")}

	if differs(d, ptr("星際牛仔"), ptr(srcAnilist), ptr(hashOf("星際牛仔"))) {
		t.Error("an identical triple is not a change")
	}
	if !differs(d, nil, nil, nil) {
		t.Error("an empty column is a change")
	}
	if !differs(d, ptr("星際牛仔"), ptr(srcOpenCC), ptr(hashOf("星際牛仔"))) {
		t.Error("a promotion from opencc to anilist is a change even when the text matches")
	}
	if !differs(d, ptr("星際牛仔"), ptr(srcAnilist), nil) {
		t.Error("a missing hash is a change — the provenance is incomplete")
	}
	if !differs(d, ptr("星際牛仔"), ptr(srcAnilist), ptr("stale")) {
		t.Error("a stale hash is a change")
	}
}

// ─── staleness ───────────────────────────────────────────────────────────────

// The case migration 0022 was written for: the Bangumi enrichment
// rewrites title_chinese and the machine conversion above it keeps
// claiming to be derived from the old value.
func TestCheckStaleDetectsDriftedInput(t *testing.T) {
	r := testLadder(t)

	fresh := animeRow{
		AnilistID:       999999,
		TitleChinese:    ptr("鬼灭之刃"),
		TitleHant:       ptr("鬼滅之刃"),
		TitleHantSource: ptr(srcOpenCC),
		TitleHantHash:   ptr(hashOf("鬼灭之刃")),
	}
	if got := r.checkStale(fresh, fresh.TitleHant, fresh.TitleHantSource, fresh.TitleHantHash); got != staleNone {
		t.Fatalf("a matching hash reported %q", got)
	}

	drifted := fresh
	drifted.TitleChinese = ptr("鬼灭之刃 无限列车篇")
	if got := r.checkStale(drifted, drifted.TitleHant, drifted.TitleHantSource, drifted.TitleHantHash); got != staleHash {
		t.Fatalf("drifted title_chinese reported %q, want %q", got, staleHash)
	}

	gone := fresh
	gone.TitleChinese = nil
	if got := r.checkStale(gone, gone.TitleHant, gone.TitleHantSource, gone.TitleHantHash); got != staleGone {
		t.Fatalf("a nulled input reported %q, want %q", got, staleGone)
	}

	unhashed := fresh
	unhashed.TitleHantHash = nil
	if got := r.checkStale(unhashed, unhashed.TitleHant, unhashed.TitleHantSource, unhashed.TitleHantHash); got != staleMissingHash {
		t.Fatalf("a value with no hash reported %q, want %q", got, staleMissingHash)
	}
}

// A human's decision has no input to re-derive, so a NULL hash on a
// manual row is correct rather than missing.
func TestManualIsNeverStale(t *testing.T) {
	r := testLadder(t)
	row := animeRow{
		AnilistID:       999999,
		TitleHant:       ptr("人手訂的名字"),
		TitleHantSource: ptr(srcManual),
		DescHant:        ptr("人手訂的簡介"),
		DescHantSource:  ptr(srcManual),
	}
	if got := r.checkStale(row, row.TitleHant, row.TitleHantSource, row.TitleHantHash); got != staleNone {
		t.Fatalf("manual title reported %q", got)
	}
	if got := r.checkDescriptionStale(row); got != staleNone {
		t.Fatalf("manual description reported %q", got)
	}
}

// The dataset tiers go stale too: upstream renames a title and the stored
// value silently stops matching the file it claims to come from.
func TestCheckStaleFollowsTheClaimedSource(t *testing.T) {
	r := testLadder(t)

	row := animeRow{
		AnilistID:       1,
		TitleHant:       ptr("星際牛仔"),
		TitleHantSource: ptr(srcAnilist),
		TitleHantHash:   ptr(hashOf("舊的譯名")), // what upstream used to say
	}
	if got := r.checkStale(row, row.TitleHant, row.TitleHantSource, row.TitleHantHash); got != staleHash {
		t.Fatalf("got %q, want %q", got, staleHash)
	}

	// An id the dataset no longer carries.
	dropped := row
	dropped.AnilistID = 4242424
	if got := r.checkStale(dropped, dropped.TitleHant, dropped.TitleHantSource, dropped.TitleHantHash); got != staleGone {
		t.Fatalf("got %q, want %q", got, staleGone)
	}

	// A row with no stored value cannot be stale.
	if got := r.checkStale(animeRow{}, nil, ptr(srcAnilist), nil); got != staleNone {
		t.Fatalf("an empty column reported %q", got)
	}
}

func TestCheckDescriptionStale(t *testing.T) {
	r := testLadder(t)
	base := animeRow{
		DescriptionCN:  ptr("人类得以自由移动。"),
		DescHant:       ptr("人類得以自由移動。"),
		DescHantSource: ptr(srcOpenCC),
		DescHantHash:   ptr(hashOf("人类得以自由移动。")),
	}
	if got := r.checkDescriptionStale(base); got != staleNone {
		t.Fatalf("got %q, want fresh", got)
	}
	drifted := base
	drifted.DescriptionCN = ptr("人类得以在太阳系内自由移动。")
	if got := r.checkDescriptionStale(drifted); got != staleHash {
		t.Fatalf("got %q, want %q", got, staleHash)
	}
}

// --restale narrows what gets written; it does not change what gets
// resolved.  An operator repairing drift must not also get a tier
// promotion they did not ask for.
func TestRestaleNarrowsTheWriteSet(t *testing.T) {
	r := testLadder(t)

	stale := animeRow{
		AnilistID:       999999,
		TitleChinese:    ptr("鬼灭之刃"),
		TitleHant:       ptr("鬼滅之刃(舊)"),
		TitleHantSource: ptr(srcOpenCC),
		TitleHantHash:   ptr(hashOf("別的東西")),
	}
	unfilled := animeRow{AnilistID: 1, TitleChinese: ptr("星际牛仔")}

	results := classifyAll(r, []animeRow{stale, unfilled})

	all, _ := writable(results, false)
	if len(all) != 2 {
		t.Fatalf("without --restale both rows are writable, got %d", len(all))
	}

	only, _ := writable(results, true)
	if len(only) != 1 {
		t.Fatalf("with --restale only the stale row is writable, got %d", len(only))
	}
	if only[0].row.AnilistID != 999999 {
		t.Fatalf("--restale selected anilist_id %d", only[0].row.AnilistID)
	}
}

// ─── the write pivot ─────────────────────────────────────────────────────────

// columns feeds four parallel arrays into an unnest join.  A length or
// order mismatch would write one row's title onto another row's id, so
// the alignment is worth an assertion of its own.
func TestColumnsKeepsArraysAligned(t *testing.T) {
	rows := []rowResult{
		{row: animeRow{AnilistID: 1}, title: decision{Source: srcAnilist, Value: "星際牛仔", Hash: "h1"}},
		{row: animeRow{AnilistID: 2}, title: decision{Source: srcOpenCC, Value: "鬼滅之刃", Hash: "h2"}},
	}
	ids, values, sources, hashes := columns(rows, func(r rowResult) decision { return r.title })

	if len(ids) != 2 || len(values) != 2 || len(sources) != 2 || len(hashes) != 2 {
		t.Fatalf("array lengths differ: %d/%d/%d/%d", len(ids), len(values), len(sources), len(hashes))
	}
	for i, want := range []struct {
		id             int32
		value, src, hs string
	}{
		{1, "星際牛仔", srcAnilist, "h1"},
		{2, "鬼滅之刃", srcOpenCC, "h2"},
	} {
		if ids[i] != want.id || values[i] != want.value || sources[i] != want.src || hashes[i] != want.hs {
			t.Fatalf("index %d = (%d,%q,%q,%q), want (%d,%q,%q,%q)",
				i, ids[i], values[i], sources[i], hashes[i], want.id, want.value, want.src, want.hs)
		}
	}
}

// The arrays are aligned by construction, which is exactly why the guard
// is worth having: it costs four comparisons and converts a silent NULL
// write into a refusal if that ever stops being true.
func TestCheckAlignedRefusesRaggedArrays(t *testing.T) {
	ids := []int32{1, 2}
	ok := []string{"a", "b"}

	if err := checkAligned(ids, ok, ok, ok); err != nil {
		t.Fatalf("equal lengths rejected: %v", err)
	}
	if err := checkAligned(nil, nil, nil, nil); err != nil {
		t.Fatalf("empty batch rejected: %v", err)
	}

	short := []string{"a"}
	for name, args := range map[string][3][]string{
		"short values":  {short, ok, ok},
		"short sources": {ok, short, ok},
		"short hashes":  {ok, ok, short},
	} {
		t.Run(name, func(t *testing.T) {
			if err := checkAligned(ids, args[0], args[1], args[2]); err == nil {
				t.Fatal("a ragged batch must be refused — Postgres pads with NULL instead of failing")
			}
		})
	}
}

// applyBatches sums what the database actually changed rather than what it
// was offered, and stops at a batch boundary when the context is done.
func TestApplyBatchesCountsAndCancels(t *testing.T) {
	t.Run("sums reported rows across batches", func(t *testing.T) {
		var seen [][2]int
		got, err := applyBatches(context.Background(), applyBatchSize+7, func(start, end int) (int64, error) {
			seen = append(seen, [2]int{start, end})
			return int64(end - start), nil
		})
		if err != nil {
			t.Fatalf("applyBatches: %v", err)
		}
		if got != int64(applyBatchSize+7) {
			t.Fatalf("written = %d, want %d", got, applyBatchSize+7)
		}
		want := [][2]int{{0, applyBatchSize}, {applyBatchSize, applyBatchSize + 7}}
		if !reflect.DeepEqual(seen, want) {
			t.Fatalf("batches = %v, want %v", seen, want)
		}
	})

	t.Run("reports fewer rows when the manual guard skips some", func(t *testing.T) {
		got, err := applyBatches(context.Background(), 10, func(_, _ int) (int64, error) {
			return 7, nil // three rows matched the WHERE clause's manual guard
		})
		if err != nil || got != 7 {
			t.Fatalf("written = %d err = %v, want 7 — the count must be the database's, not the caller's", got, err)
		}
	})

	t.Run("stops before the next batch when cancelled", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		calls := 0
		got, err := applyBatches(ctx, applyBatchSize*3, func(start, end int) (int64, error) {
			calls++
			cancel() // an operator hitting Ctrl-C during the first batch
			return int64(end - start), nil
		})
		if err == nil {
			t.Fatal("cancellation must surface as an error, not a silent short write")
		}
		if calls != 1 {
			t.Fatalf("ran %d batches after cancellation, want 1", calls)
		}
		if got != int64(applyBatchSize) {
			t.Fatalf("written = %d, want the one completed batch (%d)", got, applyBatchSize)
		}
	})
}

// Every source this tool writes must be in migration 0022's CHECK
// vocabulary, or --apply fails at the database with a constraint
// violation halfway through a batch.
func TestWrittenSourcesAreInTheCheckVocabulary(t *testing.T) {
	titleAllowed := map[string]bool{srcWikipedia: true, srcAnilist: true, srcOpenCC: true, srcManual: true}
	descAllowed := map[string]bool{srcOpenCC: true, srcManual: true}

	r := testLadder(t)
	rows := []animeRow{
		{AnilistID: 16498, TitleNative: ptr("進撃の巨人"), DescriptionCN: ptr("简介。")},
		{AnilistID: 1, TitleChinese: ptr("星际牛仔")},
		{AnilistID: 999999, TitleChinese: ptr("鬼灭之刃")},
	}
	for _, res := range classifyAll(r, rows) {
		if res.title.Source != "" && !titleAllowed[res.title.Source] {
			t.Errorf("title_hant_source %q is not in the CHECK vocabulary", res.title.Source)
		}
		if res.desc.Source != "" && !descAllowed[res.desc.Source] {
			t.Errorf("description_hant_source %q is not in the CHECK vocabulary", res.desc.Source)
		}
	}
}
