package transforms

import (
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.mongodb.org/mongo-driver/v2/bson"
)

// TestAnimegoNamespace_Frozen guards the FK-integrity invariant called out in
// util.go: changing AnimegoNamespace re-keys every UUID in every table.  The
// codebase comment claims "enforced by code review only — there is no
// automated guard."  This test IS the automated guard.  If you find yourself
// updating this expected value, stop and read util.go:14-16 first.
func TestAnimegoNamespace_Frozen(t *testing.T) {
	t.Parallel()
	assert.Equal(t, "ab8f6f3a-4c0d-5b3f-9c4d-7e8f1c2b3d4e", AnimegoNamespace.String())
}

func TestMongoIDToUUID(t *testing.T) {
	t.Parallel()

	oid := bson.NewObjectID()
	expectedFromOID := uuid.NewSHA1(AnimegoNamespace, oid[:])
	expectedFromStr := uuid.NewSHA1(AnimegoNamespace, []byte("legacy-string-id"))

	tests := []struct {
		name    string
		input   any
		want    uuid.UUID
		wantErr bool
	}{
		{"objectid maps deterministically", oid, expectedFromOID, false},
		{"string fallback maps deterministically", "legacy-string-id", expectedFromStr, false},
		{"nil returns error", nil, uuid.Nil, true},
		{"empty string returns error", "", uuid.Nil, true},
		{"unsupported int type returns error", 42, uuid.Nil, true},
		{"unsupported struct type returns error", struct{}{}, uuid.Nil, true},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got, err := MongoIDToUUID(tt.input)
			if tt.wantErr {
				require.Error(t, err)
				assert.Equal(t, uuid.Nil, got)
				return
			}
			require.NoError(t, err)
			assert.Equal(t, tt.want, got)
		})
	}
}

// TestMongoIDToUUID_Determinism guards the contract in util.go:7-12: the same
// Mongo _id must produce the same UUID across repeated calls.  This is what
// lets users → subscriptions → comments → danmakus all reference the same
// user UUID across orchestrator per-collection commit boundaries.
func TestMongoIDToUUID_Determinism(t *testing.T) {
	t.Parallel()

	oid := bson.NewObjectID()
	first, err := MongoIDToUUID(oid)
	require.NoError(t, err)

	for i := 0; i < 100; i++ {
		again, err := MongoIDToUUID(oid)
		require.NoError(t, err)
		assert.Equal(t, first, again, "MongoIDToUUID must be deterministic on call %d", i)
	}

	strFirst, err := MongoIDToUUID("user-42")
	require.NoError(t, err)
	strAgain, err := MongoIDToUUID("user-42")
	require.NoError(t, err)
	assert.Equal(t, strFirst, strAgain)
}

func TestMongoDateTime(t *testing.T) {
	t.Parallel()

	wallclock := time.Date(2026, 5, 21, 10, 30, 0, 0, time.UTC)
	bsonDT := bson.NewDateTimeFromTime(wallclock)
	localTime := wallclock.In(time.FixedZone("UTC+8", 8*3600))

	tests := []struct {
		name   string
		input  any
		want   time.Time
		wantOK bool
	}{
		{"bson.DateTime returns UTC", bsonDT, wallclock, true},
		{"time.Time returns UTC", wallclock, wallclock, true},
		{"non-UTC time.Time normalizes to UTC", localTime, wallclock, true},
		{"nil returns zero+false", nil, time.Time{}, false},
		{"unsupported string returns zero+false", "2026-05-21", time.Time{}, false},
		{"unsupported int returns zero+false", 1700000000, time.Time{}, false},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got, ok := MongoDateTime(tt.input)
			assert.Equal(t, tt.wantOK, ok)
			if tt.wantOK {
				assert.True(t, tt.want.Equal(got), "want %v got %v", tt.want, got)
				assert.Equal(t, time.UTC, got.Location())
			}
		})
	}
}

func TestGetString(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		m      bson.M
		key    string
		want   string
		wantOK bool
	}{
		{"present string", bson.M{"k": "v"}, "k", "v", true},
		{"empty string still present", bson.M{"k": ""}, "k", "", true},
		{"missing key", bson.M{"other": "v"}, "k", "", false},
		{"nil value", bson.M{"k": nil}, "k", "", false},
		{"wrong type int", bson.M{"k": 42}, "k", "", false},
		{"wrong type bool", bson.M{"k": true}, "k", "", false},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got, ok := GetString(tt.m, tt.key)
			assert.Equal(t, tt.want, got)
			assert.Equal(t, tt.wantOK, ok)
		})
	}
}

