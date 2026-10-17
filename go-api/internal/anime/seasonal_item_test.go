package anime

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/anilist"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

func f64(v float64) *float64 { return &v }

// seasonalLegacyFullRow is a row with every pre-existing column set, and
// seasonalLegacyFullJSON is how /api/anime/seasonal encoded exactly that
// row when dbgen.GetSeasonalAnimeRow was the response -- captured from the
// code before seasonalItem existed, HTML characters and all, because the
// envelope writer turns HTML escaping off.  The closing brace is left off:
// the new fields follow it.
func seasonalLegacyFullRow() dbgen.GetSeasonalAnimeRow {
	return dbgen.GetSeasonalAnimeRow{
		AnilistID:             195516,
		TitleRomaji:           sptr("Kusuriya no Hitorigoto 3rd Season"),
		TitleEnglish:          sptr("The Apothecary Diaries Season 3"),
		TitleNative:           sptr("薬屋のひとりごと 第3期"),
		TitleChinese:          sptr("药屋少女的呢喃 第三季"),
		TitleHant:             sptr("藥屋少女的呢喃 第三季"),
		TitleHantSource:       sptr("opencc"),
		TitleHantSeo:          sptr("藥屋少女的呢喃 第三季"),
		CoverImageUrl:         sptr("https://s4.anilist.co/file/a.jpg?x=1&y=<2>"),
		BannerImageUrl:        sptr("https://s4.anilist.co/file/b.jpg"),
		CoverImageColor:       sptr("#e4a15d"),
		PosterAccent:          sptr("#e4a15d"),
		AverageScore:          f64(87),
		BangumiScore:          f64(8.25),
		Episodes:              i32(24),
		Season:                sptr("FALL"),
		SeasonYear:            i32(2026),
		Status:                sptr("RELEASING"),
		Format:                sptr("TV"),
		Description:           sptr("Maomao <br>\"quoted\" & more"),
		DescriptionCn:         sptr("猫猫"),
		DescriptionCnSource:   sptr("bangumi"),
		DescriptionHant:       sptr("貓貓"),
		DescriptionHantSource: sptr("opencc"),
		Genres:                []string{"Drama", "Mystery"},
		DiscussionCount:       3,
		TrailerID:             sptr("abcdefghijk"),
		TrailerSite:           sptr("youtube"),
	}
}

const seasonalLegacyFullJSON = `{"anilistId":195516,"titleRomaji":"Kusuriya no Hitorigoto 3rd Season","titleEnglish":"The Apothecary Diaries Season 3","titleNative":"薬屋のひとりごと 第3期","titleChinese":"药屋少女的呢喃 第三季","titleHant":"藥屋少女的呢喃 第三季","titleHantSource":"opencc","titleHantSeo":"藥屋少女的呢喃 第三季","coverImageUrl":"https://s4.anilist.co/file/a.jpg?x=1&y=<2>","bannerImageUrl":"https://s4.anilist.co/file/b.jpg","coverImageColor":"#e4a15d","posterAccent":"#e4a15d","averageScore":87,"bangumiScore":8.25,"episodes":24,"season":"FALL","seasonYear":2026,"status":"RELEASING","format":"TV","description":"Maomao <br>\"quoted\" & more","descriptionCn":"猫猫","descriptionCnSource":"bangumi","descriptionHant":"貓貓","descriptionHantSource":"opencc","genres":["Drama","Mystery"],"discussionCount":3,"trailerId":"abcdefghijk","trailerSite":"youtube"`

// seasonalLegacyEmptyJSON is the same capture for a row with nothing but
// an id: every pointer null, genres null (a nil slice), the count zero.
const seasonalLegacyEmptyJSON = `{"anilistId":7,"titleRomaji":null,"titleEnglish":null,"titleNative":null,"titleChinese":null,"titleHant":null,"titleHantSource":null,"titleHantSeo":null,"coverImageUrl":null,"bannerImageUrl":null,"coverImageColor":null,"posterAccent":null,"averageScore":null,"bangumiScore":null,"episodes":null,"season":null,"seasonYear":null,"status":null,"format":null,"description":null,"descriptionCn":null,"descriptionCnSource":null,"descriptionHant":null,"descriptionHantSource":null,"genres":null,"discussionCount":0,"trailerId":null,"trailerSite":null`

