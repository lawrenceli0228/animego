package anime

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/anilist"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// The trailer columns carry two facts, not one: what AniList said, and
// whether we asked.  Every test below pins one half of that pair.
//
//	query selected trailer?
//	├── no  → checked_at nil, metadata nil  → upsert preserves stored value
//	└── yes → checked_at stamped with now()
//	          ├── supported YouTube trailer → metadata stored
//	          └── anything else (absent / null id / null site /
//	              other site / malformed id) → metadata nil, and that
//	              nil is a confirmed absence, not a gap to re-check

// TestTrailerNormalizeValidateAndSerialize walks every shape AniList can
// put in the trailer field.  Only a well-formed YouTube id survives to
// the row; everything else stores nil metadata while still recording
// that the question was asked.
func TestTrailerNormalizeValidateAndSerialize(t *testing.T) {
	for _, tc := range []struct {
		name    string
		trailer *anilist.Trailer
		wantID  *string
	}{
		{"youtube lowercase", &anilist.Trailer{ID: sptr("abcdefghijk"), Site: sptr("youtube")}, sptr("abcdefghijk")},
		{"youtube mixed case", &anilist.Trailer{ID: sptr("abcdefghijk"), Site: sptr("YouTube")}, sptr("abcdefghijk")},
		{"url smuggled into id", &anilist.Trailer{ID: sptr("https://evil"), Site: sptr("youtube")}, nil},
		{"unsupported site", &anilist.Trailer{ID: sptr("abcdefghijk"), Site: sptr("dailymotion")}, nil},
		{"id too short", &anilist.Trailer{ID: sptr("short"), Site: sptr("youtube")}, nil},
		// AniList really does return {id: null, site: "youtube"} — the
		// object exists, the id does not.
		{"null id beside a site", &anilist.Trailer{Site: sptr("youtube")}, nil},
		{"null site beside an id", &anilist.Trailer{ID: sptr("abcdefghijk")}, nil},
		{"no trailer object at all", nil, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			row := NormalizeMainRow(anilist.Media{ID: 1, Trailer: tc.trailer}, anilist.TrailerSelected)

			require.True(t, row.TrailerChecked,
				"a selecting query always records that it asked, whatever came back")

			detail := assembleDetail(dbgen.GetAnimeMainByIDRow{
				AnilistID: 1, TrailerID: row.TrailerID, TrailerSite: row.TrailerSite,
			}, nil, nil, nil, nil, nil, nil, nil)
			payload, err := json.Marshal(detail)
			require.NoError(t, err)

			if tc.wantID == nil {
				assert.Nil(t, row.TrailerID)
				assert.Nil(t, row.TrailerSite)
				assert.Nil(t, detail.Trailer)
				assert.NotContains(t, string(payload), `"trailer"`,
					"absent trailer is omitted, not serialized as null")
				return
			}
			require.NotNil(t, row.TrailerID)
			assert.Equal(t, *tc.wantID, *row.TrailerID)
			assert.Equal(t, "youtube", *row.TrailerSite, "site is normalized, not passed through")
			require.NotNil(t, detail.Trailer)
			assert.Contains(t, string(payload), `"trailer":{"id":"abcdefghijk","site":"youtube"}`)
		})
	}
}

// TestTrailerOmittedListingDoesNotClearStoredValue — a query that never
// selected trailer must emit a row the upsert reads as "leave it alone".
// The Media is given a perfectly good trailer to prove the selection
// flag, not the payload, is what decides.
func TestTrailerOmittedListingDoesNotClearStoredValue(t *testing.T) {
	row := NormalizeMainRow(anilist.Media{
		ID:      1,
		Trailer: &anilist.Trailer{ID: sptr("abcdefghijk"), Site: sptr("youtube")},
	}, anilist.TrailerNotSelected)

	assert.False(t, row.TrailerChecked)
	assert.Nil(t, row.TrailerID)
	assert.Nil(t, row.TrailerSite)
}

// TestTrailerDetailNullIsAuthoritative — /anime/:id runs AnimeDetailQuery,
// which selects trailer, so a Media with no trailer is an answer.
func TestTrailerDetailNullIsAuthoritative(t *testing.T) {
	db := &detailFakeDB{}
	s := newDetailService(t, db)
	require.NoError(t, s.upsertFromMedia(context.Background(), 1, anilist.Media{ID: 1}))
	require.Len(t, db.upsertParams, 1)
	assert.True(t, db.upsertParams[0].TrailerChecked)
	assert.Nil(t, db.upsertParams[0].TrailerID)
}

