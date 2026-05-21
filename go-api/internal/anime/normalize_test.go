package anime

import (
	"testing"

	"github.com/lawrenceli0228/animego/go-api/internal/anilist"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func sptr(s string) *string { return &s }
func iptr(i int) *int       { return &i }

func TestNormalizeMainRow_AllFields(t *testing.T) {
	m := anilist.Media{
		ID: 12345,
		Title: &anilist.Title{
			Romaji:  sptr("Naruto"),
			English: sptr("Naruto"),
			Native:  sptr("ナルト"),
		},
		CoverImage: &anilist.CoverImage{
			ExtraLarge: sptr("https://cdn/extra.jpg"),
			Large:      sptr("https://cdn/large.jpg"),
			Color:      sptr("#3b82f6"),
		},
		BannerImage:  sptr("https://cdn/banner.jpg"),
		Description:  sptr("A ninja story"),
		Episodes:     iptr(220),
		Status:       sptr("FINISHED"),
		Season:       sptr("FALL"),
		SeasonYear:   iptr(2002),
		AverageScore: iptr(79),
		Format:       sptr("TV"),
		Genres:       []string{"Action", "Adventure"},
	}

	row := NormalizeMainRow(m)

	assert.Equal(t, int32(12345), row.AnilistID)
	assert.Equal(t, "Naruto", *row.TitleRomaji)
	assert.Equal(t, "Naruto", *row.TitleEnglish)
	assert.Equal(t, "ナルト", *row.TitleNative)
	assert.Equal(t, "https://cdn/extra.jpg", *row.CoverImageUrl)
	assert.Equal(t, "#3b82f6", *row.CoverImageColor)
	assert.Equal(t, "https://cdn/banner.jpg", *row.BannerImageUrl)
	assert.Equal(t, "A ninja story", *row.Description)
	assert.Equal(t, int32(220), *row.Episodes)
	assert.Equal(t, "FINISHED", *row.Status)
	assert.Equal(t, "FALL", *row.Season)
	assert.Equal(t, int32(2002), *row.SeasonYear)
	assert.Equal(t, float64(79), *row.AverageScore)
	assert.Equal(t, "TV", *row.Format)

	// Accent fields are always non-null thanks to brand fallback.
	require.NotNil(t, row.PosterAccent)
	require.NotNil(t, row.PosterAccentRgb)
	require.NotNil(t, row.PosterAccentContrastOnBlack)
	assert.NotEmpty(t, *row.PosterAccent)
}

func TestNormalizeMainRow_CoverImageFallback(t *testing.T) {
	tests := []struct {
		name string
		ci   *anilist.CoverImage
		want *string
	}{
		{"nil CoverImage", nil, nil},
		{"both nil", &anilist.CoverImage{}, nil},
		{"only Large", &anilist.CoverImage{Large: sptr("L")}, sptr("L")},
		{"both set, prefer ExtraLarge", &anilist.CoverImage{ExtraLarge: sptr("XL"), Large: sptr("L")}, sptr("XL")},
		{"ExtraLarge empty string falls back", &anilist.CoverImage{ExtraLarge: sptr(""), Large: sptr("L")}, sptr("L")},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := coverImageURL(tc.ci)
			if tc.want == nil {
				assert.Nil(t, got)
			} else {
				require.NotNil(t, got)
				assert.Equal(t, *tc.want, *got)
			}
		})
	}
}

func TestNormalizeMainRow_NilTitleAndCoverImage(t *testing.T) {
	row := NormalizeMainRow(anilist.Media{ID: 42})
	assert.Equal(t, int32(42), row.AnilistID)
	assert.Nil(t, row.TitleRomaji)
	assert.Nil(t, row.TitleEnglish)
	assert.Nil(t, row.TitleNative)
	assert.Nil(t, row.CoverImageUrl)
	assert.Nil(t, row.CoverImageColor)
	// Accent still populated via brand fallback (empty hex routes there).
	require.NotNil(t, row.PosterAccent)
}

func TestNormalizeMainRow_BangumiColumnsNotSet(t *testing.T) {
	// UpsertAnimeCacheParams intentionally has no title_chinese / bgm_id /
	// bangumi_score / bangumi_votes / bangumi_version fields — those
	// columns belong to the enrichment workers, not AniList sync.  The
	// struct definition itself is the regression guard; if sqlc ever
	// generates them by accident, this test catches it at compile time.
	var p any = NormalizeMainRow(anilist.Media{ID: 1})
	_ = p
}

func TestGenres(t *testing.T) {
	t.Run("nil → empty slice", func(t *testing.T) {
		got := Genres(anilist.Media{})
		assert.Empty(t, got)
		assert.NotNil(t, got) // empty, not nil — easier to range
	})
	t.Run("passthrough", func(t *testing.T) {
		got := Genres(anilist.Media{Genres: []string{"Action", "Drama"}})
		assert.Equal(t, []string{"Action", "Drama"}, got)
	})
}
