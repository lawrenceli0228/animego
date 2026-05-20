package transforms

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.mongodb.org/mongo-driver/v2/bson"
)

// rowsByTable groups emitted PGRows by Table for ergonomic assertions.
func rowsByTable(rows []pgRowLike) map[string][]map[string]any {
	out := make(map[string][]map[string]any)
	for _, r := range rows {
		out[r.Table] = append(out[r.Table], zipColsVals(r.Columns, r.Values))
	}
	return out
}

// pgRowLike is a structural copy of migrate.PGRow used for assertions.
// Keeps tests independent of migrate.PGRow's package while exercising the
// same fields the orchestrator consumes.
type pgRowLike struct {
	Table   string
	Columns []string
	Values  []any
}

// callTransform runs the transform and converts migrate.PGRow slice into
// the local pgRowLike slice the assertions use.
func callTransform(t *testing.T, doc bson.M) ([]pgRowLike, error) {
	t.Helper()
	tr := animeCacheTransform{}
	rows, err := tr.TransformRow(context.Background(), doc)
	if err != nil {
		return nil, err
	}
	out := make([]pgRowLike, len(rows))
	for i, r := range rows {
		out[i] = pgRowLike{Table: r.Table, Columns: r.Columns, Values: r.Values}
	}
	return out, nil
}

func TestAnimeCacheTransform_Minimal(t *testing.T) {
	t.Parallel()
	doc := bson.M{
		"anilistId":   12345,
		"titleRomaji": "Bocchi the Rock!",
	}
	rows, err := callTransform(t, doc)
	require.NoError(t, err)
	require.Len(t, rows, 1, "minimal doc should produce only the main row")

	r := rows[0]
	assert.Equal(t, "anime_cache", r.Table)
	require.Equal(t, len(r.Columns), len(r.Values))
	main := zipColsVals(r.Columns, r.Values)
	assert.Equal(t, 12345, main["anilist_id"])
	assert.Equal(t, "Bocchi the Rock!", main["title_romaji"])
	assert.Nil(t, main["title_english"].(*string))
	assert.Nil(t, main["start_date"])
	assert.Nil(t, main["admin_flag"].(*string))
	// search_vec must NOT be in Columns (generated column)
	for _, c := range r.Columns {
		assert.NotEqual(t, "search_vec", c)
	}
}

