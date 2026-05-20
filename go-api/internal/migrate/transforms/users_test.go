package transforms

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.mongodb.org/mongo-driver/v2/bson"
)

func TestUsersTransform(t *testing.T) {
	t.Parallel()

	oid := bson.NewObjectID()
	expectedID, err := MongoIDToUUID(oid)
	require.NoError(t, err)

	createdAt := bson.NewDateTimeFromTime(time.Date(2026, 5, 21, 10, 0, 0, 0, time.UTC))
	updatedAt := bson.NewDateTimeFromTime(time.Date(2026, 5, 21, 11, 0, 0, 0, time.UTC))
	resetExpires := bson.NewDateTimeFromTime(time.Date(2026, 5, 22, 0, 0, 0, 0, time.UTC))

	tests := []struct {
		name      string
		doc       bson.M
		wantErr   bool
		wantRows  int
		check     func(t *testing.T, row map[string]any)
	}{
		{
			name: "happy path with all fields",
			doc: bson.M{
				"_id":                  oid,
				"username":             "alice",
				"email":                "alice@example.com",
				"password":             "$2b$10$hash",
				"role":                 "admin",
				"refreshToken":         "rt-abc",
				"resetPasswordToken":   "reset-xyz",
				"resetPasswordExpires": resetExpires,
				"createdAt":            createdAt,
				"updatedAt":            updatedAt,
			},
			wantRows: 1,
			check: func(t *testing.T, row map[string]any) {
				assert.Equal(t, expectedID, row["id"])
				assert.Equal(t, "alice", row["username"])
				assert.Equal(t, "alice@example.com", row["email"])
				assert.Equal(t, "$2b$10$hash", row["password"])
				rolePtr, ok := row["role"].(*string)
				require.True(t, ok)
				require.NotNil(t, rolePtr)
				assert.Equal(t, "admin", *rolePtr)
				refresh, ok := row["refresh_token"].(*string)
				require.True(t, ok)
				require.NotNil(t, refresh)
				assert.Equal(t, "rt-abc", *refresh)
				expPtr, ok := row["reset_password_expires"].(*time.Time)
				require.True(t, ok)
				require.NotNil(t, expPtr)
				assert.Equal(t, time.Date(2026, 5, 22, 0, 0, 0, 0, time.UTC), expPtr.UTC())
				assert.Equal(t, createdAt.Time().UTC(), row["created_at"])
				assert.Equal(t, updatedAt.Time().UTC(), row["updated_at"])
			},
		},
		{
			name: "missing optional fields become nil",
			doc: bson.M{
				"_id":      oid,
				"username": "bob",
				"email":    "bob@example.com",
				"password": "$2b$10$other",
				// role, refreshToken, resetPassword* absent
			},
			wantRows: 1,
			check: func(t *testing.T, row map[string]any) {
				assert.Nil(t, row["role"].(*string))
				assert.Nil(t, row["refresh_token"].(*string))
				assert.Nil(t, row["reset_password_token"].(*string))
				assert.Nil(t, row["reset_password_expires"])
				// timestamps default to now() when absent
				ct, ok := row["created_at"].(time.Time)
				require.True(t, ok)
				assert.WithinDuration(t, time.Now().UTC(), ct, 5*time.Second)
			},
		},
		{
			name: "bad ObjectId returns error",
			doc: bson.M{
				"_id":      12345, // unsupported type
				"username": "carl",
				"email":    "carl@example.com",
			},
			wantErr: true,
		},
		{
			name: "empty role string maps to nil",
			doc: bson.M{
				"_id":      oid,
				"username": "dan",
				"email":    "dan@example.com",
				"password": "hash",
				"role":     "",
			},
			wantRows: 1,
			check: func(t *testing.T, row map[string]any) {
				assert.Nil(t, row["role"].(*string))
			},
		},
		{
			name: "is_public column is not emitted",
			doc: bson.M{
				"_id":      oid,
				"username": "erin",
				"email":    "erin@example.com",
				"password": "hash",
			},
			wantRows: 1,
			check: func(t *testing.T, row map[string]any) {
				_, present := row["is_public"]
				assert.False(t, present, "is_public must not be in Columns/Values")
			},
		},
	}

	tr := usersTransform{}
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
			assert.Equal(t, "users", r.Table)
			require.Equal(t, len(r.Columns), len(r.Values))
			zipped := zipColsVals(r.Columns, r.Values)
			if tc.check != nil {
				tc.check(t, zipped)
			}
		})
	}
}

func TestUsersTransformMetadata(t *testing.T) {
	t.Parallel()
	tr := usersTransform{}
	assert.Equal(t, "users", tr.Name())
	assert.Equal(t, "users", tr.MongoCollection())
	assert.Equal(t, "users", tr.PGTable())
	assert.Equal(t, "(id)", tr.ConflictTarget())
	assert.Nil(t, tr.DependsOn())
}

// zipColsVals turns Columns + Values into a map for ergonomic assertion access.
func zipColsVals(cols []string, vals []any) map[string]any {
	out := make(map[string]any, len(cols))
	for i, c := range cols {
		out[c] = vals[i]
	}
	return out
}
