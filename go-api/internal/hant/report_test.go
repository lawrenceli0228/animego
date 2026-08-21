package hant

// report.go is the half of this tool an operator reads.  --apply is four
// statements; the summary on screen and hant-report.json beside it are
// what make running them a decision rather than a leap.  Every test below
// pins something that, if it broke, would break quietly -- a count that no
// longer adds up, a percentage rendered as NaN, a rejection queue that
// never reached the file -- while the run still exited 0 and printed a
// summary that looked fine.
//
// Nothing here touches Postgres or the vendored files.  BuildReport reads
// exactly two things off the Resolver (the CGroup key counts and the
// anilist record behind a rejected id), so the tests hand it a Resolver
// built in place rather than the 8,492-record dataset, which keeps the
// assertions about the report instead of about the data.

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// ─── fixtures ────────────────────────────────────────────────────────────────

// reportResolver is the slice of *Resolver that BuildReport actually
// reads: len(cgroup.byKey), cgroup.Dropped, and anilist.byID for the
// titles behind Simplified rejections.
func reportResolver(t *testing.T, usableKeys int, dropped []string, records ...anilistRecord) *Resolver {
	t.Helper()
	keys := make(map[string]string, usableKeys)
	for i := range usableKeys {
		keys[fmt.Sprintf("key%d", i)] = fmt.Sprintf("香港譯名%d", i)
	}
	byID := make(map[int32]anilistRecord, len(records))
	for _, rec := range records {
		byID[rec.ID] = rec
	}
	return &Resolver{
		cgroup:  &cgroupSet{byKey: keys, Dropped: dropped},
		anilist: &anilistSet{byID: byID},
	}
}

// acceptedTitle is a row whose anilist record passed the gate.
func acceptedTitle(id int32, stored string, value string) RowResult {
	r := RowResult{Row: Row{AnilistID: id}}
	if stored != "" {
		r.Row.TitleHantSource = ptr(stored)
	}
	r.Title = Decision{
		Source:        SrcAnilist,
		Value:         value,
		Hash:          SourceHash(value),
		PickAttempted: true,
		Pick:          AnilistPick{Value: value},
	}
	r.TitleChanged = true
	return r
}

// rejectedTitle is a row whose anilist title was dropped by one gate rule.
// rescue is the synonym that stood in, empty when nothing did.
func rejectedTitle(id int32, reason RejectReason, bad []rune, rescue string) RowResult {
	r := RowResult{Row: Row{AnilistID: id}}
	r.Title = Decision{
		PickAttempted: true,
		Pick: AnilistPick{
			TitleReason:     reason,
			TitleSimplified: bad,
			Value:           rescue,
			FromSynonym:     rescue != "",
		},
	}
	if rescue != "" {
		r.Title.Source = SrcAnilist
		r.Title.Value = rescue
		r.TitleChanged = true
	}
	return r
}

// writeReportJSON encodes a Report to disk the way cmd/hantbackfill's
// writeJSON does: indented, HTML escaping off.
//
// Spelled out here rather than imported because that writer belongs to
// the CLI — it also writes the pre-apply backup, whose fsync-and-check-
// Close contract is the CLI's alone and is pinned by its own tests over
// there, including the one that holds SetEscapeHTML(false).  What this
// test needs is bytes on disk to assert the Report's own tags and
// ordering against.
func writeReportJSON(t *testing.T, path string, v any) {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	enc := json.NewEncoder(f)
	enc.SetIndent("", "  ")
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		t.Fatal(err)
	}
}

// ─── pct ─────────────────────────────────────────────────────────────────────

// Prevents: a summary that reads "NaN%" or "+Inf%" in the column an
// operator is checking before typing --apply.
//
// Every percentage is over rep.TotalRows, which is zero on a run that
// matched no rows -- an empty anime_cache, a --data pointing somewhere
// with nothing behind it, a wrapper that resolved --limit to 0.  Go's
// float division does not panic on a zero denominator; it yields NaN for
// 0/0 and ±Inf otherwise, and both render happily through %7.1f.
func TestPctNeverProducesNaNOrInfinity(t *testing.T) {
	cases := []struct {
		name     string
		n, total int
		want     float64
	}{
		{"no rows scanned at all", 0, 0, 0},          // 0/0 is NaN
		{"a count with no total behind it", 5, 0, 0}, // 5/0 is +Inf
		{"none of them", 0, 10, 0},
		{"a tenth", 1, 10, 10},
		{"a third", 1, 3, 100.0 / 3},
		{"all of them", 10, 10, 100},
		{"a single row", 1, 1, 100},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := pct(tc.n, tc.total)

			if math.IsNaN(got) {
				t.Fatalf("pct(%d, %d) is NaN; it renders as NaN%% in the summary", tc.n, tc.total)
			}
			if math.IsInf(got, 0) {
				t.Fatalf("pct(%d, %d) is %v; it renders as +Inf%% in the summary", tc.n, tc.total, got)
			}
			if math.Abs(got-tc.want) > 1e-9 {
				t.Errorf("pct(%d, %d) = %v, want %v", tc.n, tc.total, got, tc.want)
			}
			// Rendered through the format the summary actually uses, so a
			// future guard that returns something unprintable is caught here
			// rather than on an operator's terminal.
			if s := fmt.Sprintf("%7.1f%%", got); strings.ContainsAny(s, "NI") {
				t.Errorf("pct(%d, %d) renders as %q", tc.n, tc.total, s)
			}
		})
	}
}

