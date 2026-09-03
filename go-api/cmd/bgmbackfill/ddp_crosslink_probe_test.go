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
