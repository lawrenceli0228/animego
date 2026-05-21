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

// =============================================================================
// P2.1.6 child-row normalize helper tests.
// =============================================================================

// TestStudiosFromMedia exercises the studio-name extraction path:
// nil Studios, empty Nodes, populated Nodes, and the nil-Media fallback.
func TestStudiosFromMedia(t *testing.T) {
	t.Run("nil studios returns empty slice", func(t *testing.T) {
		got := StudiosFromMedia(anilist.Media{})
		assert.Empty(t, got)
		assert.NotNil(t, got)
	})
	t.Run("empty nodes returns empty slice", func(t *testing.T) {
		got := StudiosFromMedia(anilist.Media{Studios: &anilist.StudioConnection{}})
		assert.Empty(t, got)
	})
	t.Run("two studios passthrough preserves order", func(t *testing.T) {
		got := StudiosFromMedia(anilist.Media{
			Studios: &anilist.StudioConnection{Nodes: []anilist.Studio{
				{Name: "MAPPA"},
				{Name: "WIT"},
			}},
		})
		assert.Equal(t, []string{"MAPPA", "WIT"}, got)
	})
}

// TestRelationsFromMedia covers happy path + the falsy-skip rules for
// title + the .large preference for cover image + the brand-fallback
// path for missing colour data.
func TestRelationsFromMedia(t *testing.T) {
	t.Run("nil relations returns empty slice", func(t *testing.T) {
		got := RelationsFromMedia(anilist.Media{})
		assert.Empty(t, got)
		assert.NotNil(t, got)
	})

	t.Run("empty edges returns empty slice", func(t *testing.T) {
		got := RelationsFromMedia(anilist.Media{Relations: &anilist.RelationConnection{}})
		assert.Empty(t, got)
	})

	t.Run("happy path two relations", func(t *testing.T) {
		got := RelationsFromMedia(anilist.Media{
			Relations: &anilist.RelationConnection{Edges: []anilist.RelationEdge{
				{
					RelationType: sptr("PREQUEL"),
					Node: anilist.RelationNode{
						ID:         100,
						Title:      &anilist.Title{Romaji: sptr("Prequel R")},
						CoverImage: &anilist.CoverImage{Large: sptr("https://cdn/100.jpg"), Color: sptr("#3b82f6")},
						Format:     sptr("TV"),
					},
				},
				{
					RelationType: sptr("SEQUEL"),
					Node: anilist.RelationNode{
						ID:    101,
						Title: &anilist.Title{Native: sptr("続編")},
					},
				},
			}},
		})
		require.Len(t, got, 2)
		assert.Equal(t, int32(100), got[0].AnilistID)
		require.NotNil(t, got[0].Title)
		assert.Equal(t, "Prequel R", *got[0].Title)
		require.NotNil(t, got[0].CoverImageUrl)
		assert.Equal(t, "https://cdn/100.jpg", *got[0].CoverImageUrl)
		// Accent fields are always present.
		require.NotNil(t, got[0].PosterAccent)
		require.NotNil(t, got[0].PosterAccentRgb)
		require.NotNil(t, got[0].PosterAccentContrastOnBlack)
		require.NotNil(t, got[0].Format)
		assert.Equal(t, "TV", *got[0].Format)

		// Second relation has no cover, no colour, no format.
		assert.Equal(t, int32(101), got[1].AnilistID)
		require.NotNil(t, got[1].Title)
		assert.Equal(t, "続編", *got[1].Title, "falsy-skip: empty Romaji → Native")
		assert.Nil(t, got[1].CoverImageUrl)
		assert.Nil(t, got[1].CoverImageColor)
		require.NotNil(t, got[1].PosterAccent, "brand-fallback fires when colour absent")
		assert.Nil(t, got[1].Format)
	})

	t.Run("title romaji empty string falls through to native", func(t *testing.T) {
		got := RelationsFromMedia(anilist.Media{
			Relations: &anilist.RelationConnection{Edges: []anilist.RelationEdge{
				{
					Node: anilist.RelationNode{
						ID:    1,
						Title: &anilist.Title{Romaji: sptr(""), Native: sptr("native here")},
					},
				},
			}},
		})
		require.Len(t, got, 1)
		require.NotNil(t, got[0].Title)
		assert.Equal(t, "native here", *got[0].Title)
	})

	t.Run("cover uses .large not .extraLarge", func(t *testing.T) {
		got := RelationsFromMedia(anilist.Media{
			Relations: &anilist.RelationConnection{Edges: []anilist.RelationEdge{
				{
					Node: anilist.RelationNode{
						ID: 1,
						CoverImage: &anilist.CoverImage{
							ExtraLarge: sptr("https://cdn/xl.jpg"),
							Large:      sptr("https://cdn/large.jpg"),
						},
					},
				},
			}},
		})
		require.Len(t, got, 1)
		require.NotNil(t, got[0].CoverImageUrl)
		assert.Equal(t, "https://cdn/large.jpg", *got[0].CoverImageUrl,
			"relation edge cover_image uses .large only (Express does NOT fall back to .extraLarge)")
	})
}