// ─── tally ───────────────────────────────────────────────────────────────────

// Prevents: a row landing in no bucket, or in two.
//
// These counts are the whole basis for deciding whether to apply.  A tally
// that drops a row does not look like a bug: it looks like a clean run
// over a slightly smaller table.
func TestTallyCountsEveryTier(t *testing.T) {
	cases := []struct {
		name            string
		storedSource    *string
		d               Decision
		manual, changed bool
		stale           StaleKind

		wantStored          map[string]int
		wantProposed        map[string]int
		wantWouldChange     int
		wantManualUntouched int
		wantStale           map[string]int
	}{
		{
			// Nothing has ever written this column, and the ladder reached
			// none of its tiers.  Both sides still have to count it.
			name:         "no stored source and no proposal",
			wantStored:   map[string]int{"none": 1},
			wantProposed: map[string]int{"none": 1},
		},
		{
			name:         "stored none, the tail proposes something",
			d:            Decision{Source: SrcOpenCC, Value: "簡介"},
			changed:      true,
			wantStored:   map[string]int{"none": 1},
			wantProposed: map[string]int{SrcOpenCC: 1},

			wantWouldChange: 1,
		},
		{
			name:         "the Hong Kong overlay promotes a machine conversion",
			storedSource: ptr(SrcOpenCC),
			d:            Decision{Source: SrcWikipedia, Value: "心之谷"},
			changed:      true,
			wantStored:   map[string]int{SrcOpenCC: 1},
			wantProposed: map[string]int{SrcWikipedia: 1},

			wantWouldChange: 1,
		},
		{
			// Re-proposing what is already stored is not a change, and
			// counting it as one would inflate the number an operator reads
			// as "rows this run will rewrite".
			name:         "the ladder proposes what is already there",
			storedSource: ptr(SrcAnilist),
			d:            Decision{Source: SrcAnilist, Value: "星際牛仔"},
			wantStored:   map[string]int{SrcAnilist: 1},
			wantProposed: map[string]int{SrcAnilist: 1},
		},
		{
			// The invariant the whole tool rests on.  changed is true here
			// on purpose: even if something upstream proposed a rewrite, a
			// manual row is untouched and must not be counted as a write.
			name:         "a manual row is never a write, whatever was proposed",
			storedSource: ptr(SrcManual),
			d:            Decision{Source: SrcAnilist, Value: "重寫"},
			manual:       true,
			changed:      true,
			wantStored:   map[string]int{SrcManual: 1},
			wantProposed: map[string]int{SrcManual: 1},

			wantManualUntouched: 1,
		},
		{
			name:         "a stored value whose input moved underneath it",
			storedSource: ptr(SrcOpenCC),
			d:            Decision{Source: SrcOpenCC, Value: "新簡介"},
			changed:      true,
			stale:        StaleHash,
			wantStored:   map[string]int{SrcOpenCC: 1},
			wantProposed: map[string]int{SrcOpenCC: 1},

			wantWouldChange: 1,
			wantStale:       map[string]int{string(StaleHash): 1},
		},
		{
			// Staleness is orthogonal to the manual guard: a hand-written
			// row can still be flagged, and must still not be rewritten.
			name:         "a manual row can be stale and is still untouched",
			storedSource: ptr(SrcManual),
			manual:       true,
			stale:        StaleGone,
			wantStored:   map[string]int{SrcManual: 1},
			wantProposed: map[string]int{SrcManual: 1},

			wantManualUntouched: 1,
			wantStale:           map[string]int{string(StaleGone): 1},
		},
		{
			name:         "a source with no hash behind it",
			storedSource: ptr(SrcWikipedia),
			d:            Decision{Source: SrcWikipedia, Value: "心之谷"},
			stale:        StaleMissingHash,
			wantStored:   map[string]int{SrcWikipedia: 1},
			wantProposed: map[string]int{SrcWikipedia: 1},

			wantStale: map[string]int{string(StaleMissingHash): 1},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := newColumnReport()
			tally(&c, tc.storedSource, tc.d, tc.manual, tc.changed, tc.stale)

			if !reflect.DeepEqual(c.StoredSources, tc.wantStored) {
				t.Errorf("StoredSources = %v, want %v", c.StoredSources, tc.wantStored)
			}
			if !reflect.DeepEqual(c.ProposedSources, tc.wantProposed) {
				t.Errorf("ProposedSources = %v, want %v", c.ProposedSources, tc.wantProposed)
			}
			if c.WouldChange != tc.wantWouldChange {
				t.Errorf("WouldChange = %d, want %d", c.WouldChange, tc.wantWouldChange)
			}
			if c.ManualUntouched != tc.wantManualUntouched {
				t.Errorf("ManualUntouched = %d, want %d", c.ManualUntouched, tc.wantManualUntouched)
			}
			wantStale := tc.wantStale
			if wantStale == nil {
				wantStale = map[string]int{}
			}
			if !reflect.DeepEqual(c.Stale, wantStale) {
				t.Errorf("Stale = %v, want %v", c.Stale, wantStale)
			}
		})
	}
}

