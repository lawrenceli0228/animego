package transforms

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.mongodb.org/mongo-driver/v2/bson"
)

func TestFollowsTransform(t *testing.T) {
	t.Parallel()

	followerOID := bson.NewObjectID()
	followeeOID := bson.NewObjectID()
	expectedFollower, err := MongoIDToUUID(followerOID)
	require.NoError(t, err)
	expectedFollowee, err := MongoIDToUUID(followeeOID)
	require.NoError(t, err)

	createdAt := bson.NewDateTimeFromTime(time.Date(2026, 5, 18, 12, 0, 0, 0, time.UTC))
	updatedAt := bson.NewDateTimeFromTime(time.Date(2026, 5, 19, 12, 0, 0, 0, time.UTC))

	tests := []struct {
		name     string
		doc      bson.M
		wantErr  bool
		wantRows int
		check    func(t *testing.T, row map[string]any)
	}{
		{
			name: "happy path with timestamps",
			doc: bson.M{
				"_id":        bson.NewObjectID(),
				"followerId": followerOID,
				"followeeId": followeeOID,
				"createdAt":  createdAt,
				"updatedAt":  updatedAt,
			},
			wantRows: 1,
			check: func(t *testing.T, row map[string]any) {
				assert.Equal(t, expectedFollower, row["follower_id"])
				assert.Equal(t, expectedFollowee, row["followee_id"])
				assert.Equal(t, createdAt.Time().UTC(), row["created_at"])
				assert.Equal(t, updatedAt.Time().UTC(), row["updated_at"])
			},
		},
		{
			name: "missing timestamps default to now",
			doc: bson.M{
				"_id":        bson.NewObjectID(),
				"followerId": followerOID,
				"followeeId": followeeOID,
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
			name: "bad followerId returns error",
			doc: bson.M{
				"_id":        bson.NewObjectID(),
				"followerId": 12.5, // unsupported type
				"followeeId": followeeOID,
			},
			wantErr: true,
		},
		{
			name: "bad followeeId returns error",
			doc: bson.M{
				"_id":        bson.NewObjectID(),
				"followerId": followerOID,
				"followeeId": []byte{0x01, 0x02}, // unsupported type
			},
			wantErr: true,
		},
		{
			name: "string ObjectId fallback works on both sides",
			doc: bson.M{
				"_id":        bson.NewObjectID(),
				"followerId": "507f1f77bcf86cd799439011",
				"followeeId": "507f191e810c19729de860ea",
			},
			wantRows: 1,
			check: func(t *testing.T, row map[string]any) {
				followerExpected, err := MongoIDToUUID("507f1f77bcf86cd799439011")
				require.NoError(t, err)
				followeeExpected, err := MongoIDToUUID("507f191e810c19729de860ea")
				require.NoError(t, err)
				assert.Equal(t, followerExpected, row["follower_id"])
				assert.Equal(t, followeeExpected, row["followee_id"])
			},
		},
	}

	tr := followsTransform{}
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
			assert.Equal(t, "follows", r.Table)
			require.Equal(t, len(r.Columns), len(r.Values))
			if tc.check != nil {
				tc.check(t, zipColsVals(r.Columns, r.Values))
			}
		})
	}
}

func TestFollowsTransformMetadata(t *testing.T) {
	t.Parallel()
	tr := followsTransform{}
	assert.Equal(t, "follows", tr.Name())
	assert.Equal(t, "follows", tr.MongoCollection())
	assert.Equal(t, "follows", tr.PGTable())
	assert.Equal(t, "(follower_id, followee_id)", tr.ConflictTarget())
	assert.Equal(t, []string{"users"}, tr.DependsOn())
}
