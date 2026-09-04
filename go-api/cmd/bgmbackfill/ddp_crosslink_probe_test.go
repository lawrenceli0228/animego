// ddp_crosslink_probe_test.go — the probe's classification, pinned.
//
// The probe exists to answer a design question with numbers, so its
// classification IS its output.  A class that is wrong in a way nobody notices
// does not produce a visibly broken report; it produces a plausible one that
// argues for the wrong design.  These cases pin the distinctions that carry
// weight in that argument:
//
//   - BINDABLE vs SUBJECT_TAKEN decides how many rows a sweep would actually
//     gain, since a held subject cannot be bound twice.
//   - ANILIST_MISMATCH vs NO_ANILIST_LINK separates "dandanplay disagrees with
//     us" from "dandanplay has no opinion".  Collapsing them would read as
//     upstream contradicting our catalogue when it is merely silent.
//   - The candidate position is the sweep's per-row request cost.  If it were
//     recorded off by one, the cost estimate would be wrong by 50%.
package main

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/dandanplay"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// fakeCrosslinkClient serves canned search hits and per-entry payloads.
type fakeCrosslinkClient struct {
	hits      []dandanplay.DandanAnime
	byID      map[int64]*dandanplay.EpisodeData
	searchErr error
	fetchErr  error
	calls     int
}

func (f *fakeCrosslinkClient) SearchAnime(context.Context, string) ([]dandanplay.DandanAnime, error) {
	if f.searchErr != nil {
		return nil, f.searchErr
	}
	return f.hits, nil
}

func (f *fakeCrosslinkClient) FetchEpisodesByDandanAnimeID(_ context.Context, id int64) (*dandanplay.EpisodeData, error) {
	f.calls++
	if f.fetchErr != nil {
		return nil, f.fetchErr
	}
	return f.byID[id], nil
}

// fakeCrosslinkDB answers only the held-subject question; the candidate list
// is supplied directly to probeOneCrosslink.
type fakeCrosslinkDB struct {
	held map[int32]int64
	err  error
}

func (f *fakeCrosslinkDB) ListUnboundMapSilentForCrosslink(context.Context) ([]dbgen.ListUnboundMapSilentForCrosslinkRow, error) {
	return nil, nil
}

func (f *fakeCrosslinkDB) CountAnimeHoldingBgmID(_ context.Context, bgmID *int32) (int64, error) {
	if f.err != nil {
		return 0, f.err
	}
	if bgmID == nil {
		return 0, nil
	}
	return f.held[*bgmID], nil
}

func strp(s string) *string { return &s }

func xlinkHits(ids ...int64) []dandanplay.DandanAnime {
	out := make([]dandanplay.DandanAnime, len(ids))
	for i, id := range ids {
		out[i] = dandanplay.DandanAnime{DandanAnimeID: id}
	}
	return out
}