// TestTrailerSeasonalColdStartRecordsTheAnswer — the cold-start path runs
// SeasonalAnimeQuery, which selects trailer.  Without this the warmed row
// would look unchecked and drag the next detail view into a blocking
// AniList re-fetch.
func TestTrailerSeasonalColdStartRecordsTheAnswer(t *testing.T) {
	t.Parallel()

	al := &fakeSeasonaler{
		fn: func(_ context.Context, _ anilist.SeasonalVars) (*anilist.SeasonalAnimeResponse, error) {
			return &anilist.SeasonalAnimeResponse{
				Page: anilist.MediaPage{
					PageInfo: anilist.PageInfo{Total: 1, CurrentPage: 1, LastPage: 1, PerPage: 20},
					Media:    []anilist.Media{seasonalMediaWith(101)},
				},
			}, nil
		},
	}
	var seasonalCalls atomic.Int32
	db := &fakeSeasonalDB{
		getSeasonalAnimeFn: func(_ context.Context, _ *string, _ *int32, _, _ int32) ([]dbgen.GetSeasonalAnimeRow, error) {
			if seasonalCalls.Add(1) == 1 {
				return []dbgen.GetSeasonalAnimeRow{}, nil
			}
			return []dbgen.GetSeasonalAnimeRow{{AnilistID: 101}}, nil
		},
		countSeasonalFn: func(_ context.Context, _ *string, _ *int32) (int64, error) { return 0, nil },
	}
	svc := NewSeasonalService(db, al)

	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/seasonal?season=WINTER&year=2024", nil))
	require.Equal(t, http.StatusOK, rec.Code)

	params := db.snapshotUpsertedParams()
	require.Len(t, params, 1)
	assert.True(t, params[0].TrailerChecked, "seasonal selects trailer, so its null is an answer")

	// And the list projection is what the consumer reads: the key has to be
	// on the wire even when the value is null, because a list card decides
	// whether to fall back to a per-item detail fetch by looking at it.
	assert.Contains(t, rec.Body.String(), `"trailerId"`)
	assert.Contains(t, rec.Body.String(), `"trailerSite"`)
	assert.NotContains(t, rec.Body.String(), `"trailerCheckedAt"`,
		"checked-at is cache bookkeeping and must not leak into a list response")
}

// TestTrailerSearchDoesNotClaimToHaveChecked — /search runs
// SearchAnimeQuery, which does NOT select trailer.  Claiming otherwise
// would let a search hit overwrite a stored trailer with nothing.
func TestTrailerSearchDoesNotClaimToHaveChecked(t *testing.T) {
	t.Parallel()

	fs := &fakeSearcher{
		fn: func(_ context.Context, _ anilist.SearchVars) (*anilist.SearchAnimeResponse, error) {
			return &anilist.SearchAnimeResponse{
				Page: anilist.MediaPage{
					PageInfo: anilist.PageInfo{Total: 1, CurrentPage: 1, LastPage: 1, PerPage: 20},
					Media:    []anilist.Media{mediaWith(11)},
				},
			}, nil
		},
	}
	fq := &searchFakeQuerier{
		getAnimeByAnilistIDsFn: func(_ context.Context, _ []int32) ([]dbgen.GetAnimeByAnilistIDsRow, error) {
			return nil, nil
		},
	}
	svc := newSearchService(t, fs, fq, nil)

	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/search?q=x", nil))
	require.Equal(t, http.StatusOK, rec.Code)

	_, params := fq.snapshotUpserts()
	require.Len(t, params, 1)
	assert.False(t, params[0].TrailerChecked, "search never asked, so it must not answer")
}

// TestTrailerEnsureCachedRecordsTheAnswer — EnsureCached fills a cache miss
// through AnimeDetailQuery, which selects trailer.  A row it writes without
// the stamp would be born stale and drag the next detail view into a
// blocking AniList re-fetch it did not need.
func TestTrailerEnsureCachedRecordsTheAnswer(t *testing.T) {
	t.Parallel()

	db := &ensureCachedFakeDB{}
	ac := &ensureCachedFakeAniList{
		media: anilist.Media{ID: 7, Trailer: &anilist.Trailer{ID: sptr("abcdefghijk"), Site: sptr("youtube")}},
	}
	require.NoError(t, EnsureCached(context.Background(), db, ac, 7))

	require.Len(t, db.upserts, 1)
	assert.True(t, db.upserts[0].TrailerChecked)
	require.NotNil(t, db.upserts[0].TrailerID)
	assert.Equal(t, "abcdefghijk", *db.upserts[0].TrailerID)
}

// ensureCachedFakeDB reports a cache miss on the probe and records what the
// fill wrote.
type ensureCachedFakeDB struct {
	upserts []dbgen.UpsertAnimeCacheParams
}

func (f *ensureCachedFakeDB) GetAnimeMainByID(context.Context, int32) (dbgen.GetAnimeMainByIDRow, error) {
	return dbgen.GetAnimeMainByIDRow{}, pgx.ErrNoRows
}

func (f *ensureCachedFakeDB) UpsertAnimeCache(_ context.Context, arg dbgen.UpsertAnimeCacheParams) error {
	f.upserts = append(f.upserts, arg)
	return nil
}

type ensureCachedFakeAniList struct{ media anilist.Media }

func (f *ensureCachedFakeAniList) Detail(context.Context, anilist.DetailVars) (*anilist.AnimeDetailResponse, error) {
	return &anilist.AnimeDetailResponse{Media: f.media}, nil
}

// TestTrailerUnknownRefreshesButCheckedNullDoesNot — an unchecked row is
// stale so it gets filled once; a checked one is not, so a confirmed
// absence never turns into a permanent re-fetch loop.
func TestTrailerUnknownRefreshesButCheckedNullDoesNot(t *testing.T) {
	row := dbgen.GetAnimeMainByIDRow{CachedAt: freshTimestamp()}
	studios := []string{"Studio"}
	chars := []dbgen.GetAnimeCharactersByIDRow{{Role: sptr("MAIN")}}
	require.True(t, isStale(row, studios, chars, nil))
	row.TrailerCheckedAt = freshTimestamp()
	require.False(t, isStale(row, studios, chars, nil))
}