// seasonalNullNewFieldsJSON is how the new fields encode when the row has
// none of them: every key present, every value null, isSequel null (the
// detail fetch has not reached the row, so its relations are not known).
const seasonalNullNewFieldsJSON = `,"studio":null,"nextAiringAt":null,"nextAiringEpisode":null,"popularity":null,"favourites":null,"source":null,"startDate":null,"duration":null,"isSequel":null}`

// encodeLikeTheEnvelope encodes v the way writeMultiKeyEnvelope does:
// HTML escaping off, no trailing newline.
func encodeLikeTheEnvelope(t *testing.T, v any) string {
	t.Helper()
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	require.NoError(t, enc.Encode(v))
	return strings.TrimRight(buf.String(), "\n")
}

// TestSeasonalItem_LegacyFieldsEncodeAsBefore — the response used to be
// the sqlc row itself, and a downstream Go client decodes it.  Every field
// that existed then must come out byte for byte as it did, in the same
// order, with the new fields appended after them.
func TestSeasonalItem_LegacyFieldsEncodeAsBefore(t *testing.T) {
	t.Parallel()

	t.Run("every legacy column set, no new column set", func(t *testing.T) {
		got := encodeLikeTheEnvelope(t, seasonalItemFromRow(seasonalLegacyFullRow()))
		assert.Equal(t, seasonalLegacyFullJSON+seasonalNullNewFieldsJSON, got)
	})

	t.Run("only the id set", func(t *testing.T) {
		got := encodeLikeTheEnvelope(t, seasonalItemFromRow(dbgen.GetSeasonalAnimeRow{AnilistID: 7}))
		assert.Equal(t, seasonalLegacyEmptyJSON+seasonalNullNewFieldsJSON, got)
	})

	t.Run("new columns set leave the legacy bytes alone", func(t *testing.T) {
		row := seasonalLegacyFullRow()
		row.MainStudio = []string{"Studio Cloud & <Sky>"}
		row.NextAiringAt = pgtype.Timestamptz{Time: time.Date(2026, 10, 22, 14, 0, 0, 0, time.UTC), Valid: true}
		row.NextAiringEpisode = i32(4)
		row.Popularity = i32(123456)
		row.Favourites = i32(7890)
		row.Source = sptr("LIGHT_NOVEL")
		row.StartDate = pgtype.Date{Time: time.Date(2026, 10, 2, 0, 0, 0, 0, time.UTC), Valid: true}
		row.Duration = i32(24)
		row.IsSequel = true
		row.RelationsKnown = true

		got := encodeLikeTheEnvelope(t, seasonalItemFromRow(row))
		assert.Equal(t, seasonalLegacyFullJSON+
			`,"studio":"Studio Cloud & <Sky>","nextAiringAt":"2026-10-22T14:00:00Z","nextAiringEpisode":4,`+
			`"popularity":123456,"favourites":7890,"source":"LIGHT_NOVEL","startDate":"2026-10-02",`+
			`"duration":24,"isSequel":true}`, got)
	})
}

// TestSeasonalItem_NextAiringAtIsUTC — pgx scans a timestamptz into the
// process's local zone, and pgtype.Timestamptz would print it there.  The
// contract is RFC 3339 in UTC whatever zone the server runs in.
func TestSeasonalItem_NextAiringAtIsUTC(t *testing.T) {
	t.Parallel()

	beijing := time.FixedZone("UTC+8", 8*60*60)
	sydney := time.FixedZone("UTC+11", 11*60*60)
	instant := time.Date(2026, 10, 22, 22, 0, 0, 0, beijing) // 14:00 UTC

	for name, at := range map[string]time.Time{
		"scanned in UTC+8":  instant,
		"scanned in UTC+11": instant.In(sydney),
		"scanned in UTC":    instant.UTC(),
	} {
		t.Run(name, func(t *testing.T) {
			item := seasonalItemFromRow(dbgen.GetSeasonalAnimeRow{
				NextAiringAt:      pgtype.Timestamptz{Time: at, Valid: true},
				NextAiringEpisode: i32(4),
			})
			body := encodeLikeTheEnvelope(t, item)
			assert.Contains(t, body, `"nextAiringAt":"2026-10-22T14:00:00Z","nextAiringEpisode":4,`)

			require.NotNil(t, item.NextAiringAt)
			assert.Equal(t, time.UTC, item.NextAiringAt.Location())
			assert.True(t, item.NextAiringAt.Equal(instant), "the instant itself must not move")
		})
	}
}

