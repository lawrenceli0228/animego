package transforms

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.mongodb.org/mongo-driver/v2/bson"
)

func TestEpisodeCommentsTransform(t *testing.T) {
	t.Parallel()

	commentOID := bson.NewObjectID()
	expectedID, err := MongoIDToUUID(commentOID)
	require.NoError(t, err)

	userOID := bson.NewObjectID()
	expectedUserID, err := MongoIDToUUID(userOID)
	require.NoError(t, err)

	parentOID := bson.NewObjectID()
	expectedParentID, err := MongoIDToUUID(parentOID)
	require.NoError(t, err)

	createdAt := bson.NewDateTimeFromTime(time.Date(2026, 5, 21, 10, 0, 0, 0, time.UTC))
	updatedAt := bson.NewDateTimeFromTime(time.Date(2026, 5, 21, 11, 0, 0, 0, time.UTC))

	tests := []struct {
		name     string
		doc      bson.M
		wantErr  bool
		wantRows int
		check    func(t *testing.T, row map[string]any)
	}{
		{
			name: "top-level comment (no parent)",
			doc: bson.M{
				"_id":       commentOID,
				"anilistId": int32(101),
				"episode":   int32(3),
				"userId":    userOID,
				"username":  "alice",
				"content":   "first post",
				"createdAt": createdAt,
				"updatedAt": updatedAt,
			},
			wantRows: 1,
			check: func(t *testing.T, row map[string]any) {
				assert.Equal(t, expectedID, row["id"])
				assert.Equal(t, 101, row["anilist_id"])
				assert.Equal(t, 3, row["episode"])
				assert.Equal(t, expectedUserID, row["user_id"])
				assert.Equal(t, "alice", row["username"])
				assert.Equal(t, "first post", row["content"])
				pid, ok := row["parent_id"].(*uuid.UUID)
				require.True(t, ok, "parent_id should be *uuid.UUID typed nil, got %T", row["parent_id"])
				assert.Nil(t, pid)
				assert.Nil(t, row["reply_to_username"].(*string))
				assert.Equal(t, createdAt.Time().UTC(), row["created_at"])
				assert.Equal(t, updatedAt.Time().UTC(), row["updated_at"])
			},
		},
		{
			name: "reply comment (parentId + replyToUsername)",
			doc: bson.M{
				"_id":             commentOID,
				"anilistId":       int32(101),
				"episode":         int32(3),
				"userId":          userOID,
				"username":        "bob",
				"content":         "@alice nice",
				"parentId":        parentOID,
				"replyToUsername": "alice",
				"createdAt":       createdAt,
				"updatedAt":       updatedAt,
			},
			wantRows: 1,
			check: func(t *testing.T, row map[string]any) {
				pid, ok := row["parent_id"].(*uuid.UUID)
				require.True(t, ok)
				require.NotNil(t, pid)
				assert.Equal(t, expectedParentID, *pid)
				reply, ok := row["reply_to_username"].(*string)
				require.True(t, ok)
				require.NotNil(t, reply)
				assert.Equal(t, "alice", *reply)
			},
		},
		{
			name: "explicit nil parentId becomes NULL",
			doc: bson.M{
				"_id":       commentOID,
				"anilistId": int32(7),
				"episode":   int32(1),
				"userId":    userOID,
				"username":  "carl",
				"content":   "x",
				"parentId":  nil,
			},
			wantRows: 1,
			check: func(t *testing.T, row map[string]any) {
				pid, ok := row["parent_id"].(*uuid.UUID)
				require.True(t, ok)
				assert.Nil(t, pid)
			},
		},
		{
			name: "malformed parentId returns error",
			doc: bson.M{
				"_id":       commentOID,
				"anilistId": int32(7),
				"episode":   int32(1),
				"userId":    userOID,
				"username":  "dan",
				"content":   "x",
				"parentId":  12345, // unsupported type
			},
			wantErr: true,
		},
		{
			name: "malformed _id returns error",
			doc: bson.M{
				"_id":       12345,
				"anilistId": int32(7),
				"episode":   int32(1),
				"userId":    userOID,
				"username":  "erin",
				"content":   "x",
			},
			wantErr: true,
		},
		{
			name: "missing anilistId returns error",
			doc: bson.M{
				"_id":      commentOID,
				"episode":  int32(1),
				"userId":   userOID,
				"username": "fay",
				"content":  "x",
			},
			wantErr: true,
		},
		{
			name: "content over 500 chars passes through (DB will reject)",
			doc: bson.M{
				"_id":       commentOID,
				"anilistId": int32(101),
				"episode":   int32(1),
				"userId":    userOID,
				"username":  "garrulous",
				"content":   strings.Repeat("a", 750),
			},
			wantRows: 1,
			check: func(t *testing.T, row map[string]any) {
				c, ok := row["content"].(string)
				require.True(t, ok)
				assert.Len(t, c, 750)
			},
		},
		{
			name: "missing timestamps fall back to now()",
			doc: bson.M{
				"_id":       commentOID,
				"anilistId": int32(1),
				"episode":   int32(1),
				"userId":    userOID,
				"username":  "h",
				"content":   "k",
			},
			wantRows: 1,
			check: func(t *testing.T, row map[string]any) {
				ct, ok := row["created_at"].(time.Time)
				require.True(t, ok)
				assert.WithinDuration(t, time.Now().UTC(), ct, 5*time.Second)
			},
		},
	}

	tr := episodeCommentsTransform{}
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
			assert.Equal(t, "episode_comments", r.Table)
			require.Equal(t, len(r.Columns), len(r.Values))
			zipped := zipColsVals(r.Columns, r.Values)
			if tc.check != nil {
				tc.check(t, zipped)
			}
		})
	}
}

func TestEpisodeCommentsTransformMetadata(t *testing.T) {
	t.Parallel()
	tr := episodeCommentsTransform{}
	assert.Equal(t, "episode_comments", tr.Name())
	assert.Equal(t, "episode_comments", tr.MongoCollection())
	assert.Equal(t, "episode_comments", tr.PGTable())
	assert.Equal(t, "(id)", tr.ConflictTarget())
	assert.Equal(t, []string{"users", "anime_cache"}, tr.DependsOn())
}