func TestGetInt(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		v      any
		want   int
		wantOK bool
	}{
		{"int", int(42), 42, true},
		{"int32", int32(42), 42, true},
		{"int64", int64(42), 42, true},
		{"float64 truncates", float64(42.9), 42, true},
		{"negative int64", int64(-7), -7, true},
		{"zero int", int(0), 0, true},
		{"string rejected", "42", 0, false},
		{"bool rejected", true, 0, false},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got, ok := GetInt(bson.M{"k": tt.v}, "k")
			assert.Equal(t, tt.want, got)
			assert.Equal(t, tt.wantOK, ok)
		})
	}

	t.Run("missing key", func(t *testing.T) {
		t.Parallel()
		got, ok := GetInt(bson.M{}, "k")
		assert.Equal(t, 0, got)
		assert.False(t, ok)
	})
	t.Run("nil value", func(t *testing.T) {
		t.Parallel()
		got, ok := GetInt(bson.M{"k": nil}, "k")
		assert.Equal(t, 0, got)
		assert.False(t, ok)
	})
}

func TestGetFloat(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		v      any
		want   float64
		wantOK bool
	}{
		{"float64", float64(3.14), 3.14, true},
		{"int promoted", int(7), 7.0, true},
		{"int32 promoted", int32(7), 7.0, true},
		{"int64 promoted", int64(7), 7.0, true},
		{"zero", float64(0), 0, true},
		{"string rejected", "3.14", 0, false},
		{"bool rejected", true, 0, false},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got, ok := GetFloat(bson.M{"k": tt.v}, "k")
			assert.InDelta(t, tt.want, got, 1e-9)
			assert.Equal(t, tt.wantOK, ok)
		})
	}

	t.Run("missing key", func(t *testing.T) {
		t.Parallel()
		got, ok := GetFloat(bson.M{}, "k")
		assert.Equal(t, 0.0, got)
		assert.False(t, ok)
	})
	t.Run("nil value", func(t *testing.T) {
		t.Parallel()
		got, ok := GetFloat(bson.M{"k": nil}, "k")
		assert.Equal(t, 0.0, got)
		assert.False(t, ok)
	})
}

func TestGetBool(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		m      bson.M
		key    string
		want   bool
		wantOK bool
	}{
		{"true", bson.M{"k": true}, "k", true, true},
		{"false", bson.M{"k": false}, "k", false, true},
		{"missing", bson.M{}, "k", false, false},
		{"nil", bson.M{"k": nil}, "k", false, false},
		{"int rejected", bson.M{"k": 1}, "k", false, false},
		{"string rejected", bson.M{"k": "true"}, "k", false, false},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got, ok := GetBool(tt.m, tt.key)
			assert.Equal(t, tt.want, got)
			assert.Equal(t, tt.wantOK, ok)
		})
	}
}

func TestGetArray(t *testing.T) {
	t.Parallel()

	t.Run("bson.A passes through", func(t *testing.T) {
		t.Parallel()
		got, ok := GetArray(bson.M{"k": bson.A{"a", "b"}}, "k")
		require.True(t, ok)
		assert.Equal(t, bson.A{"a", "b"}, got)
	})

	t.Run("plain []any converts to bson.A", func(t *testing.T) {
		t.Parallel()
		got, ok := GetArray(bson.M{"k": []any{1, 2, 3}}, "k")
		require.True(t, ok)
		assert.Equal(t, bson.A{1, 2, 3}, got)
	})

	t.Run("empty array is present", func(t *testing.T) {
		t.Parallel()
		got, ok := GetArray(bson.M{"k": bson.A{}}, "k")
		require.True(t, ok)
		assert.Empty(t, got)
	})

	t.Run("missing returns nil+false", func(t *testing.T) {
		t.Parallel()
		got, ok := GetArray(bson.M{}, "k")
		assert.Nil(t, got)
		assert.False(t, ok)
	})

	t.Run("nil returns nil+false", func(t *testing.T) {
		t.Parallel()
		got, ok := GetArray(bson.M{"k": nil}, "k")
		assert.Nil(t, got)
		assert.False(t, ok)
	})

	t.Run("wrong type rejected", func(t *testing.T) {
		t.Parallel()
		got, ok := GetArray(bson.M{"k": "not an array"}, "k")
		assert.Nil(t, got)
		assert.False(t, ok)
	})
}

