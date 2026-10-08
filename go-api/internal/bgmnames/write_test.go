package bgmnames

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// TestPlan — a run's pairs against what is stored: an unchanged pair is
// left alone (its matched_at stays), a changed one is deleted and inserted
// again, a new one inserted, and a stored one this run did not find is
// deleted.  An empty Chinese name and a NULL one are the same.
func TestPlan(t *testing.T) {
	existing := map[int32]stored{
		1: {bgmID: 10, nameCn: "甲"},
		2: {bgmID: 20},
		3: {bgmID: 30, nameCn: "丙"},
		4: {bgmID: 40, nameCn: "丁"},
		6: {bgmID: 60},
	}
	next := []Pair{
		{AnilistID: 1, BgmID: 10, NameCn: "甲"},
		{AnilistID: 2, BgmID: 20, NameCn: "乙"},
		{AnilistID: 3, BgmID: 31, NameCn: "丙"},
		{AnilistID: 5, BgmID: 50, NameCn: "戊"},
		{AnilistID: 6, BgmID: 60},
	}

	deletes, inserts, change := plan(existing, next)

	assert.Equal(t, []int32{2, 3, 4}, deletes)
	assert.Equal(t, []int32{2, 3, 5}, anilistIDs(inserts))
	assert.Equal(t, Change{Inserted: 1, Updated: 2, Deleted: 1, Unchanged: 2}, change)
}

func anilistIDs(pairs []Pair) []int32 {
	out := make([]int32, 0, len(pairs))
	for _, p := range pairs {
		out = append(out, p.AnilistID)
	}
	return out
}