// Prevents: a tally whose parts do not sum to the whole.
//
// That is the failure worth catching, because it does not announce
// itself: the run exits 0, the summary prints, and the only symptom is
// that the numbers quietly describe fewer rows than were scanned.  Every
// call has to land in exactly one stored bucket and exactly one proposed
// bucket, including the manual path that returns early.
func TestTallyPartsSumToTheWhole(t *testing.T) {
	rows := []struct {
		stored  *string
		d       Decision
		manual  bool
		changed bool
		stale   StaleKind
	}{
		{stored: nil},
		{stored: nil, d: Decision{Source: SrcOpenCC}, changed: true},
		{stored: ptr(SrcOpenCC), d: Decision{Source: SrcAnilist}, changed: true, stale: StaleHash},
		{stored: ptr(SrcAnilist), d: Decision{Source: SrcAnilist}},
		{stored: ptr(SrcWikipedia), d: Decision{Source: SrcWikipedia}},
		{stored: ptr(SrcManual), manual: true},
		{stored: ptr(SrcManual), d: Decision{Source: SrcAnilist}, manual: true, changed: true},
		{stored: ptr("something a later migration added"), d: Decision{}},
	}

	c := newColumnReport()
	for _, r := range rows {
		tally(&c, r.stored, r.d, r.manual, r.changed, r.stale)
	}

	sum := func(m map[string]int) int {
		total := 0
		for _, n := range m {
			total += n
		}
		return total
	}
	if got := sum(c.StoredSources); got != len(rows) {
		t.Errorf("stored buckets hold %d rows, want %d — %d rows are unaccounted for", got, len(rows), len(rows)-got)
	}
	if got := sum(c.ProposedSources); got != len(rows) {
		t.Errorf("proposed buckets hold %d rows, want %d — %d rows are unaccounted for", got, len(rows), len(rows)-got)
	}
	// The manual tier is only ever proposed by the early return, so the two
	// numbers are the same number seen twice.  If they ever diverge, one of
	// them is counting something it should not.
	if c.ProposedSources[SrcManual] != c.ManualUntouched {
		t.Errorf("proposed manual = %d but ManualUntouched = %d", c.ProposedSources[SrcManual], c.ManualUntouched)
	}
	if c.ManualUntouched != 2 {
		t.Errorf("ManualUntouched = %d, want 2", c.ManualUntouched)
	}
	// An unknown stored source is passed through rather than folded into
	// "none": a value this tool does not recognise is exactly what an
	// operator needs to see, not something to round off.
	if c.StoredSources["something a later migration added"] != 1 {
		t.Errorf("an unrecognised stored source was not counted under its own name: %v", c.StoredSources)
	}
}

// ─── BuildReport ─────────────────────────────────────────────────────────────

// Both columns are tallied for every result, so each column's buckets
// have to hold exactly TotalRows rows.  A column that holds fewer means
// the run skipped rows it reported as scanned.
func TestBuildReportAccountsForEveryRowInBothColumns(t *testing.T) {
	r := reportResolver(t, 3, nil, anilistRecord{ID: 5, Title: "秘密"})

	results := []RowResult{
		acceptedTitle(1, SrcOpenCC, "星際牛仔"),
		rejectedTitle(2, ReasonKana, nil, ""),
		rejectedTitle(5, ReasonSimplified, []rune("秘"), "秘密の花園"),
		{Row: Row{AnilistID: 3, TitleHantSource: ptr(SrcManual)}, TitleManual: true, DescManual: true},
		{Row: Row{AnilistID: 4}},
	}
	// Give one row a description proposal so the two columns are not
	// accidentally identical.
	results[0].Desc = Decision{Source: SrcOpenCC, Value: "簡介"}
	results[0].DescChanged = true

	rep := BuildReport(r, results, false)

	if rep.TotalRows != len(results) {
		t.Fatalf("TotalRows = %d, want %d", rep.TotalRows, len(results))
	}
	for _, col := range []struct {
		name string
		c    ColumnReport
	}{{"title_hant", rep.Title}, {"description_hant", rep.Description}} {
		stored, proposed := 0, 0
		for _, n := range col.c.StoredSources {
			stored += n
		}
		for _, n := range col.c.ProposedSources {
			proposed += n
		}
		if stored != rep.TotalRows {
			t.Errorf("%s stored buckets hold %d of %d rows", col.name, stored, rep.TotalRows)
		}
		if proposed != rep.TotalRows {
			t.Errorf("%s proposed buckets hold %d of %d rows", col.name, proposed, rep.TotalRows)
		}
	}
}