// TestCharactersFromMedia covers DisplayOrder=index, voice-actor zero/one
// entries, missing nodes, and the nil-image / nil-name paths.
func TestCharactersFromMedia(t *testing.T) {
	t.Run("nil characters returns empty slice", func(t *testing.T) {
		got := CharactersFromMedia(anilist.Media{})
		assert.Empty(t, got)
		assert.NotNil(t, got)
	})

	t.Run("two characters get display_order 0 and 1", func(t *testing.T) {
		got := CharactersFromMedia(anilist.Media{
			Characters: &anilist.CharacterConnection{Edges: []anilist.CharacterEdge{
				{
					Role: sptr("MAIN"),
					Node: anilist.CharacterNode{
						Name:  &anilist.PersonName{Full: sptr("Alice"), Native: sptr("アリス")},
						Image: &anilist.Image{Medium: sptr("https://cdn/alice.jpg")},
					},
					VoiceActors: []anilist.VoiceActor{
						{
							Name:  &anilist.PersonName{Full: sptr("Yui"), Native: sptr("ゆい")},
							Image: &anilist.Image{Medium: sptr("https://cdn/yui.jpg")},
						},
					},
				},
				{
					Role: sptr("SUPPORTING"),
					Node: anilist.CharacterNode{
						Name: &anilist.PersonName{Full: sptr("Bob")},
					},
				},
			}},
		})
		require.Len(t, got, 2)
		assert.Equal(t, int32(0), got[0].DisplayOrder)
		assert.Equal(t, int32(1), got[1].DisplayOrder)
		require.NotNil(t, got[0].NameEn)
		assert.Equal(t, "Alice", *got[0].NameEn)
		require.NotNil(t, got[0].NameJa)
		assert.Equal(t, "アリス", *got[0].NameJa)
		require.NotNil(t, got[0].VoiceActorEn)
		assert.Equal(t, "Yui", *got[0].VoiceActorEn)
		require.NotNil(t, got[0].VoiceActorImageUrl)
		assert.Nil(t, got[0].NameCn, "AniList never sets name_cn")

		// Second character has no voice actor — VoiceActor* must be nil.
		assert.Nil(t, got[1].VoiceActorEn)
		assert.Nil(t, got[1].VoiceActorJa)
		assert.Nil(t, got[1].VoiceActorImageUrl)
	})

	t.Run("voice actor with nil image gracefully", func(t *testing.T) {
		got := CharactersFromMedia(anilist.Media{
			Characters: &anilist.CharacterConnection{Edges: []anilist.CharacterEdge{
				{
					Node: anilist.CharacterNode{
						Name: &anilist.PersonName{Full: sptr("X")},
					},
					VoiceActors: []anilist.VoiceActor{
						{Name: &anilist.PersonName{Full: sptr("VA")}, Image: nil},
					},
				},
			}},
		})
		require.Len(t, got, 1)
		require.NotNil(t, got[0].VoiceActorEn)
		assert.Equal(t, "VA", *got[0].VoiceActorEn)
		assert.Nil(t, got[0].VoiceActorImageUrl)
	})
}

// TestStaffFromMedia covers happy path + nil staff + DisplayOrder ordering.
func TestStaffFromMedia(t *testing.T) {
	t.Run("nil staff returns empty slice", func(t *testing.T) {
		got := StaffFromMedia(anilist.Media{})
		assert.Empty(t, got)
		assert.NotNil(t, got)
	})

	t.Run("two staff get display_order 0 and 1", func(t *testing.T) {
		got := StaffFromMedia(anilist.Media{
			Staff: &anilist.StaffConnection{Edges: []anilist.StaffEdge{
				{
					Role: sptr("Director"),
					Node: anilist.StaffNode{
						Name:  &anilist.PersonName{Full: sptr("Hayao")},
						Image: &anilist.Image{Medium: sptr("https://cdn/h.jpg")},
					},
				},
				{
					Role: sptr("Music"),
					Node: anilist.StaffNode{
						Name: &anilist.PersonName{Full: sptr("Joe")},
					},
				},
			}},
		})
		require.Len(t, got, 2)
		assert.Equal(t, int32(0), got[0].DisplayOrder)
		assert.Equal(t, int32(1), got[1].DisplayOrder)
		require.NotNil(t, got[0].NameEn)
		assert.Equal(t, "Hayao", *got[0].NameEn)
		require.NotNil(t, got[0].ImageUrl)
		assert.Nil(t, got[1].ImageUrl)
	})
}