// TestGetSubdoc_BsonDFlatten guards the trap documented at util.go:148-150:
// mongo-driver v2 may decode nested docs as bson.D even when the parent is
// bson.M.  GetSubdoc must flatten D→M so downstream helpers don't get a
// "wrong type" silent miss.
func TestGetSubdoc(t *testing.T) {
	t.Parallel()

	t.Run("bson.M passes through", func(t *testing.T) {
		t.Parallel()
		got, ok := GetSubdoc(bson.M{"k": bson.M{"x": 1}}, "k")
		require.True(t, ok)
		assert.Equal(t, bson.M{"x": 1}, got)
	})

	t.Run("bson.D flattens to bson.M preserving values", func(t *testing.T) {
		t.Parallel()
		input := bson.D{{Key: "year", Value: int32(2026)}, {Key: "month", Value: int32(5)}}
		got, ok := GetSubdoc(bson.M{"k": input}, "k")
		require.True(t, ok)
		assert.Equal(t, bson.M{"year": int32(2026), "month": int32(5)}, got)

		y, yOK := GetInt(got, "year")
		require.True(t, yOK)
		assert.Equal(t, 2026, y)
	})

	t.Run("empty bson.D flattens to empty bson.M", func(t *testing.T) {
		t.Parallel()
		got, ok := GetSubdoc(bson.M{"k": bson.D{}}, "k")
		require.True(t, ok)
		assert.Empty(t, got)
	})

	t.Run("map[string]any converts to bson.M", func(t *testing.T) {
		t.Parallel()
		got, ok := GetSubdoc(bson.M{"k": map[string]any{"x": 1}}, "k")
		require.True(t, ok)
		assert.Equal(t, bson.M{"x": 1}, got)
	})

	t.Run("missing returns nil+false", func(t *testing.T) {
		t.Parallel()
		got, ok := GetSubdoc(bson.M{}, "k")
		assert.Nil(t, got)
		assert.False(t, ok)
	})

	t.Run("nil returns nil+false", func(t *testing.T) {
		t.Parallel()
		got, ok := GetSubdoc(bson.M{"k": nil}, "k")
		assert.Nil(t, got)
		assert.False(t, ok)
	})

	t.Run("string rejected", func(t *testing.T) {
		t.Parallel()
		got, ok := GetSubdoc(bson.M{"k": "not a doc"}, "k")
		assert.Nil(t, got)
		assert.False(t, ok)
	})
}

func TestStringPtr(t *testing.T) {
	t.Parallel()

	t.Run("empty string returns nil", func(t *testing.T) {
		t.Parallel()
		assert.Nil(t, StringPtr(""))
	})

	t.Run("non-empty returns pointer with same value", func(t *testing.T) {
		t.Parallel()
		got := StringPtr("hello")
		require.NotNil(t, got)
		assert.Equal(t, "hello", *got)
	})

	t.Run("whitespace is non-empty", func(t *testing.T) {
		t.Parallel()
		got := StringPtr(" ")
		require.NotNil(t, got)
		assert.Equal(t, " ", *got)
	})
}

func TestMakeDate(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name        string
		year, m, d  int
		wantNil     bool
		wantTime    time.Time
	}{
		{"valid date", 2026, 5, 21, false, time.Date(2026, 5, 21, 0, 0, 0, 0, time.UTC)},
		{"zero year is nil", 0, 5, 21, true, time.Time{}},
		{"zero month is nil", 2026, 0, 21, true, time.Time{}},
		{"zero day is nil", 2026, 5, 0, true, time.Time{}},
		{"all zero is nil", 0, 0, 0, true, time.Time{}},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := MakeDate(tt.year, tt.m, tt.d)
			if tt.wantNil {
				assert.Nil(t, got)
				return
			}
			require.NotNil(t, got)
			assert.True(t, tt.wantTime.Equal(*got), "want %v got %v", tt.wantTime, *got)
			assert.Equal(t, time.UTC, got.Location())
		})
	}
}