// Prevents: gate counts that do not reconcile.
//
// gate.check reports the *first* matching rule precisely so that the
// per-rule counts add up to the rejection total.  If accepted + rejected
// stops equalling the rows the dataset had a record for, the report is
// claiming an outcome for rows it never classified — and the rejection
// figure is what an operator uses to judge how much SERP-eligible title
// coverage the gate is costing.
func TestBuildReportGateCountsReconcile(t *testing.T) {
	r := reportResolver(t, 2, nil,
		anilistRecord{ID: 30, Title: "秘密"},
		anilistRecord{ID: 40, Title: "群山"},
	)

	results := []RowResult{
		acceptedTitle(10, "", "星際牛仔"),
		acceptedTitle(11, "", "進擊的巨人"),
		rejectedTitle(20, ReasonKana, nil, "第一神拳"), // rescued
		rejectedTitle(21, ReasonKana, nil, ""),     // not rescued
		rejectedTitle(22, ReasonNoHan, nil, "犬夜叉"), // rescued
		rejectedTitle(30, ReasonSimplified, []rune("秘"), ""),
		rejectedTitle(40, ReasonSimplified, []rune("群"), "群山傳說"),
		rejectedTitle(50, ReasonEmpty, nil, ""),
		// No dataset record at all: PickAttempted stays false, so this row
		// must not appear in any gate number.
		{Row: Row{AnilistID: 60}},
	}

	rep := BuildReport(r, results, false)

	if rep.Gate.AnilistRecordsMatched != 8 {
		t.Fatalf("AnilistRecordsMatched = %d, want the 8 rows the dataset had a record for", rep.Gate.AnilistRecordsMatched)
	}
	rejected := 0
	for _, n := range rep.Gate.TitleRejected {
		rejected += n
	}
	if got := rep.Gate.TitleAccepted + rejected; got != rep.Gate.AnilistRecordsMatched {
		t.Errorf("accepted (%d) + rejected (%d) = %d, want %d — some matched row was classified as neither",
			rep.Gate.TitleAccepted, rejected, got, rep.Gate.AnilistRecordsMatched)
	}
	// Every rejection is either rescued by a synonym or leaves the row with
	// no usable candidate.  There is no third outcome, and a row counted in
	// both would double-count the cost of the gate.
	rescued := 0
	for _, n := range rep.Gate.RescuedBySynonym {
		rescued += n
	}
	if got := rescued + rep.Gate.NoUsableCandidate; got != rejected {
		t.Errorf("rescued (%d) + no usable candidate (%d) = %d, want the %d rejections",
			rescued, rep.Gate.NoUsableCandidate, got, rejected)
	}

	wantRejected := map[string]int{"kana": 2, "no_han": 1, "simplified": 2, "empty": 1}
	if !reflect.DeepEqual(rep.Gate.TitleRejected, wantRejected) {
		t.Errorf("TitleRejected = %v, want %v", rep.Gate.TitleRejected, wantRejected)
	}
	wantRescued := map[string]int{"kana": 1, "no_han": 1, "simplified": 1}
	if !reflect.DeepEqual(rep.Gate.RescuedBySynonym, wantRescued) {
		t.Errorf("RescuedBySynonym = %v, want %v", rep.Gate.RescuedBySynonym, wantRescued)
	}
}

// The CGroup join side is counted for every row that hit the overlay, and
// the key figures come off the loaded set rather than being recomputed —
// they are how an operator tells a shrinking overlay from a shrinking
// table.
func TestBuildReportCarriesTheOverlayFigures(t *testing.T) {
	dropped := []string{"心之谷", "ハングリーハート wild striker"}
	r := reportResolver(t, 917, dropped)

	results := []RowResult{
		{Row: Row{AnilistID: 1}, Title: Decision{Source: SrcWikipedia, Via: "title_native"}},
		{Row: Row{AnilistID: 2}, Title: Decision{Source: SrcWikipedia, Via: "title_native"}},
		{Row: Row{AnilistID: 3}, Title: Decision{Source: SrcWikipedia, Via: "title_chinese"}},
		{Row: Row{AnilistID: 4}},
	}
	rep := BuildReport(r, results, false)

	if rep.Gate.CgroupKeysUsable != 917 {
		t.Errorf("CgroupKeysUsable = %d, want 917", rep.Gate.CgroupKeysUsable)
	}
	if !reflect.DeepEqual(rep.Gate.CgroupKeysDropped, dropped) {
		t.Errorf("CgroupKeysDropped = %v, want %v", rep.Gate.CgroupKeysDropped, dropped)
	}
	want := map[string]int{"title_native": 2, "title_chinese": 1}
	if !reflect.DeepEqual(rep.Gate.CgroupHitsVia, want) {
		t.Errorf("CgroupHitsVia = %v, want %v", rep.Gate.CgroupHitsVia, want)
	}
}