func TestProbeOneCrosslink(t *testing.T) {
	const ourAnilist = int32(4242)
	row := dbgen.ListUnboundMapSilentForCrosslinkRow{
		AnilistID:   ourAnilist,
		TitleNative: strp("架空アニメ"),
	}

	tests := []struct {
		name         string
		row          dbgen.ListUnboundMapSilentForCrosslinkRow
		client       *fakeCrosslinkClient
		db           *fakeCrosslinkDB
		wantClass    string
		wantPosition int
		wantBgm      int32
		// wantFetches pins how many entry payloads were pulled, because that
		// is the number the sweep's cost estimate is built from.
		wantFetches int
	}{
		{
			name: "the first candidate names our row and its subject is free",
			row:  row,
			client: &fakeCrosslinkClient{
				hits: xlinkHits(11),
				byID: map[int64]*dandanplay.EpisodeData{
					11: {AniListID: ourAnilist, BgmID: 900001},
				},
			},
			db:           &fakeCrosslinkDB{held: map[int32]int64{}},
			wantClass:    xlinkBindable,
			wantPosition: 1,
			wantBgm:      900001,
			wantFetches:  1,
		},
		{
			name: "our row is named by the third candidate, not the first",
			row:  row,
			client: &fakeCrosslinkClient{
				hits: xlinkHits(11, 12, 13),
				byID: map[int64]*dandanplay.EpisodeData{
					11: {AniListID: 1, BgmID: 900011},
					12: {AniListID: 2, BgmID: 900012},
					13: {AniListID: ourAnilist, BgmID: 900013},
				},
			},
			db:           &fakeCrosslinkDB{held: map[int32]int64{}},
			wantClass:    xlinkBindable,
			wantPosition: 3,
			wantBgm:      900013,
			wantFetches:  3,
		},
		{
			name: "the identity holds but another row already wears the subject",
			row:  row,
			client: &fakeCrosslinkClient{
				hits: xlinkHits(11),
				byID: map[int64]*dandanplay.EpisodeData{
					11: {AniListID: ourAnilist, BgmID: 900021},
				},
			},
			db:           &fakeCrosslinkDB{held: map[int32]int64{900021: 1}},
			wantClass:    xlinkSubjectTaken,
			wantPosition: 1,
			wantBgm:      900021,
			wantFetches:  1,
		},
		{
			name: "the entry is ours but carries no Bangumi link",
			row:  row,
			client: &fakeCrosslinkClient{
				hits: xlinkHits(11),
				byID: map[int64]*dandanplay.EpisodeData{
					11: {AniListID: ourAnilist, BgmID: 0},
				},
			},
			db:           &fakeCrosslinkDB{held: map[int32]int64{}},
			wantClass:    xlinkNoBgmLink,
			wantPosition: 1,
			wantFetches:  1,
		},
		{
			name: "every candidate links to AniList, and none of them to us",
			row:  row,
			client: &fakeCrosslinkClient{
				hits: xlinkHits(11, 12),
				byID: map[int64]*dandanplay.EpisodeData{
					11: {AniListID: 7, BgmID: 900031},
					12: {AniListID: 8, BgmID: 900032},
				},
			},
			db:          &fakeCrosslinkDB{held: map[int32]int64{}},
			wantClass:   xlinkAnilistMiss,
			wantFetches: 2,
		},
		{
			name: "no candidate publishes an AniList link at all",
			row:  row,
			client: &fakeCrosslinkClient{
				hits: xlinkHits(11, 12),
				byID: map[int64]*dandanplay.EpisodeData{
					11: {AniListID: 0, BgmID: 900041},
					12: {AniListID: 0, BgmID: 900042},
				},
			},
			db:          &fakeCrosslinkDB{held: map[int32]int64{}},
			wantClass:   xlinkNoAnilistLink,
			wantFetches: 2,
		},
		{
			name:        "the search returns nothing",
			row:         row,
			client:      &fakeCrosslinkClient{hits: nil},
			db:          &fakeCrosslinkDB{held: map[int32]int64{}},
			wantClass:   xlinkNoSearchHit,
			wantFetches: 0,
		},
		{
			name:        "the row has no title to search with",
			row:         dbgen.ListUnboundMapSilentForCrosslinkRow{AnilistID: ourAnilist},
			client:      &fakeCrosslinkClient{},
			db:          &fakeCrosslinkDB{held: map[int32]int64{}},
			wantClass:   xlinkNoKeyword,
			wantFetches: 0,
		},
		{
			name:        "the search itself fails",
			row:         row,
			client:      &fakeCrosslinkClient{searchErr: errors.New("upstream down")},
			db:          &fakeCrosslinkDB{held: map[int32]int64{}},
			wantClass:   xlinkFetchFail,
			wantFetches: 0,
		},
		{
			name: "a nil payload is skipped rather than counted as a mismatch",
			row:  row,
			client: &fakeCrosslinkClient{
				hits: xlinkHits(11, 12),
				byID: map[int64]*dandanplay.EpisodeData{
					11: nil,
					12: {AniListID: ourAnilist, BgmID: 900051},
				},
			},
			db:           &fakeCrosslinkDB{held: map[int32]int64{}},
			wantClass:    xlinkBindable,
			wantPosition: 2,
			wantBgm:      900051,
			wantFetches:  2,
		},
		{
			// The cap is the cost control, so it has to actually stop the walk.
			// Without this the probe would quietly report the cost of however
			// many hits dandanplay happened to return.
			name: "the candidate cap stops the walk",
			row:  row,
			client: &fakeCrosslinkClient{
				hits: xlinkHits(11, 12, 13, 14, 15),
				byID: map[int64]*dandanplay.EpisodeData{
					11: {AniListID: 1}, 12: {AniListID: 2}, 13: {AniListID: 3},
					14: {AniListID: ourAnilist, BgmID: 900061},
					15: {AniListID: 5},
				},
			},
			db:          &fakeCrosslinkDB{held: map[int32]int64{}},
			wantClass:   xlinkAnilistMiss,
			wantFetches: crosslinkMaxCandidates,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			rep := &crosslinkReport{Counts: map[string]int{}, PositionHit: map[int]int{}}
			got := probeOneCrosslink(context.Background(), tc.db, tc.client, tc.row, rep)

			assert.Equal(t, tc.wantClass, got.Class)
			assert.Equal(t, tc.wantPosition, got.Position,
				"the position is the sweep's per-row request cost; an off-by-one here misprices the design")
			assert.Equal(t, tc.wantBgm, got.BgmID)
			assert.Equal(t, tc.wantFetches, tc.client.calls,
				"entry fetches drive the cost estimate")

			// APICalls counts the search plus every entry fetch, which is what
			// the report divides by row count.
			wantCalls := tc.wantFetches
			if tc.wantClass != xlinkNoKeyword {
				wantCalls++ // the search itself
			}
			assert.Equal(t, wantCalls, rep.APICalls,
				"a request the report does not count is a request the cost estimate loses")
		})
	}
}