func TestAnimeCacheTransform_FullFanOut(t *testing.T) {
	t.Parallel()
	doc := bson.M{
		"anilistId":                   42,
		"titleRomaji":                 "Hyouka",
		"titleEnglish":                "Hyouka",
		"titleNative":                 "氷菓",
		"titleChinese":                "冰菓",
		"coverImageUrl":               "https://cover.example/42.jpg",
		"coverImageColor":             "#abc",
		"posterAccent":                "#102030",
		"posterAccentRgb":             "16,32,48",
		"posterAccentContrastOnBlack": 4.5,
		"bannerImageUrl":              "https://banner.example/42.jpg",
		"description":                 "School mystery.",
		"episodes":                    22,
		"status":                      "FINISHED",
		"season":                      "SPRING",
		"seasonYear":                  2012,
		"averageScore":                81.0,
		"format":                      "TV",
		"duration":                    24,
		"source":                      "MANGA",
		"bgmId":                       17,
		"bangumiScore":                8.4,
		"bangumiVotes":                1234,
		"bangumiVersion":              3,
		"adminFlag":                   "manually-corrected",
		"genres": bson.A{
			"Mystery", "Slice of Life", "",
		},
		"studios": bson.A{"Kyoto Animation"},
		"relations": bson.A{
			bson.M{
				"anilistId":                   43,
				"relationType":                "SEQUEL",
				"title":                       "Hyouka 2",
				"coverImageUrl":               "https://cover.example/43.jpg",
				"coverImageColor":             "#ddd",
				"posterAccent":                "#333",
				"posterAccentRgb":             "51,51,51",
				"posterAccentContrastOnBlack": 7.2,
				"format":                      "TV",
			},
			bson.M{
				"anilistId":    44,
				"relationType": "PREQUEL",
				"title":        "Hyouka 0",
				"format":       "TV",
			},
		},
		"characters": bson.A{
			bson.M{
				"nameEn":             "Houtarou Oreki",
				"nameJa":             "折木 奉太郎",
				"nameCn":             "折木奉太郎",
				"imageUrl":           "https://char.example/1.jpg",
				"role":               "MAIN",
				"voiceActorEn":       "Yuichi Nakamura",
				"voiceActorJa":       "中村悠一",
				"voiceActorCn":       "中村悠一",
				"voiceActorImageUrl": "https://va.example/1.jpg",
			},
			bson.M{
				"nameEn": "Eru Chitanda",
				"role":   "MAIN",
			},
		},
		"staff": bson.A{
			bson.M{
				"nameEn":   "Yasuhiro Takemoto",
				"nameJa":   "武本康弘",
				"imageUrl": "https://staff.example/1.jpg",
				"role":     "Director",
			},
		},
		"recommendations": bson.A{
			bson.M{
				"anilistId":                   100,
				"title":                       "Haruhi",
				"coverImageUrl":               "https://cover.example/100.jpg",
				"coverImageColor":             "#fff",
				"posterAccent":                "#abc",
				"posterAccentRgb":             "10,20,30",
				"posterAccentContrastOnBlack": 5.5,
				"averageScore":                79.0,
			},
		},
		"episodeTitles": bson.A{
			bson.M{"episode": 1, "name": "The Revival of the Classics Club", "nameCn": "古典部的复活"},
			bson.M{"episode": 2, "name": "The Activities of the Esteemed Classics Club"},
		},
		"startDate": bson.M{"year": 2012, "month": 4, "day": 22},
	}

	rows, err := callTransform(t, doc)
	require.NoError(t, err)

	byTable := rowsByTable(rows)
	require.Len(t, byTable["anime_cache"], 1)
	assert.Len(t, byTable["anime_genres"], 2, "empty string genre must be skipped")
	assert.Len(t, byTable["anime_studios"], 1)
	assert.Len(t, byTable["anime_relations"], 2)
	assert.Len(t, byTable["anime_characters"], 2)
	assert.Len(t, byTable["anime_staff"], 1)
	assert.Len(t, byTable["anime_recommendations"], 1)
	assert.Len(t, byTable["anime_episode_titles"], 2)

	// Spot-check anime_cache row coverage.
	main := byTable["anime_cache"][0]
	assert.Equal(t, 42, main["anilist_id"])
	assert.Equal(t, "Hyouka", main["title_romaji"])
	require.NotNil(t, main["start_date"])
	sd := *main["start_date"].(*time.Time)
	assert.Equal(t, time.Date(2012, 4, 22, 0, 0, 0, 0, time.UTC), sd)
	flag := main["admin_flag"].(*string)
	require.NotNil(t, flag)
	assert.Equal(t, "manually-corrected", *flag)

	// genres are unordered in PG but emit order matches array order.
	gs := []string{
		byTable["anime_genres"][0]["genre"].(string),
		byTable["anime_genres"][1]["genre"].(string),
	}
	assert.Contains(t, gs, "Mystery")
	assert.Contains(t, gs, "Slice of Life")

	// First character display_order=0 with all VA fields.
	char0 := byTable["anime_characters"][0]
	assert.Equal(t, 0, char0["display_order"])
	assert.Equal(t, 42, char0["anime_id"])
	vaEn := char0["voice_actor_en"].(*string)
	require.NotNil(t, vaEn)
	assert.Equal(t, "Yuichi Nakamura", *vaEn)

	// Second character display_order=1 with only nameEn (others nil).
	char1 := byTable["anime_characters"][1]
	assert.Equal(t, 1, char1["display_order"])
	assert.Nil(t, char1["voice_actor_en"].(*string))
	assert.Nil(t, char1["voice_actor_ja"].(*string))
	assert.Nil(t, char1["name_cn"].(*string))

	// Staff display_order=0
	st0 := byTable["anime_staff"][0]
	assert.Equal(t, 0, st0["display_order"])

	// Deterministic uuid: a second call yields identical IDs.
	rows2, err := callTransform(t, doc)
	require.NoError(t, err)
	byTable2 := rowsByTable(rows2)
	assert.Equal(t,
		byTable["anime_characters"][0]["id"],
		byTable2["anime_characters"][0]["id"],
		"child UUIDs must be deterministic across runs",
	)
}