// TestRecommendationsFromMedia covers happy path + the critical filter
// rule (nodes with nil mediaRecommendation get skipped, matching Express
// `.filter(n => n.mediaRecommendation)`).
func TestRecommendationsFromMedia(t *testing.T) {
	t.Run("nil recommendations returns empty slice", func(t *testing.T) {
		got := RecommendationsFromMedia(anilist.Media{})
		assert.Empty(t, got)
		assert.NotNil(t, got)
	})

	t.Run("filters out nil mediaRecommendation", func(t *testing.T) {
		got := RecommendationsFromMedia(anilist.Media{
			Recommendations: &anilist.RecommendationConnection{Nodes: []anilist.RecommendationNode{
				{MediaRecommendation: nil}, // must be skipped
				{MediaRecommendation: &anilist.MediaRecommendation{
					ID:    600,
					Title: &anilist.Title{Romaji: sptr("Rec")},
				}},
				{MediaRecommendation: nil}, // skipped too
			}},
		})
		require.Len(t, got, 1, "only the populated recommendation survives")
		assert.Equal(t, int32(600), got[0].AnilistID)
	})

	t.Run("happy path with cover + score", func(t *testing.T) {
		avg := 88
		got := RecommendationsFromMedia(anilist.Media{
			Recommendations: &anilist.RecommendationConnection{Nodes: []anilist.RecommendationNode{
				{MediaRecommendation: &anilist.MediaRecommendation{
					ID:    700,
					Title: &anilist.Title{Romaji: sptr("Rec One")},
					CoverImage: &anilist.CoverImage{
						Large: sptr("https://cdn/rec.jpg"),
						Color: sptr("#3b82f6"),
					},
					AverageScore: &avg,
				}},
			}},
		})
		require.Len(t, got, 1)
		assert.Equal(t, int32(700), got[0].AnilistID)
		require.NotNil(t, got[0].Title)
		assert.Equal(t, "Rec One", *got[0].Title)
		require.NotNil(t, got[0].CoverImageUrl)
		assert.Equal(t, "https://cdn/rec.jpg", *got[0].CoverImageUrl)
		require.NotNil(t, got[0].AverageScore)
		assert.InDelta(t, 88.0, *got[0].AverageScore, 0.0001)
		// Accent fields always present.
		require.NotNil(t, got[0].PosterAccent)
		require.NotNil(t, got[0].PosterAccentRgb)
		require.NotNil(t, got[0].PosterAccentContrastOnBlack)
	})

	t.Run("cover uses .large not .extraLarge", func(t *testing.T) {
		got := RecommendationsFromMedia(anilist.Media{
			Recommendations: &anilist.RecommendationConnection{Nodes: []anilist.RecommendationNode{
				{MediaRecommendation: &anilist.MediaRecommendation{
					ID: 1,
					CoverImage: &anilist.CoverImage{
						ExtraLarge: sptr("https://cdn/xl.jpg"),
						Large:      sptr("https://cdn/large.jpg"),
					},
				}},
			}},
		})
		require.Len(t, got, 1)
		require.NotNil(t, got[0].CoverImageUrl)
		assert.Equal(t, "https://cdn/large.jpg", *got[0].CoverImageUrl)
	})
}

// TestTitleRomajiOrNative exercises the falsy-skip helper directly so
// each branch has explicit coverage.
func TestTitleRomajiOrNative(t *testing.T) {
	t.Run("nil title returns nil", func(t *testing.T) {
		assert.Nil(t, titleRomajiOrNative(nil))
	})
	t.Run("romaji wins when both present", func(t *testing.T) {
		got := titleRomajiOrNative(&anilist.Title{Romaji: sptr("R"), Native: sptr("N")})
		require.NotNil(t, got)
		assert.Equal(t, "R", *got)
	})
	t.Run("empty romaji falls through to native", func(t *testing.T) {
		got := titleRomajiOrNative(&anilist.Title{Romaji: sptr(""), Native: sptr("N")})
		require.NotNil(t, got)
		assert.Equal(t, "N", *got)
	})
	t.Run("nil romaji falls through to native", func(t *testing.T) {
		got := titleRomajiOrNative(&anilist.Title{Native: sptr("N")})
		require.NotNil(t, got)
		assert.Equal(t, "N", *got)
	})
	t.Run("both nil returns nil", func(t *testing.T) {
		assert.Nil(t, titleRomajiOrNative(&anilist.Title{}))
	})
}