// TestFirstOrNil — the main studio arrives as an array of at most one;
// empty is null on the wire, and the pointer is a copy, not an alias into
// the row's slice.
func TestFirstOrNil(t *testing.T) {
	t.Parallel()

	assert.Nil(t, firstOrNil(nil))
	assert.Nil(t, firstOrNil([]string{}))

	in := []string{"Alpha Studio"}
	got := firstOrNil(in)
	require.NotNil(t, got)
	assert.Equal(t, "Alpha Studio", *got)
	in[0] = "changed"
	assert.Equal(t, "Alpha Studio", *got)

	assert.Equal(t, sptr("First"), firstOrNil([]string{"First", "Second"}))
}

func TestUTCInstant(t *testing.T) {
	t.Parallel()

	at := time.Date(2026, 10, 22, 14, 0, 0, 0, time.UTC)
	for name, tc := range map[string]struct {
		in   pgtype.Timestamptz
		want *time.Time
	}{
		"null":      {in: pgtype.Timestamptz{}, want: nil},
		"finite":    {in: pgtype.Timestamptz{Time: at, Valid: true}, want: &at},
		"infinity":  {in: pgtype.Timestamptz{Valid: true, InfinityModifier: pgtype.Infinity}, want: nil},
		"-infinity": {in: pgtype.Timestamptz{Valid: true, InfinityModifier: pgtype.NegativeInfinity}, want: nil},
	} {
		t.Run(name, func(t *testing.T) {
			got := utcInstant(tc.in)
			if tc.want == nil {
				assert.Nil(t, got)
				return
			}
			require.NotNil(t, got)
			assert.True(t, got.Equal(*tc.want))
		})
	}
}

// TestCalendarDate — YYYY-MM-DD for a stored date, null for none.  A date
// is never shifted by a zone: pgx scans it as midnight UTC, and the format
// reads the calendar fields straight off it.
func TestCalendarDate(t *testing.T) {
	t.Parallel()

	for name, tc := range map[string]struct {
		in   pgtype.Date
		want *string
	}{
		"null":             {in: pgtype.Date{}, want: nil},
		"date":             {in: pgtype.Date{Time: time.Date(2026, 10, 2, 0, 0, 0, 0, time.UTC), Valid: true}, want: sptr("2026-10-02")},
		"first of january": {in: pgtype.Date{Time: time.Date(2027, 1, 1, 0, 0, 0, 0, time.UTC), Valid: true}, want: sptr("2027-01-01")},
		"infinity":         {in: pgtype.Date{Valid: true, InfinityModifier: pgtype.Infinity}, want: nil},
		"-infinity":        {in: pgtype.Date{Valid: true, InfinityModifier: pgtype.NegativeInfinity}, want: nil},
	} {
		t.Run(name, func(t *testing.T) {
			assert.Equal(t, tc.want, calendarDate(tc.in))
		})
	}
}

// TestSeasonalItemsFromRows_NeverNil — an empty page is [] on the wire.
func TestSeasonalItemsFromRows_NeverNil(t *testing.T) {
	t.Parallel()

	for _, rows := range [][]dbgen.GetSeasonalAnimeRow{nil, {}} {
		got := seasonalItemsFromRows(rows)
		require.NotNil(t, got)
		assert.Equal(t, "[]", encodeLikeTheEnvelope(t, got))
	}

	got := seasonalItemsFromRows([]dbgen.GetSeasonalAnimeRow{{AnilistID: 1}, {AnilistID: 2}})
	require.Len(t, got, 2)
	assert.Equal(t, int32(1), got[0].AnilistID)
	assert.Equal(t, int32(2), got[1].AnilistID)
}

