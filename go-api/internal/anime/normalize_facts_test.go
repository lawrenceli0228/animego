package anime

import (
	"testing"
	"time"

	"github.com/lawrenceli0228/animego/go-api/internal/anilist"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestNormalizeMainRow_FactsAreCarried — the four facts AnimeDetailQuery
// has always selected must reach the upsert params.  This is the test
// that was missing while the columns sat in anime_cache for months being
// written by nothing: the query asked, AniList answered, and the params
// struct had no field to put the answer in.
func TestNormalizeMainRow_FactsAreCarried(t *testing.T) {
	m := anilist.Media{
		ID:        174184,
		StartDate: &anilist.FuzzyDate{Year: iptr(2024), Month: iptr(4), Day: iptr(26)},
		EndDate:   &anilist.FuzzyDate{Year: iptr(2024), Month: iptr(7), Day: iptr(12)},
		Duration:  iptr(23),
		Source:    sptr("VISUAL_NOVEL"),
	}
	row := NormalizeMainRow(m, anilist.DetailDocument)

	require.True(t, row.StartDate.Valid)
	assert.Equal(t, time.Date(2024, 4, 26, 0, 0, 0, 0, time.UTC), row.StartDate.Time)
	require.True(t, row.EndDate.Valid)
	assert.Equal(t, time.Date(2024, 7, 12, 0, 0, 0, 0, time.UTC), row.EndDate.Time)
	require.NotNil(t, row.Duration)
	assert.Equal(t, int32(23), *row.Duration)
	require.NotNil(t, row.Source)
	assert.Equal(t, "VISUAL_NOVEL", *row.Source)
}

// TestNormalizeMainRow_FactsAbsentAreNull — a listing document does not
// select the facts, so the params must carry NULLs the upsert's COALESCE
// turns into "leave the stored value alone".  A zero value here, not a
// sentinel, is the contract.
func TestNormalizeMainRow_FactsAbsentAreNull(t *testing.T) {
	row := NormalizeMainRow(anilist.Media{ID: 1}, anilist.SeasonalDocument)
	assert.False(t, row.StartDate.Valid)
	assert.False(t, row.EndDate.Valid)
	assert.Nil(t, row.Duration)
	assert.Nil(t, row.Source)
}

// TestDateFromFuzzy — a date column can only hold a whole date, and the
// rule for a partial one is the Express migration's rule: all three parts
// or nothing.  Padding would print a day AniList never stated.
func TestDateFromFuzzy(t *testing.T) {
	full := func(y, m, d int) *anilist.FuzzyDate {
		return &anilist.FuzzyDate{Year: iptr(y), Month: iptr(m), Day: iptr(d)}
	}
	for _, tc := range []struct {
		name string
		in   *anilist.FuzzyDate
		want *time.Time
	}{
		{"nil", nil, nil},
		{"all null", &anilist.FuzzyDate{}, nil},
		{"year only", &anilist.FuzzyDate{Year: iptr(2011)}, nil},
		{"year and month", &anilist.FuzzyDate{Year: iptr(2011), Month: iptr(10)}, nil},
		{"month and day without year", &anilist.FuzzyDate{Month: iptr(10), Day: iptr(3)}, nil},
		{"full", full(2011, 10, 3), ptrTime(time.Date(2011, 10, 3, 0, 0, 0, 0, time.UTC))},
		{"zero year", full(0, 1, 1), nil},
		{"month out of range", full(2011, 13, 1), nil},
		{"day out of range", full(2011, 1, 32), nil},
		{"impossible day is refused, not normalised", full(2023, 2, 30), nil},
		{"leap day accepted", full(2024, 2, 29), ptrTime(time.Date(2024, 2, 29, 0, 0, 0, 0, time.UTC))},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := dateFromFuzzy(tc.in)
			if tc.want == nil {
				assert.False(t, got.Valid, "expected NULL, got %v", got.Time)
				return
			}
			require.True(t, got.Valid)
			assert.Equal(t, *tc.want, got.Time)
		})
	}
}

// TestNormalizeMainRow_DetailStampFollowsTheDocument — detail_fetched_at
// is stamped by exactly the document that selects the child connections.
// A seasonal row must not be stamped: it has no children yet, and the
// stamp is what tells the detail read it does not owe a fetch.
func TestNormalizeMainRow_DetailStampFollowsTheDocument(t *testing.T) {
	for _, tc := range []struct {
		doc     anilist.Document
		trailer bool
		detail  bool
	}{
		{anilist.SearchDocument, false, false},
		{anilist.SeasonalDocument, true, false},
		{anilist.DetailDocument, true, true},
	} {
		row := NormalizeMainRow(anilist.Media{ID: 1}, tc.doc)
		assert.Equal(t, tc.trailer, row.TrailerChecked, "doc=%d trailer", tc.doc)
		assert.Equal(t, tc.detail, row.DetailFetched, "doc=%d detail", tc.doc)
	}
}

func ptrTime(t time.Time) *time.Time { return &t }
