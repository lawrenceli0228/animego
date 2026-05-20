package transforms

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.mongodb.org/mongo-driver/v2/bson"
)

func TestSubscriptionsTransform(t *testing.T) {
	t.Parallel()

	userOID := bson.NewObjectID()
	expectedUser, err := MongoIDToUUID(userOID)
	require.NoError(t, err)

	lastWatched := bson.NewDateTimeFromTime(time.Date(2026, 5, 20, 22, 0, 0, 0, time.UTC))
	createdAt := bson.NewDateTimeFromTime(time.Date(2026, 5, 19, 10, 0, 0, 0, time.UTC))
	updatedAt := bson.NewDateTimeFromTime(time.Date(2026, 5, 21, 8, 0, 0, 0, time.UTC))

	tests := []struct {
		name     string
		doc      bson.M
		wantErr  bool
		wantRows int
		check    func(t *testing.T, row map[string]any)
	}{
		{
			name: "happy path watching with score",
			doc: bson.M{
				"_id":            bson.NewObjectID(),
				"userId":         userOID,
				"anilistId":      int32(154587),
				"status":         "watching",
				"currentEpisode": int32(4),
				"score":          int32(8),
				"lastWatchedAt":  lastWatched,
				"createdAt":      createdAt,
				"updatedAt":      updatedAt,
			},
			wantRows: 1,
			check: func(t *testing.T, row map[string]any) {
				assert.Equal(t, expectedUser, row["user_id"])
				assert.Equal(t, 154587, row["anilist_id"])
				assert.Equal(t, "watching", row["status"])
				assert.Equal(t, 4, row["current_episode"])
				scorePtr, ok := row["score"].(*int)
				require.True(t, ok)
				require.NotNil(t, scorePtr)
				assert.Equal(t, 8, *scorePtr)
				lwPtr, ok := row["last_watched_at"].(*time.Time)
				require.True(t, ok)
				require.NotNil(t, lwPtr)
			},
		},
		{
			name: "plan_to_watch with no score and no lastWatchedAt",
			doc: bson.M{
				"_id":       bson.NewObjectID(),
				"userId":    userOID,
				"anilistId": int64(99999),
				"status":    "plan_to_watch",
				// currentEpisode, score, lastWatchedAt absent
			},
			wantRows: 1,
			check: func(t *testing.T, row map[string]any) {
				assert.Equal(t, 99999, row["anilist_id"])
				assert.Equal(t, "plan_to_watch", row["status"])
				assert.Equal(t, 0, row["current_episode"])
				assert.Nil(t, row["score"].(*int))
				assert.Nil(t, row["last_watched_at"])
			},
		},
		{
			name: "bad userId returns error",
			doc: bson.M{
				"_id":       bson.NewObjectID(),
				"userId":    3.14, // unsupported type
				"anilistId": int32(1),
				"status":    "watching",
			},
			wantErr: true,
		},
		{
			name: "missing anilistId returns error",
			doc: bson.M{
				"_id":    bson.NewObjectID(),
				"userId": userOID,
				"status": "completed",
			},
			wantErr: true,
		},
		{
			name: "invalid status passes through (DB CHECK will reject)",
			doc: bson.M{
				"_id":       bson.NewObjectID(),
				"userId":    userOID,
				"anilistId": int32(1),
				"status":    "garbage_value", // documented passthrough
			},
			wantRows: 1,
			check: func(t *testing.T, row map[string]any) {
				assert.Equal(t, "garbage_value", row["status"])
			},
		},
	}

	tr := subscriptionsTransform{}
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
			assert.Equal(t, "subscriptions", r.Table)
			require.Equal(t, len(r.Columns), len(r.Values))
			if tc.check != nil {
				tc.check(t, zipColsVals(r.Columns, r.Values))
			}
		})
	}
}

func TestSubscriptionsTransformMetadata(t *testing.T) {
	t.Parallel()
	tr := subscriptionsTransform{}
	assert.Equal(t, "subscriptions", tr.Name())
	assert.Equal(t, "subscriptions", tr.MongoCollection())
	assert.Equal(t, "subscriptions", tr.PGTable())
	assert.Equal(t, "(user_id, anilist_id)", tr.ConflictTarget())
	assert.Equal(t, []string{"users", "anime_cache"}, tr.DependsOn())
}