// TestSeasonal_HandlerWritesTheItemShape — the handler goes through
// seasonalItem, not the row: the whole body, envelope included, is the
// legacy bytes plus the new fields.
func TestSeasonal_HandlerWritesTheItemShape(t *testing.T) {
	t.Parallel()

	db := &fakeSeasonalDB{
		getSeasonalAnimeFn: func(_ context.Context, _ *string, _ *int32, _, _ int32) ([]dbgen.GetSeasonalAnimeRow, error) {
			full := seasonalLegacyFullRow()
			full.NextAiringAt = pgtype.Timestamptz{Time: time.Date(2026, 10, 22, 22, 0, 0, 0, time.FixedZone("UTC+8", 8*60*60)), Valid: true}
			full.NextAiringEpisode = i32(4)
			full.StartDate = pgtype.Date{Time: time.Date(2026, 10, 2, 0, 0, 0, 0, time.UTC), Valid: true}
			full.RelationsKnown = true // fetched, and no anime prequel: a known false
			return []dbgen.GetSeasonalAnimeRow{full, {AnilistID: 7}}, nil
		},
		countSeasonalFn: func(_ context.Context, _ *string, _ *int32) (int64, error) { return 2, nil },
	}
	svc := NewSeasonalService(db, nil)

	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/seasonal?season=FALL&year=2026", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, `{"data":[`+
		seasonalLegacyFullJSON+`,"studio":null,"nextAiringAt":"2026-10-22T14:00:00Z","nextAiringEpisode":4,`+
		`"popularity":null,"favourites":null,"source":null,"startDate":"2026-10-02","duration":null,"isSequel":false},`+
		seasonalLegacyEmptyJSON+seasonalNullNewFieldsJSON+
		`],"pagination":{"page":1,"perPage":20,"total":2,"totalPages":1}}`, rec.Body.String())
}

// TestSeasonal_ColdStart_UpsertCarriesTheFacts — SeasonalAnimeQuery
// selects the four 0034 facts so the cold-start response has them; the
// upsert it feeds must carry them through rather than drop them for a
// listing document.
func TestSeasonal_ColdStart_UpsertCarriesTheFacts(t *testing.T) {
	t.Parallel()

	m := seasonalMediaWith(301)
	m.StartDate = &anilist.FuzzyDate{Year: iptr(2032), Month: iptr(1), Day: iptr(8)}
	m.EndDate = &anilist.FuzzyDate{Year: iptr(2032), Month: iptr(3), Day: iptr(25)}
	m.Duration = iptr(24)
	m.Source = sptr("ORIGINAL")
	m.Popularity = iptr(4321)
	m.Favourites = iptr(210)
	m.NextAiringEpisode = &anilist.NextAiringEpisode{AiringAt: 1957183200, Episode: 1} // 2032-01-08 14:00 UTC

	al := &fakeSeasonaler{
		fn: func(_ context.Context, _ anilist.SeasonalVars) (*anilist.SeasonalAnimeResponse, error) {
			return &anilist.SeasonalAnimeResponse{Page: anilist.MediaPage{
				PageInfo: anilist.PageInfo{Total: 1, CurrentPage: 1, LastPage: 1, PerPage: 20},
				Media:    []anilist.Media{m},
			}}, nil
		},
	}
	db := &fakeSeasonalDB{} // empty reads: the warm path misses
	svc := NewSeasonalService(db, al)

	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/anime/seasonal?season=WINTER&year=2032", nil))
	require.Equal(t, http.StatusOK, rec.Code)

	params := db.snapshotUpsertedParams()
	require.Len(t, params, 1)
	p := params[0]
	require.True(t, p.StartDate.Valid)
	assert.Equal(t, time.Date(2032, 1, 8, 0, 0, 0, 0, time.UTC), p.StartDate.Time)
	require.True(t, p.EndDate.Valid)
	assert.Equal(t, time.Date(2032, 3, 25, 0, 0, 0, 0, time.UTC), p.EndDate.Time)
	assert.Equal(t, i32(24), p.Duration)
	assert.Equal(t, sptr("ORIGINAL"), p.Source)
	assert.Equal(t, i32(4321), p.Popularity)
	assert.Equal(t, i32(210), p.Favourites)
	require.True(t, p.NextAiringAt.Valid)
	assert.Equal(t, int64(1957183200), p.NextAiringAt.Time.Unix())
	assert.Equal(t, i32(1), p.NextAiringEpisode)
	assert.False(t, p.DetailFetched, "a listing document must not stamp the detail fetch")
}
