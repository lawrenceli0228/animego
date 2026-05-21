package anime

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// fakeQuerier is a hand-rolled mock of dbgen.Querier.  When P2.1 grows
// past a couple of handlers we will swap to mockgen — for now the single
// method we exercise is cheaper to keep hand-written than to wire up the
// generator.
type fakeQuerier struct {
	dbgen.Querier // embed so unimplemented methods panic loud and clear

	getCompletedGemsFn func(ctx context.Context, limit int32) ([]dbgen.GetCompletedGemsRow, error)
}

func (f *fakeQuerier) GetCompletedGems(ctx context.Context, limit int32) ([]dbgen.GetCompletedGemsRow, error) {
	if f.getCompletedGemsFn == nil {
		return nil, errors.New("fakeQuerier: GetCompletedGems not set")
	}
	return f.getCompletedGemsFn(ctx, limit)
}

func TestCompletedGems_DefaultLimit(t *testing.T) {
	t.Parallel()

	var gotLimit int32
	q := &fakeQuerier{
		getCompletedGemsFn: func(_ context.Context, limit int32) ([]dbgen.GetCompletedGemsRow, error) {
			gotLimit = limit
			return []dbgen.GetCompletedGemsRow{}, nil
		},
	}

	rec := httptest.NewRecorder()
	CompletedGems(q).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/completed-gems", nil))

	if gotLimit != 6 {
		t.Errorf("default limit = %d, want 6", gotLimit)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", rec.Code)
	}
	if got := rec.Body.String(); got != `{"data":[]}` {
		t.Errorf("body = %q, want %q", got, `{"data":[]}`)
	}
}

func TestCompletedGems_LimitParsing(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name      string
		query     string
		wantLimit int32
	}{
		{"explicit 5", "?limit=5", 5},
		{"explicit 1", "?limit=1", 1},
		{"max cap 20", "?limit=20", 20},
		{"over max → 20", "?limit=999", 20},
		{"non-numeric → default", "?limit=abc", 6},
		{"negative → default", "?limit=-3", 6},
		{"zero → default", "?limit=0", 6},
		{"empty → default", "?limit=", 6},
		{"missing → default", "", 6},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			var gotLimit int32
			q := &fakeQuerier{
				getCompletedGemsFn: func(_ context.Context, limit int32) ([]dbgen.GetCompletedGemsRow, error) {
					gotLimit = limit
					return nil, nil
				},
			}
			rec := httptest.NewRecorder()
			CompletedGems(q).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/completed-gems"+tc.query, nil))

			if gotLimit != tc.wantLimit {
				t.Errorf("limit = %d, want %d", gotLimit, tc.wantLimit)
			}
		})
	}
}

func TestCompletedGems_QueryError(t *testing.T) {
	t.Parallel()

	q := &fakeQuerier{
		getCompletedGemsFn: func(_ context.Context, _ int32) ([]dbgen.GetCompletedGemsRow, error) {
			return nil, errors.New("simulated postgres failure")
		},
	}

	rec := httptest.NewRecorder()
	CompletedGems(q).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/completed-gems", nil))

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500", rec.Code)
	}
	body := rec.Body.String()
	if !strings.Contains(body, `"SERVER_ERROR"`) {
		t.Errorf("body missing SERVER_ERROR code: %q", body)
	}
	// Cause must not leak into client body.
	if strings.Contains(body, "simulated postgres failure") {
		t.Errorf("body leaked cause: %q", body)
	}
}

func TestCompletedGems_Envelope(t *testing.T) {
	t.Parallel()

	// Mirrors anime.controller.js:77-87 — flat array envelope, no
	// pagination metadata (random sample has no total / page concept).
	score := 78.0
	bgmScore := 7.6
	cover := "https://s4.anilist.co/file/.../bxXXX.jpg"
	colorless := (*string)(nil)
	episodes := int32(12)
	season := "FALL"
	year := int32(2024)
	status := "FINISHED"
	format := "TV"
	desc := "test description"
	romaji := "Test Title Romaji"

	q := &fakeQuerier{
		getCompletedGemsFn: func(_ context.Context, _ int32) ([]dbgen.GetCompletedGemsRow, error) {
			return []dbgen.GetCompletedGemsRow{
				{
					AnilistID:       12345,
					TitleRomaji:     &romaji,
					CoverImageUrl:   &cover,
					CoverImageColor: colorless,
					AverageScore:    &score,
					BangumiScore:    &bgmScore,
					Episodes:        &episodes,
					Season:          &season,
					SeasonYear:      &year,
					Status:          &status,
					Format:          &format,
					Description:     &desc,
				},
			}, nil
		},
	}

	rec := httptest.NewRecorder()
	CompletedGems(q).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/completed-gems?limit=1", nil))

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d", rec.Code)
	}
	// Spot-check byte-level parity tokens.  Full Express fixture comes
	// later when prod parity testing happens.
	want := []string{
		`{"data":[`,
		`"anilistId":12345`,
		`"titleRomaji":"Test Title Romaji"`,
		`"coverImageColor":null`,        // null preserved, not omitted
		`"averageScore":78`,             // whole number, no .00 suffix
		`"bangumiScore":7.6`,            // decimal preserved
		`"episodes":12`,
		`"season":"FALL"`,
		`"status":"FINISHED"`,
	}
	body := rec.Body.String()
	for _, frag := range want {
		if !strings.Contains(body, frag) {
			t.Errorf("body missing fragment %q\nfull: %s", frag, body)
		}
	}
}
