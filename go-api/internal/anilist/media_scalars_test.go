package anilist

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

func TestMedia_NextAiring(t *testing.T) {
	at, ep, ok := Media{NextAiringEpisode: &NextAiringEpisode{AiringAt: 1_700_000_000, Episode: 7}}.NextAiring()
	assert.True(t, ok)
	assert.Equal(t, time.Unix(1_700_000_000, 0).UTC(), at)
	assert.Equal(t, 7, ep)

	for name, m := range map[string]Media{
		"absent":           {},
		"zero airingAt":    {NextAiringEpisode: &NextAiringEpisode{AiringAt: 0, Episode: 7}},
		"zero episode":     {NextAiringEpisode: &NextAiringEpisode{AiringAt: 1_700_000_000, Episode: 0}},
		"negative episode": {NextAiringEpisode: &NextAiringEpisode{AiringAt: 1_700_000_000, Episode: -1}},
	} {
		t.Run(name, func(t *testing.T) {
			_, _, ok := m.NextAiring()
			assert.False(t, ok, "half an answer is not one")
		})
	}
}

func TestMedia_SynonymSet(t *testing.T) {
	assert.Equal(t, []string{}, Media{}.SynonymSet(), "nil in, empty (not nil) out")
	assert.Equal(t,
		[]string{"Frieren", "葬送的芙莉莲", "Sousou no Frieren"},
		Media{Synonyms: []string{" Frieren ", "", "葬送的芙莉莲", "Frieren", "   ", "Sousou no Frieren"}}.SynonymSet(),
		"trimmed, blanks dropped, duplicates dropped, order kept")
}