// Prevents: the promotion queue being silently dropped from the file.
//
// simplified_rejections is the record a human works from when promoting
// titles to source='manual'.  Losing it — a nil map, a field that stops
// marshalling, an entry that loses the offending characters — makes the
// gate unauditable: the rows are still rejected, and nobody can find out
// which ones or why.  So the assertion is on the bytes on disk, written
// the way the tool writes them, not on the struct in memory.
func TestBuildReportWritesTheRejectionQueueToTheFile(t *testing.T) {
	r := reportResolver(t, 4, nil,
		anilistRecord{ID: 42, Title: "秘密結社"},
		anilistRecord{ID: 7, Title: "群青之海"},
	)

	results := []RowResult{
		// Out of id order, and the same id twice: the list is a queue keyed
		// by anime, not by row.
		rejectedTitle(42, ReasonSimplified, []rune("秘"), ""),
		rejectedTitle(7, ReasonSimplified, []rune("群"), "群青之海 <外傳>"),
		rejectedTitle(42, ReasonSimplified, []rune("秘"), ""),
		// Rejected by a different rule: not part of this queue.
		rejectedTitle(9, ReasonKana, nil, ""),
		acceptedTitle(1, "", "星際牛仔"),
	}
	rep := BuildReport(r, results, false)

	if len(rep.SimplifiedRejections) != 2 {
		t.Fatalf("SimplifiedRejections = %+v, want one entry per anime", rep.SimplifiedRejections)
	}

	path := filepath.Join(t.TempDir(), "hant-report.json")
	writeReportJSON(t, path, rep)
	blob, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var got Report
	if err := json.Unmarshal(blob, &got); err != nil {
		t.Fatalf("the report is not readable JSON: %v", err)
	}

	want := []SimplifiedRejection{
		// Ascending id, so two runs over the same table diff cleanly.
		{AnilistID: 7, Title: "群青之海", BadChars: "群", Rescued: "群青之海 <外傳>", Applied: SrcAnilist},
		{AnilistID: 42, Title: "秘密結社", BadChars: "秘"},
	}
	if !reflect.DeepEqual(got.SimplifiedRejections, want) {
		t.Fatalf("the queue did not survive the round trip:\n got %+v\nwant %+v", got.SimplifiedRejections, want)
	}
	// The dataset title is the thing a human searches for, so it has to be
	// readable in the file rather than escaped into numeric entities.
	if !strings.Contains(string(blob), "群青之海 <外傳>") {
		t.Errorf("the rescued title is HTML-escaped in the file; it is meant to be read by a person")
	}
	if got.TotalRows != len(results) || got.RestaleOnly {
		t.Errorf("TotalRows = %d, RestaleOnly = %v, want %d and false", got.TotalRows, got.RestaleOnly, len(results))
	}
	if !got.GeneratedAt.Equal(rep.GeneratedAt) || got.GeneratedAt.IsZero() {
		t.Errorf("GeneratedAt = %v, want the report's own stamp; an undated report cannot be matched to a run", got.GeneratedAt)
	}
	if time.Since(rep.GeneratedAt) > time.Hour || rep.GeneratedAt.Location() != time.UTC {
		t.Errorf("GeneratedAt = %v, want a recent UTC stamp", rep.GeneratedAt)
	}
}

// The histogram is what tells an operator that half the queue is one
// orthographic disagreement repeated rather than 400 separate problems,
// which only works if the frequent characters are at the top.  The
// alphabetical tiebreak keeps two runs over the same table comparable.
func TestBuildReportOrdersTheHistogramByFrequency(t *testing.T) {
	var records []anilistRecord
	var results []RowResult
	add := func(id int32, bad string) {
		records = append(records, anilistRecord{ID: id, Title: "標題" + bad})
		results = append(results, rejectedTitle(id, ReasonSimplified, []rune(bad), ""))
	}
	// 温 three times, 峰 and 痴 once each — 峰 sorts before 痴.
	add(1, "温")
	add(2, "痴")
	add(3, "温")
	add(4, "峰")
	add(5, "温")

	rep := BuildReport(reportResolver(t, 1, nil, records...), results, false)

	want := []CharCount{{Chars: "温", Count: 3}, {Chars: "峰", Count: 1}, {Chars: "痴", Count: 1}}
	if !reflect.DeepEqual(rep.SimplifiedRejectionChars, want) {
		t.Fatalf("histogram = %+v, want %+v (count descending, then chars ascending)", rep.SimplifiedRejectionChars, want)
	}
	// The histogram counts anime, not rows, so it has to agree with the
	// queue it summarises.
	total := 0
	for _, cc := range rep.SimplifiedRejectionChars {
		total += cc.Count
	}
	if total != len(rep.SimplifiedRejections) {
		t.Errorf("histogram covers %d rejections, the queue holds %d", total, len(rep.SimplifiedRejections))
	}
}

// Prevents: a report whose maps marshal as null.
//
// A run over an empty table is the one an operator is most likely to feed
// to a script, and `"stored_sources": null` is not the same document as
// `"stored_sources": {}` to anything that reads it.  newColumnReport and
// BuildReport's map literals are what keep them apart.
func TestBuildReportOnAnEmptyRunStillHasObjects(t *testing.T) {
	rep := BuildReport(reportResolver(t, 0, nil), nil, true)

	blob, err := json.Marshal(rep)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, key := range []string{
		`"stored_sources":{}`,
		`"proposed_sources":{}`,
		`"stale":{}`,
		`"anilist_title_rejected_by_rule":{}`,
		`"anilist_rescued_by_synonym":{}`,
		`"cgroup_hits_via":{}`,
	} {
		if !strings.Contains(string(blob), key) {
			t.Errorf("report is missing %s:\n%s", key, blob)
		}
	}
	if !rep.RestaleOnly {
		t.Error("RestaleOnly did not reach the report, so the file cannot say which mode produced it")
	}
	if rep.TotalRows != 0 {
		t.Errorf("TotalRows = %d, want 0", rep.TotalRows)
	}
}

