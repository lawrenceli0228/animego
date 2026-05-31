package transforms

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.mongodb.org/mongo-driver/v2/bson"
)

func TestEpisodeWindowsTransform(t *testing.T) {
	t.Parallel()

	endsAt := time.Date(2026, 6, 1, 23, 59, 59, 0, time.UTC)
	endsAtBson := bson.NewDateTimeFromTime(endsAt)

	tests := []struct {
		name     string
		doc      bson.M
		wantErr  bool
		wantRows int
		check    func(t *testing.T, row map[string]any)
	}{
		{
			name: "happy path int32 fields",
			doc: bson.M{
				"_id":        bson.NewObjectID(),
				"anilistId":  int32(154587),
				"episode":    int32(7),
				"liveEndsAt": endsAtBson,
			},
			wantRows: 1,
			check: func(t *testing.T, row map[string]any) {
				assert.Equal(t, 154587, row["anilist_id"])
				assert.Equal(t, 7, row["episode"])
				lt, ok := row["live_ends_at"].(time.Time)
				require.True(t, ok)
				assert.Equal(t, endsAt, lt)
			},
		},
		{
			name: "int64 anilistId tolerated",
			doc: bson.M{
				"_id":        bson.NewObjectID(),
				"anilistId":  int64(99999),
				"episode":    int64(1),
				"liveEndsAt": endsAtBson,
			},
			wantRows: 1,
			check: func(t *testing.T, row map[string]any) {
				assert.Equal(t, 99999, row["anilist_id"])
				assert.Equal(t, 1, row["episode"])
			},
		},
		{
			name: "missing anilistId returns error",
			doc: bson.M{
				"_id":        bson.NewObjectID(),
				"episode":    int32(1),
				"liveEndsAt": endsAtBson,
			},
			wantErr: true,
		},
		{
			name: "missing episode returns error",
			doc: bson.M{
				"_id":        bson.NewObjectID(),
				"anilistId":  int32(1),
				"liveEndsAt": endsAtBson,
			},
			wantErr: true,
		},
		{
			name: "missing liveEndsAt returns error",
			doc: bson.M{
				"_id":       bson.NewObjectID(),
				"anilistId": int32(1),
				"episode":   int32(1),
			},
			wantErr: true,
		},
	}

	tr := episodeWindowsTransform{}
	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			rows, err := tr.TransformRow(context.Background(), tc.doc)
			if tc.wantErr {
				require.Error(t, err)
				assert.Nil(t, rows)
				return
			}
			require.NoError(t, err)
			require.Len(t, rows, tc.wantRows)
			r := rows[0]
			assert.Equal(t, "episode_windows", r.Table)
			require.Equal(t, len(r.Columns), len(r.Values))
			if tc.check != nil {
				tc.check(t, zipColsVals(r.Columns, r.Values))
			}
		})
	}
}

func TestEpisodeWindowsTransformMetadata(t *testing.T) {
	t.Parallel()
	tr := episodeWindowsTransform{}
	assert.Equal(t, "episode_windows", tr.Name())
	assert.Equal(t, "episodewindows", tr.MongoCollection())
	assert.Equal(t, "episode_windows", tr.PGTable())
	assert.Equal(t, "(anilist_id, episode)", tr.ConflictTarget())
	assert.Equal(t, []string{"anime_cache"}, tr.DependsOn())
}
