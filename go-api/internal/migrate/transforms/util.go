// Package transforms contains the per-Mongo-collection migration logic.
//
// Each transform lives in its own file (users.go, anime_cache.go, etc.) and
// registers itself with the migrate package via init().  This file holds
// shared helpers used by every transform.
//
// Key contract: ObjectId → UUID mapping is DETERMINISTIC via uuid v5 over a
// fixed namespace.  This means re-running the migration on the same Mongo
// data produces the same UUIDs every time, which is required for FK
// integrity across the orchestrator's per-collection commit boundaries:
// when users runs first, the same MongoUserID → UUID mapping must hold
// when subscriptions / follows / comments / danmakus reference it later.
//
// AnimegoNamespace MUST NEVER CHANGE.  If it does, every UUID in every
// table changes, and FK references break catastrophically.  This is
// enforced by code review only — there is no automated guard.
package transforms

import (
	"fmt"
	"time"

	"github.com/google/uuid"
	"go.mongodb.org/mongo-driver/v2/bson"
)

// AnimegoNamespace is the frozen UUID v5 namespace used for ObjectId→UUID
// mapping across the entire animego migration.  Generated once for this
// project; never regenerate without coordinated re-migration.
var AnimegoNamespace = uuid.MustParse("ab8f6f3a-4c0d-5b3f-9c4d-7e8f1c2b3d4e")

// MongoIDToUUID maps a Mongo ObjectId (or string fallback) to a stable UUID.
// Returns uuid.Nil + error if the value is nil or an unrecognized type.
func MongoIDToUUID(id any) (uuid.UUID, error) {
	switch v := id.(type) {
	case bson.ObjectID:
		return uuid.NewSHA1(AnimegoNamespace, v[:]), nil
	case string:
		if v == "" {
			return uuid.Nil, fmt.Errorf("empty string ObjectId")
		}
		return uuid.NewSHA1(AnimegoNamespace, []byte(v)), nil
	case nil:
		return uuid.Nil, fmt.Errorf("nil ObjectId")
	default:
		return uuid.Nil, fmt.Errorf("unsupported _id type: %T", id)
	}
}

// MongoDateTime extracts a time.Time from a Mongo date-like field.
// Returns zero time + false when absent / null / wrong type.
func MongoDateTime(v any) (time.Time, bool) {
	switch d := v.(type) {
	case bson.DateTime:
		return d.Time().UTC(), true
	case time.Time:
		return d.UTC(), true
	case nil:
		return time.Time{}, false
	default:
		return time.Time{}, false
	}
}

// GetString returns m[key] as a string and a presence flag.
// Mongo string fields surface as Go `string`; anything else returns ("", false).
func GetString(m bson.M, key string) (string, bool) {
	v, ok := m[key]
	if !ok || v == nil {
		return "", false
	}
	s, ok := v.(string)
	return s, ok
}

// GetInt tolerates int / int32 / int64 / float64 storage.  Mongo numbers
// in bson.M arrive as one of these depending on whether the source was
// NumberInt, NumberLong, or Number (double).
func GetInt(m bson.M, key string) (int, bool) {
	v, ok := m[key]
	if !ok || v == nil {
		return 0, false
	}
	switch n := v.(type) {
	case int:
		return n, true
	case int32:
		return int(n), true
	case int64:
		return int(n), true
	case float64:
		return int(n), true
	default:
		return 0, false
	}
}

// GetFloat is the float counterpart to GetInt.
func GetFloat(m bson.M, key string) (float64, bool) {
	v, ok := m[key]
	if !ok || v == nil {
		return 0, false
	}
	switch n := v.(type) {
	case float64:
		return n, true
	case int:
		return float64(n), true
	case int32:
		return float64(n), true
	case int64:
		return float64(n), true
	default:
		return 0, false
	}
}

// GetBool returns m[key] as a bool with presence flag.
func GetBool(m bson.M, key string) (bool, bool) {
	v, ok := m[key]
	if !ok || v == nil {
		return false, false
	}
	b, ok := v.(bool)
	return b, ok
}

// GetArray extracts m[key] as a bson.A array (slice of any).  Returns nil + false
// if absent.  An empty array returns (empty, true).
func GetArray(m bson.M, key string) (bson.A, bool) {
	v, ok := m[key]
	if !ok || v == nil {
		return nil, false
	}
	switch a := v.(type) {
	case bson.A:
		return a, true
	case []any:
		return bson.A(a), true
	default:
		return nil, false
	}
}

// GetSubdoc extracts m[key] as a bson.M (embedded document).  Returns nil + false
// if absent / null / wrong type.
func GetSubdoc(m bson.M, key string) (bson.M, bool) {
	v, ok := m[key]
	if !ok || v == nil {
		return nil, false
	}
	switch s := v.(type) {
	case bson.M:
		return s, true
	case map[string]any:
		return bson.M(s), true
	default:
		return nil, false
	}
}

// StringPtr returns &s if s != "" else nil.  Used to map empty/null string
// fields to NULL Postgres values instead of empty strings.
func StringPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// MakeDate composes a *time.Time from year/month/day ints; returns nil if any
// component is zero (Mongo's default for missing embedded {year, month, day}).
func MakeDate(year, month, day int) *time.Time {
	if year == 0 || month == 0 || day == 0 {
		return nil
	}
	t := time.Date(year, time.Month(month), day, 0, 0, 0, 0, time.UTC)
	return &t
}