// ─── printColumn ─────────────────────────────────────────────────────────────

// Prevents: the columns coming apart.
//
// printColumn exists to line five tiers up under one header so they can be
// compared down the page; without the padding it is a list of numbers in
// no particular place.  The golden pins the whole block byte for byte,
// including the tiers that are skipped when both sides are zero.
func TestPrintColumnRendersAlignedColumns(t *testing.T) {
	c := ColumnReport{
		StoredSources:   map[string]int{"none": 6, SrcOpenCC: 2, SrcManual: 1, SrcAnilist: 1},
		ProposedSources: map[string]int{SrcManual: 1, SrcWikipedia: 1, SrcAnilist: 5, SrcOpenCC: 3},
		WouldChange:     7,
		Stale:           map[string]int{string(StaleHash): 2, string(StaleGone): 1},
	}

	want := "\ntitle_hant\n" +
		"  SOURCE         STORED      PCT   PROPOSED      PCT\n" +
		"  ───────────  ────────  ───────   ────────  ───────\n" +
		"  manual              1    10.0%          1    10.0%\n" +
		"  wikipedia           0     0.0%          1    10.0%\n" +
		"  anilist             1    10.0%          5    50.0%\n" +
		"  opencc              2    20.0%          3    30.0%\n" +
		"  none                6    60.0%          0     0.0%\n" +
		"  would change                            7\n" +
		"  stale                                   2  (hash_mismatch)\n" +
		"  stale                                   1  (input_gone)\n"

	var b strings.Builder
	printColumn(&b, "title_hant", 10, c)
	if got := b.String(); got != want {
		t.Fatalf("rendering changed:\n--- got ---\n%s\n--- want ---\n%s", got, want)
	}
}

// The same padding, asserted structurally, so a cosmetic edit that keeps
// the golden honest cannot quietly stop aligning: whatever the source
// names and however many digits the counts have, both percent signs stay
// in the same column on every row.
func TestPrintColumnKeepsThePercentColumnsInLine(t *testing.T) {
	c := ColumnReport{
		// Names of four, six, seven and nine runes; counts of one and five
		// digits.  If either field stopped being padded, these would drift.
		StoredSources:   map[string]int{SrcManual: 1, SrcWikipedia: 12345, SrcAnilist: 7, "none": 100},
		ProposedSources: map[string]int{SrcManual: 12345, SrcWikipedia: 1, SrcAnilist: 700, "none": 9},
	}

	var b strings.Builder
	printColumn(&b, "title_hant", 12453, c)

	var first, last []int
	for _, line := range strings.Split(b.String(), "\n") {
		if !strings.Contains(line, "%") {
			continue
		}
		runes := []rune(line)
		var idx []int
		for i, r := range runes {
			if r == '%' {
				idx = append(idx, i)
			}
		}
		if len(idx) != 2 {
			t.Fatalf("line %q carries %d percent signs, want 2", line, len(idx))
		}
		first = append(first, idx[0])
		last = append(last, idx[1])
	}
	if len(first) != 4 {
		t.Fatalf("rendered %d tier rows, want 4", len(first))
	}
	for i := range first {
		if first[i] != first[0] || last[i] != last[0] {
			t.Fatalf("percent columns drift between rows: firsts %v, lasts %v\n%s", first, last, b.String())
		}
	}
}

// A tier nothing has ever stored and nothing proposes is noise, and five
// tiers of noise is what makes the two that matter hard to find.
func TestPrintColumnOmitsTiersWithNothingOnEitherSide(t *testing.T) {
	c := newColumnReport()
	c.StoredSources["none"] = 3
	c.ProposedSources[SrcOpenCC] = 3

	var b strings.Builder
	printColumn(&b, "description_hant", 3, c)
	got := b.String()

	for _, want := range []string{"description_hant", "opencc", "none"} {
		if !strings.Contains(got, want) {
			t.Errorf("output is missing %q:\n%s", want, got)
		}
	}
	// description_hant admits only 'opencc' and 'manual' (migration 0022),
	// so wikipedia and anilist rows here would be actively misleading.
	for _, unwanted := range []string{SrcWikipedia, SrcAnilist} {
		if strings.Contains(got, "  "+unwanted+" ") {
			t.Errorf("output lists %q, which neither side has any rows in:\n%s", unwanted, got)
		}
	}
	// Nothing is stale, so the stale block is absent entirely rather than
	// printed as three zeroes.
	if strings.Contains(got, "stale") {
		t.Errorf("output has a stale block with nothing in it:\n%s", got)
	}
}

