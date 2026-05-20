package transforms

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.mongodb.org/mongo-driver/v2/bson"
)

func TestDanmakusTransform(t *testing.T) {
	t.Parallel()

	userOID := bson.NewObjectID()
	expectedUserID, err := MongoIDToUUID(userOID)
	require.NoError(t, err)

	createdAt := bson.NewDateTimeFromTime(time.Date(2026, 5, 21, 10, 0, 0, 0, time.UTC))
	updatedAt := bson.NewDateTimeFromTime(time.Date(2026, 5, 21, 11, 0, 0, 0, time.UTC))
	liveEndsAt := bson.NewDateTimeFromTime(time.Date(2027, 5, 21, 0, 0, 0, 0, time.UTC))

	tests := []struct {
		name     string
		doc      bson.M
		wantErr  bool
		wantRows int
		check    func(t *testing.T, row map[string]any)
	}{
		{
			name: "happy path with all fields",
			doc: bson.M{
				"anilistId":  int32(101),
				"episode":    int32(5),
				"userId":     userOID,
				"username":   "alice",
				"content":    "hello world",
				"liveEndsAt": liveEndsAt,
				"createdAt":  createdAt,
				"updatedAt":  updatedAt,
			},
			wantRows: 1,
			check: func(t *testing.T, row map[string]any) {
				assert.Equal(t, 101, row["anilist_id"])
				assert.Equal(t, 5, row["episode"])
				assert.Equal(t, expectedUserID, row["user_id"])
				assert.Equal(t, "alice", row["username"])
				assert.Equal(t, "hello world", row["content"])
				le, ok := row["live_ends_at"].(time.Time)
				require.True(t, ok)
				assert.Equal(t, liveEndsAt.Time().UTC(), le)
				assert.Equal(t, createdAt.Time().UTC(), row["created_at"])
				assert.Equal(t, updatedAt.Time().UTC(), row["updated_at"])
			},
		},
		{
			name: "missing liveEndsAt returns error",
			doc: bson.M{
				"anilistId": int32(42),
				"episode":   int32(1),
				"userId":    userOID,
				"username":  "bob",
				"content":   "no live ends",
				// liveEndsAt absent
			},
			wantErr: true,
		},
		{
			name: "missing anilistId returns error",
			doc: bson.M{
				"episode":    int32(1),
				"userId":     userOID,
				"username":   "c",
				"content":    "x",
				"liveEndsAt": liveEndsAt,
			},
			wantErr: true,
		},
		{
			name: "bad userId returns error",
			doc: bson.M{
				"anilistId":  int32(7),
				"episode":    int32(2),
				"userId":     12345, // unsupported type
				"username":   "d",
				"content":    "y",
				"liveEndsAt": liveEndsAt,
			},
			wantErr: true,
		},
		{
			name: "content over 50 chars passes through (DB will reject)",
			doc: bson.M{
				"anilistId":  int32(11),
				"episode":    int32(3),
				"userId":     userOID,
				"username":   "longwinded",
				"content":    strings.Repeat("a", 75),
				"liveEndsAt": liveEndsAt,
				"createdAt":  createdAt,
				"updatedAt":  updatedAt,
			},
			wantRows: 1,
			check: func(t *testing.T, row map[string]any) {
				c, ok := row["content"].(string)
				require.True(t, ok)
				assert.Len(t, c, 75)
			},
		},
		{
			name: "missing timestamps fall back to now()",
			doc: bson.M{
				"anilistId":  int32(9),
				"episode":    int32(4),
				"userId":     userOID,
				"username":   "e",
				"content":    "z",
				"liveEndsAt": liveEndsAt,
			},
			wantRows: 1,
			check: func(t *testing.T, row map[string]any) {
				ct, ok := row["created_at"].(time.Time)
				require.True(t, ok)
				assert.WithinDuration(t, time.Now().UTC(), ct, 5*time.Second)
				ut, ok := row["updated_at"].(time.Time)
				require.True(t, ok)
				assert.WithinDuration(t, time.Now().UTC(), ut, 5*time.Second)
			},
		},
		{
			name: "id column is NOT emitted (PG IDENTITY)",
			doc: bson.M{
				"anilistId":  int32(1),
				"episode":    int32(1),
				"userId":     userOID,
				"username":   "f",
				"content":    "k",
				"liveEndsAt": liveEndsAt,
			},
			wantRows: 1,
			check: func(t *testing.T, row map[string]any) {
				_, present := row["id"]
				assert.False(t, present, "id must not be in Columns/Values; PG generates it")
			},
		},
	}

	tr := danmakusTransform{}
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
			assert.Equal(t, "danmakus", r.Table)
			require.Equal(t, len(r.Columns), len(r.Values))
			zipped := zipColsVals(r.Columns, r.Values)
			if tc.check != nil {
				tc.check(t, zipped)
			}
		})
	}
}

func TestDanmakusTransformMetadata(t *testing.T) {
	t.Parallel()
	tr := danmakusTransform{}
	assert.Equal(t, "danmakus", tr.Name())
	assert.Equal(t, "danmakus", tr.MongoCollection())
	assert.Equal(t, "danmakus", tr.PGTable())
	assert.Equal(t, "", tr.ConflictTarget(), "empty ConflictTarget — operator must TRUNCATE before re-run")
	assert.Equal(t, []string{"users", "anime_cache"}, tr.DependsOn())
}