// TestCrosslinkKeyword pins the search-string order.  Chinese is absent on
// purpose: dandanplay's Chinese titles are its own, so searching one against
// its index tests our copy of its data rather than the identity we are after.
func TestCrosslinkKeyword(t *testing.T) {
	tests := []struct {
		name string
		row  dbgen.ListUnboundMapSilentForCrosslinkRow
		want string
	}{
		{
			name: "native wins when present",
			row: dbgen.ListUnboundMapSilentForCrosslinkRow{
				TitleNative: strp("ネイティブ"), TitleRomaji: strp("Romaji"),
				TitleEnglish: strp("English"), TitleChinese: strp("中文"),
			},
			want: "ネイティブ",
		},
		{
			name: "romaji is the fallback",
			row: dbgen.ListUnboundMapSilentForCrosslinkRow{
				TitleRomaji: strp("Romaji"), TitleChinese: strp("中文"),
			},
			want: "Romaji",
		},
		{
			name: "english is the last resort",
			row: dbgen.ListUnboundMapSilentForCrosslinkRow{
				TitleEnglish: strp("English"), TitleChinese: strp("中文"),
			},
			want: "English",
		},
		{
			name: "an empty string is not a title",
			row: dbgen.ListUnboundMapSilentForCrosslinkRow{
				TitleNative: strp(""), TitleRomaji: strp("Romaji"),
			},
			want: "Romaji",
		},
		{
			name: "a Chinese title alone is not searched with",
			row:  dbgen.ListUnboundMapSilentForCrosslinkRow{TitleChinese: strp("中文")},
			want: "",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			require.Equal(t, tc.want, crosslinkKeyword(tc.row))
		})
	}
}

// ---------------------------------------------------------------------------
// crosslinkSample — the sampler the extrapolation rests on
//
// Every number this probe reports gets multiplied by ~4,400, so the one
// property that matters is that the sample spans the whole ordered set rather
// than its head.  These tests are written against that property, not against
// the arithmetic: they check span and spread, so a future implementation that
// changes how the stride is computed still has to keep the guarantee.
// ---------------------------------------------------------------------------

func seq(n int) []int {
	out := make([]int, n)
	for i := range out {
		out[i] = i
	}
	return out
}

func TestCrosslinkSampleSpansTheWholeSet(t *testing.T) {
	rows := seq(4463)

	got, stride := crosslinkSample(rows, 300)

	if len(got) != 300 {
		t.Fatalf("want 300 rows, got %d", len(got))
	}
	if stride != 14 {
		t.Fatalf("want stride 14 for 4463/300, got %d", stride)
	}
	// The point of the whole function: the last row probed must live near the
	// far end of the catalogue, not 300 rows into it.  Walking the head would
	// end at index 299.
	if last := got[len(got)-1]; last < len(rows)-2*stride {
		t.Fatalf("sample ends at index %d of %d — that is a head sample, not a spread one", last, len(rows))
	}
	if got[0] != 0 {
		t.Fatalf("sample should start at the first row, got %d", got[0])
	}
}

func TestCrosslinkSampleCoversEveryQuarter(t *testing.T) {
	rows := seq(4463)

	got, _ := crosslinkSample(rows, 200)

	// A spread sample must put roughly equal weight in each quarter of the
	// ordered set. This is the assertion a head sample fails outright (all 200
	// in the first quarter) and it is also what catches a stride that silently
	// truncates halfway.
	quarters := make([]int, 4)
	for _, v := range got {
		q := v * 4 / len(rows)
		if q > 3 {
			q = 3
		}
		quarters[q]++
	}
	for i, n := range quarters {
		if n < len(got)/8 {
			t.Fatalf("quarter %d holds only %d of %d sampled rows: %v", i, n, len(got), quarters)
		}
	}
}

func TestCrosslinkSamplePassesEverythingThroughWhenNotSampling(t *testing.T) {
	rows := seq(50)

	for _, want := range []int{0, -1, 50, 999} {
		got, stride := crosslinkSample(rows, want)
		if len(got) != 50 {
			t.Fatalf("want=%d: expected the full set, got %d rows", want, len(got))
		}
		if stride != 1 {
			// Stride 1 is what makes printCrosslinkSummary print the
			// head-of-order caveat instead of a confidence interval. Getting
			// this wrong would put a CI on a number that has not earned one.
			t.Fatalf("want=%d: expected stride 1, got %d", want, stride)
		}
	}
}

func TestCrosslinkSampleHandlesTinySets(t *testing.T) {
	// len(rows)/want rounds to 0 when the request is bigger than the set;
	// without the floor that is an infinite loop, which is the kind of bug a
	// probe run against a nearly-drained catalogue would find in production.
	got, stride := crosslinkSample(seq(3), 2)
	if stride < 1 {
		t.Fatalf("stride must never be below 1, got %d", stride)
	}
	if len(got) == 0 || len(got) > 3 {
		t.Fatalf("unexpected sample size %d", len(got))
	}
}