// The zero-row run, rendered.  This is where a NaN would actually reach an
// operator, and it is the run most likely to be misread as "nothing needs
// doing" rather than "nothing was read".
func TestPrintColumnOnAnEmptyRunPrintsNoNaN(t *testing.T) {
	c := newColumnReport()
	c.StoredSources["none"] = 0
	c.ProposedSources[SrcOpenCC] = 0

	var b strings.Builder
	printColumn(&b, "title_hant", 0, c)
	got := b.String()

	for _, bad := range []string{"NaN", "Inf"} {
		if strings.Contains(got, bad) {
			t.Fatalf("output contains %q:\n%s", bad, got)
		}
	}
	if !strings.Contains(got, "would change") {
		t.Errorf("even an empty column has to render its summary line:\n%s", got)
	}
}

// ─── PrintSummary ────────────────────────────────────────────────────────────

// fullReport is a run with something in every block.
func fullReport() Report {
	rep := Report{
		TotalRows:   20,
		Title:       newColumnReport(),
		Description: newColumnReport(),
		Gate: GateReport{
			AnilistRecordsMatched: 14,
			TitleAccepted:         9,
			TitleRejected:         map[string]int{"kana": 3, "simplified": 2},
			RescuedBySynonym:      map[string]int{"kana": 1},
			NoUsableCandidate:     4,
			CgroupHitsVia:         map[string]int{"title_native": 6, "title_chinese": 2},
			CgroupKeysUsable:      917,
			CgroupKeysDropped:     []string{"心之谷", "ハングリーハート"},
		},
		SimplifiedRejections:     []SimplifiedRejection{{AnilistID: 1, Title: "秘密", BadChars: "秘"}},
		SimplifiedRejectionChars: []CharCount{{Chars: "秘", Count: 1}},
	}
	rep.Title.StoredSources["none"] = 20
	rep.Title.ProposedSources[SrcAnilist] = 20
	rep.Title.WouldChange = 20
	rep.Description.StoredSources["none"] = 20
	rep.Description.ProposedSources[SrcOpenCC] = 20
	rep.Description.WouldChange = 20
	return rep
}

// assertOrder checks that each want appears after the one before it.
// Presence alone is not enough: the summary is read top to bottom, and a
// gate figure printed under the CGroup heading is a figure read as the
// wrong thing.
func assertOrder(t *testing.T, got string, want []string) {
	t.Helper()
	at := 0
	for i, w := range want {
		j := strings.Index(got[at:], w)
		if j < 0 {
			after := "the top of the summary"
			if i > 0 {
				after = fmt.Sprintf("%q", want[i-1])
			}
			t.Fatalf("summary has no %q after %s:\n%s", w, after, got)
		}
		at += j + len(w)
	}
}

// Prevents: a block going missing from the thing an operator reads before
// deciding to write to production.
func TestPrintSummaryRendersEveryBlockInOrder(t *testing.T) {
	var b strings.Builder
	PrintSummary(&b, fullReport())
	got := b.String()

	assertOrder(t, got, []string{
		"Rows scanned: 20",
		"title_hant",
		"description_hant",
		"QUALITY GATE",
		"over the 14 non-manual rows",
		"title accepted",
		"title rejected: kana",
		"(1 rescued by synonym)",
		"title rejected: simplified",
		"no usable candidate",
		"CGROUP OVERLAY",
		"usable keys",
		"keys dropped (ambiguous)",
		"hits via title_native",
		"hits via title_chinese",
		"Simplified-rejected dataset titles",
		"promote by hand as source='manual'",
	})

	// The dropped-key figure is a length, not a list: printing 17 raw keys
	// into the summary buries everything under it.  The keys themselves are
	// in the JSON.
	if strings.Contains(got, "心之谷") {
		t.Errorf("the summary dumped the dropped keys instead of counting them:\n%s", got)
	}
	if !strings.Contains(got, "917") {
		t.Errorf("the usable-key count is missing:\n%s", got)
	}

	// Every figure below the gate heading is printed through one
	// "%-28s %8d" so the numbers form a column that can be read down.  The
	// label is padded by runes, so the Han characters in the histogram sit
	// in the same column as the ASCII labels above them — which only holds
	// while both fields keep their widths.
	const lineWidth = 2 + 28 + 1 + 8
	for _, line := range strings.Split(got[strings.Index(got, "QUALITY GATE"):], "\n") {
		if !strings.HasPrefix(line, "  ") {
			continue // the block headings, which are not figures
		}
		runes := []rune(line)
		if len(runes) == 0 || runes[len(runes)-1] < '0' || runes[len(runes)-1] > '9' {
			continue // the lines carrying a parenthesised or "more" suffix
		}
		if len(runes) != lineWidth {
			t.Errorf("figure line %q is %d runes wide, want %d — the numbers no longer line up", line, len(runes), lineWidth)
		}
	}
}

