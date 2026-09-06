package anime

import (
	"context"
	"encoding/json"
	"github.com/lawrenceli0228/animego/go-api/internal/anilist"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/stretchr/testify/require"
	"testing"
)

func TestTrailerNormalizeValidateAndSerialize(t *testing.T) {
	for _, tc := range []struct {
		id, site string
		valid    bool
	}{
		{"abcdefghijk", "youtube", true}, {"abcdefghijk", "YouTube", true},
		{"https://evil", "youtube", false}, {"abcdefghijk", "other", false}, {"short", "youtube", false},
	} {
		t.Run(tc.id+tc.site, func(t *testing.T) {
			row := NormalizeMainRow(anilist.Media{ID: 1, Trailer: &anilist.Trailer{ID: sptr(tc.id), Site: sptr(tc.site)}})
			require.True(t, row.TrailerFetched)
			detail := assembleDetail(dbgen.GetAnimeMainByIDRow{AnilistID: 1, TrailerID: row.TrailerID, TrailerSite: row.TrailerSite}, nil, nil, nil, nil, nil, nil, nil)
			payload, err := json.Marshal(detail)
			require.NoError(t, err)
			if tc.valid {
				require.NotNil(t, detail.Trailer)
				require.Equal(t, "youtube", *detail.Trailer.Site)
				require.Contains(t, string(payload), `"trailer":{"id":"abcdefghijk","site":"youtube"}`)
			} else {
				require.Nil(t, row.TrailerID)
				require.Nil(t, detail.Trailer)
			}
		})
	}
}
func TestTrailerOmittedListingDoesNotClearStoredValue(t *testing.T) {
	row := NormalizeMainRow(anilist.Media{ID: 1})
	require.False(t, row.TrailerFetched)
	require.Nil(t, row.TrailerID)
}
func TestTrailerDetailNullIsAuthoritative(t *testing.T) {
	db := &detailFakeDB{}
	s := newDetailService(t, db)
	require.NoError(t, s.upsertFromMedia(context.Background(), 1, anilist.Media{ID: 1}))
	require.Len(t, db.upsertParams, 1)
	require.True(t, db.upsertParams[0].TrailerFetched)
	require.Nil(t, db.upsertParams[0].TrailerID)
}
func TestTrailerUnknownRefreshesButCheckedNullDoesNot(t *testing.T) {
	row := dbgen.GetAnimeMainByIDRow{CachedAt: freshTimestamp()}
	studios := []string{"Studio"}
	chars := []dbgen.GetAnimeCharactersByIDRow{{Role: sptr("MAIN")}}
	require.True(t, isStale(row, studios, chars, nil))
	row.TrailerFetched = true
	require.False(t, isStale(row, studios, chars, nil))
}