func TestAnimeCacheTransform_EmptyArrays(t *testing.T) {
	t.Parallel()
	doc := bson.M{
		"anilistId":   7,
		"titleRomaji": "Empty",
		"genres":      bson.A{},
		"studios":     bson.A{},
		"relations":   bson.A{},
		"characters":  bson.A{},
		"staff":       bson.A{},
		// recommendations + episodeTitles absent entirely
	}
	rows, err := callTransform(t, doc)
	require.NoError(t, err)
	require.Len(t, rows, 1, "empty arrays must not emit child rows")
	assert.Equal(t, "anime_cache", rows[0].Table)
}

func TestAnimeCacheTransform_MissingAnilistID(t *testing.T) {
	t.Parallel()
	doc := bson.M{
		"titleRomaji": "Nameless",
	}
	rows, err := callTransform(t, doc)
	require.Error(t, err)
	assert.Nil(t, rows)
	assert.Contains(t, err.Error(), "anilistId")
}

func TestAnimeCacheTransform_FullStartDate(t *testing.T) {
	t.Parallel()
	doc := bson.M{
		"anilistId":   1,
		"titleRomaji": "X",
		"startDate":   bson.M{"year": 2024, "month": 1, "day": 15},
	}
	rows, err := callTransform(t, doc)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	main := zipColsVals(rows[0].Columns, rows[0].Values)
	require.NotNil(t, main["start_date"])
	sd := *main["start_date"].(*time.Time)
	assert.Equal(t, time.Date(2024, 1, 15, 0, 0, 0, 0, time.UTC), sd)
}

func TestAnimeCacheTransform_PartialStartDate(t *testing.T) {
	t.Parallel()
	doc := bson.M{
		"anilistId":   2,
		"titleRomaji": "Y",
		"startDate":   bson.M{"year": 2024, "month": 0, "day": 0},
	}
	rows, err := callTransform(t, doc)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	main := zipColsVals(rows[0].Columns, rows[0].Values)
	assert.Nil(t, main["start_date"], "partial start_date components must collapse to nil")
}

func TestAnimeCacheTransform_CachedAtFromMongo(t *testing.T) {
	t.Parallel()
	cached := bson.NewDateTimeFromTime(time.Date(2025, 6, 1, 12, 0, 0, 0, time.UTC))
	doc := bson.M{
		"anilistId":   99,
		"titleRomaji": "Z",
		"cachedAt":    cached,
	}
	rows, err := callTransform(t, doc)
	require.NoError(t, err)
	main := zipColsVals(rows[0].Columns, rows[0].Values)
	got, ok := main["cached_at"].(time.Time)
	require.True(t, ok)
	assert.Equal(t, cached.Time().UTC(), got)
}

func TestAnimeCacheTransform_ChildUUIDStable(t *testing.T) {
	t.Parallel()
	id1 := childUUID("anime_characters", 42, 0)
	id2 := childUUID("anime_characters", 42, 0)
	idDiff := childUUID("anime_characters", 42, 1)
	idTable := childUUID("anime_staff", 42, 0)
	assert.Equal(t, id1, id2, "same (table,id,idx) must yield same uuid")
	assert.NotEqual(t, id1, idDiff)
	assert.NotEqual(t, id1, idTable)
	_, err := uuid.Parse(id1.String())
	require.NoError(t, err)
}

func TestAnimeCacheTransform_Metadata(t *testing.T) {
	t.Parallel()
	tr := animeCacheTransform{}
	assert.Equal(t, "anime_cache", tr.Name())
	assert.Equal(t, "anime_cache", tr.MongoCollection())
	assert.Equal(t, "anime_cache", tr.PGTable())
	assert.Equal(t, "(anilist_id)", tr.ConflictTarget())
	assert.Nil(t, tr.DependsOn())
}