// Prevents: the --restale banner disagreeing with the report beside it.
//
// PrintSummary used to take restaleOnly as a second parameter while
// BuildReport had already recorded the same flag in the report, so the
// banner on screen and the restale_only field in hant-report.json were two
// independent copies of one fact.  It now reads the report.
func TestPrintSummaryTakesTheRestaleBannerFromTheReport(t *testing.T) {
	const banner = "--restale"

	rep := fullReport()
	var off strings.Builder
	PrintSummary(&off, rep)
	if strings.Contains(off.String(), banner) {
		t.Errorf("an ordinary run announced --restale:\n%s", off.String())
	}

	rep.RestaleOnly = true
	var on strings.Builder
	PrintSummary(&on, rep)
	if !strings.Contains(on.String(), banner) {
		t.Errorf("a --restale run did not say so; only stale rows are writable and the counts below mean something different:\n%s", on.String())
	}
	if !strings.Contains(on.String(), "stale source hash") {
		t.Errorf("the banner does not explain what it narrowed to:\n%s", on.String())
	}
}

// A rule that fired zero times is not evidence of anything, and four of
// them push the two that fired off the top of the block.
func TestPrintSummaryOmitsGateRulesThatDidNotFire(t *testing.T) {
	rep := fullReport()
	rep.Gate.TitleRejected = map[string]int{"simplified": 5, "kana": 0}

	var b strings.Builder
	PrintSummary(&b, rep)
	got := b.String()

	if !strings.Contains(got, "title rejected: simplified") {
		t.Errorf("a rule that fired 5 times is missing:\n%s", got)
	}
	for _, unwanted := range []string{"title rejected: kana", "title rejected: no_han", "title rejected: empty"} {
		if strings.Contains(got, unwanted) {
			t.Errorf("output lists %q, which fired zero times:\n%s", unwanted, got)
		}
	}
	// "no usable candidate" is a total, not a rule, so it prints at zero.
	if !strings.Contains(got, "no usable candidate") {
		t.Errorf("the no-usable-candidate total is missing:\n%s", got)
	}
}

// The histogram is capped on screen and complete in the JSON.  What has to
// hold is that the cap says how much it is hiding — a list that just stops
// reads as the whole list.
func TestPrintSummaryCapsTheHistogramAndSaysSo(t *testing.T) {
	cases := []struct {
		name       string
		entries    int
		wantRows   int
		wantMore   string
		wantNoMore bool
	}{
		{name: "a short histogram prints whole", entries: 3, wantRows: 3, wantNoMore: true},
		{name: "exactly the cap prints whole", entries: maxRejectionChars, wantRows: maxRejectionChars, wantNoMore: true},
		{name: "one over the cap", entries: maxRejectionChars + 1, wantRows: maxRejectionChars, wantMore: "1 more"},
		{name: "well over the cap", entries: maxRejectionChars + 25, wantRows: maxRejectionChars, wantMore: "25 more"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rep := fullReport()
			rep.SimplifiedRejections = nil
			rep.SimplifiedRejectionChars = nil
			for i := range tc.entries {
				rep.SimplifiedRejectionChars = append(rep.SimplifiedRejectionChars,
					CharCount{Chars: fmt.Sprintf("字%02d", i), Count: tc.entries - i})
				rep.SimplifiedRejections = append(rep.SimplifiedRejections, SimplifiedRejection{AnilistID: int32(i)})
			}

			var b strings.Builder
			PrintSummary(&b, rep)
			got := b.String()

			rows := 0
			for i := range tc.entries {
				if strings.Contains(got, fmt.Sprintf("字%02d", i)) {
					rows++
				}
			}
			if rows != tc.wantRows {
				t.Errorf("printed %d histogram rows, want %d:\n%s", rows, tc.wantRows, got)
			}
			if tc.wantNoMore && strings.Contains(got, "more") {
				t.Errorf("output claims there is more to see when the whole histogram is on screen:\n%s", got)
			}
			if tc.wantMore != "" && !strings.Contains(got, tc.wantMore) {
				t.Errorf("output does not say %q, so the truncated list reads as the whole list:\n%s", tc.wantMore, got)
			}
			// The count above the histogram is the queue length, not the
			// number of distinct characters shown.
			if !strings.Contains(got, fmt.Sprintf("source='manual'): %d", tc.entries)) {
				t.Errorf("the queue length is wrong or missing:\n%s", got)
			}
		})
	}
}

// The run where every percentage divides by zero, end to end.  An operator
// reading "NaN%" cannot tell an empty table from a broken tool, and this
// is the summary they are reading to decide whether to type --apply.
func TestPrintSummaryOnAnEmptyRunPrintsNoNaN(t *testing.T) {
	var b strings.Builder
	PrintSummary(&b, BuildReport(reportResolver(t, 0, nil), nil, false))
	got := b.String()

	for _, bad := range []string{"NaN", "Inf"} {
		if strings.Contains(got, bad) {
			t.Fatalf("output contains %q:\n%s", bad, got)
		}
	}
	if !strings.Contains(got, "Rows scanned: 0") {
		t.Errorf("an empty run does not say it read nothing:\n%s", got)
	}
	// Both column blocks still render, so "no rows" is visibly different
	// from "the report stopped half way".
	for _, want := range []string{"title_hant", "description_hant", "QUALITY GATE", "CGROUP OVERLAY"} {
		if !strings.Contains(got, want) {
			t.Errorf("summary is missing the %s block:\n%s", want, got)
		}
	}
}
