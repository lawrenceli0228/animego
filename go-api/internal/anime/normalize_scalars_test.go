package anime

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/anilist"
)

// TestNormalizeMainRow_ScalarBlock — the 0036 scalars reach the upsert
// params, and the next-airing pair is both-or-neither.
func TestNormalizeMainRow_ScalarBlock(t *testing.T) {
	adult := true
	m := anilist.Media{
		ID:                1,
		Popularity:        iptr(123456),
		Favourites:        iptr(789),
		IDMal:             iptr(52991),
		IsAdult:           &adult,
		CountryOfOrigin:   sptr("JP"),
		NextAiringEpisode: &anilist.NextAiringEpisode{AiringAt: 1_700_000_000, Episode: 12},
	}
	row := NormalizeMainRow(m, anilist.SeasonalDocument)

	assert.Equal(t, int32(123456), *row.Popularity)
	assert.Equal(t, int32(789), *row.Favourites)
	assert.Equal(t, int32(52991), *row.MalID)
	require.NotNil(t, row.IsAdult)
	assert.True(t, *row.IsAdult)
	assert.Equal(t, "JP", *row.CountryOfOrigin)
	require.True(t, row.NextAiringAt.Valid)
	assert.Equal(t, time.Unix(1_700_000_000, 0).UTC(), row.NextAiringAt.Time)
	require.NotNil(t, row.NextAiringEpisode)
	assert.Equal(t, int32(12), *row.NextAiringEpisode)
}

func TestNormalizeMainRow_ScalarBlockAbsent(t *testing.T) {
	row := NormalizeMainRow(anilist.Media{ID: 1}, anilist.SearchDocument)
	assert.Nil(t, row.Popularity)
	assert.Nil(t, row.Favourites)
	assert.Nil(t, row.MalID)
	assert.Nil(t, row.IsAdult, "a Media that did not decode isAdult must not become 'false' on the way in")
	assert.Nil(t, row.CountryOfOrigin)
	assert.False(t, row.NextAiringAt.Valid)
	assert.Nil(t, row.NextAiringEpisode)
}

func TestNormalizeMainRow_NextAiringHalfPairIsDropped(t *testing.T) {
	row := NormalizeMainRow(anilist.Media{ID: 1, NextAiringEpisode: &anilist.NextAiringEpisode{AiringAt: 1_700_000_000}}, anilist.DetailDocument)
	assert.False(t, row.NextAiringAt.Valid, "an airing time without an episode number would trip the column CHECK")
	assert.Nil(t, row.NextAiringEpisode)
}
