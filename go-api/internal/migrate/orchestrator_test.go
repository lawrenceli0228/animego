package migrate

import (
	"context"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.mongodb.org/mongo-driver/v2/bson"
)

// fakeTransform satisfies the Transform interface with no I/O.  Only Name
// and DependsOn are exercised by topoSort / transformNames; the rest are
// no-op stubs.
type fakeTransform struct {
	name string
	deps []string
}

func (f *fakeTransform) Name() string                                          { return f.name }
func (f *fakeTransform) MongoCollection() string                               { return f.name }
func (f *fakeTransform) PGTable() string                                       { return f.name }
func (f *fakeTransform) ConflictTarget() string                                { return "id" }
func (f *fakeTransform) DependsOn() []string                                   { return f.deps }
func (f *fakeTransform) TransformRow(context.Context, bson.M) ([]PGRow, error) { return nil, nil }

func ft(name string, deps ...string) *fakeTransform {
	return &fakeTransform{name: name, deps: deps}
}

// indexOf returns the position of name in the slice, or -1 if missing.
// Used to assert relative ordering of topoSort output without depending
// on the absolute order of independent nodes.
func indexOf(names []string, name string) int {
	for i, n := range names {
		if n == name {
			return i
		}
	}
	return -1
}

func TestTopoSort_Empty(t *testing.T) {
	t.Parallel()
	got, err := topoSort(nil)
	require.NoError(t, err)
	assert.Empty(t, got)
}

func TestTopoSort_Single(t *testing.T) {
	t.Parallel()
	got, err := topoSort([]Transform{ft("users")})
	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.Equal(t, "users", got[0].Name())
}

func TestTopoSort_LinearChain(t *testing.T) {
	t.Parallel()
	// follows → subscriptions → users (input intentionally not pre-sorted).
	got, err := topoSort([]Transform{
		ft("follows", "subscriptions"),
		ft("subscriptions", "users"),
		ft("users"),
	})
	require.NoError(t, err)
	names := transformNames(got)
	assert.Equal(t, []string{"users", "subscriptions", "follows"}, names)
}

func TestTopoSort_Diamond(t *testing.T) {
	t.Parallel()
	// danmakus depends on both anime_cache and users;
	// both anime_cache and users are independent roots.
	got, err := topoSort([]Transform{
		ft("danmakus", "anime_cache", "users"),
		ft("anime_cache"),
		ft("users"),
	})
	require.NoError(t, err)
	names := transformNames(got)

	require.Len(t, names, 3)
	// danmakus must come after both roots regardless of root order.
	assert.Greater(t, indexOf(names, "danmakus"), indexOf(names, "anime_cache"))
	assert.Greater(t, indexOf(names, "danmakus"), indexOf(names, "users"))
}

func TestTopoSort_IndependentNodesSortedAlphabetically(t *testing.T) {
	t.Parallel()
	// No deps at all — orchestrator sorts visit order alphabetically for
	// determinism (orchestrator.go:516-521), so output should follow.
	got, err := topoSort([]Transform{ft("zeta"), ft("alpha"), ft("mu")})
	require.NoError(t, err)
	assert.Equal(t, []string{"alpha", "mu", "zeta"}, transformNames(got))
}

func TestTopoSort_UnknownDependencyReturnsError(t *testing.T) {
	t.Parallel()
	got, err := topoSort([]Transform{
		ft("follows", "subscriptions"), // subscriptions not in input set
	})
	require.Error(t, err)
	assert.Nil(t, got)
	assert.Contains(t, err.Error(), "unknown")
	assert.Contains(t, err.Error(), "subscriptions")
}

// TestTopoSort_CyclePanics guards the documented contract at
// orchestrator.go:526-531: cycles in DependsOn are programmer errors and
// panic, NOT return error.  If you change this to a returned error you
// will silently break the assumption in Run().
func TestTopoSort_CyclePanics(t *testing.T) {
	t.Parallel()
	defer func() {
		r := recover()
		require.NotNil(t, r, "expected panic on dependency cycle")
		msg, ok := r.(string)
		require.True(t, ok, "panic payload should be string, got %T", r)
		assert.Contains(t, msg, "dependency cycle")
	}()

	_, _ = topoSort([]Transform{
		ft("a", "b"),
		ft("b", "a"),
	})
	t.Fatal("topoSort should have panicked on cycle")
}

func TestTopoSort_SelfCyclePanics(t *testing.T) {
	t.Parallel()
	defer func() {
		r := recover()
		require.NotNil(t, r, "expected panic on self-cycle")
		msg, _ := r.(string)
		assert.Contains(t, msg, "dependency cycle")
	}()
	_, _ = topoSort([]Transform{ft("a", "a")})
	t.Fatal("topoSort should have panicked on self-cycle")
}

func TestBuildUpsert(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name           string
		table          string
		cols           []string
		conflictTarget string
		want           string
	}{
		{
			name:           "plain insert when no conflict target",
			table:          "anime_genres",
			cols:           []string{"anime_id", "genre"},
			conflictTarget: "",
			want:           `INSERT INTO "anime_genres" ("anime_id", "genre") VALUES ($1, $2)`,
		},
		{
			name:           "upsert with single-column conflict",
			table:          "users",
			cols:           []string{"id", "username", "email"},
			conflictTarget: "id",
			want: `INSERT INTO "users" ("id", "username", "email") VALUES ($1, $2, $3) ` +
				`ON CONFLICT id DO UPDATE SET "id" = EXCLUDED."id", "username" = EXCLUDED."username", "email" = EXCLUDED."email"`,
		},
		{
			name:           "upsert with parenthesized composite conflict",
			table:          "follows",
			cols:           []string{"user_id", "anilist_id"},
			conflictTarget: "(user_id, anilist_id)",
			want: `INSERT INTO "follows" ("user_id", "anilist_id") VALUES ($1, $2) ` +
				`ON CONFLICT (user_id, anilist_id) DO UPDATE SET "user_id" = EXCLUDED."user_id", "anilist_id" = EXCLUDED."anilist_id"`,
		},
		{
			name:           "single column",
			table:          "anime_cache",
			cols:           []string{"anilist_id"},
			conflictTarget: "(anilist_id)",
			want: `INSERT INTO "anime_cache" ("anilist_id") VALUES ($1) ` +
				`ON CONFLICT (anilist_id) DO UPDATE SET "anilist_id" = EXCLUDED."anilist_id"`,
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := buildUpsert(tt.table, tt.cols, tt.conflictTarget)
			assert.Equal(t, tt.want, got)
		})
	}
}

// TestBuildUpsert_PlaceholderNumbering guards $N positional binding parity
// with len(cols).  pgx silently misbinds if placeholders drift.  Check the
// exact VALUES (...) block — substring checks like Contains("$1") would
// pass spuriously because "$1" is a prefix of "$10".
func TestBuildUpsert_PlaceholderNumbering(t *testing.T) {
	t.Parallel()
	cols := []string{"a", "b", "c", "d", "e", "f", "g", "h", "i", "j"}
	got := buildUpsert("t", cols, "")
	assert.Contains(t, got, "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)")
	// Past 10 cols would be a drift bug.
	assert.NotContains(t, got, "$11")
}

func TestPgQuoteIdent(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		in   string
		want string
	}{
		{"plain identifier", "users", `"users"`},
		{"snake case", "anime_cache", `"anime_cache"`},
		{"empty string", "", `""`},
		{"single embedded quote doubles", `foo"bar`, `"foo""bar"`},
		{"multiple embedded quotes", `a"b"c`, `"a""b""c"`},
		{"only quote", `"`, `""""`},
		{"identifier with space", "weird name", `"weird name"`},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			assert.Equal(t, tt.want, pgQuoteIdent(tt.in))
		})
	}
}

func TestExcerptDoc(t *testing.T) {
	t.Parallel()

	t.Run("scalars pass through", func(t *testing.T) {
		t.Parallel()
		got := excerptDoc(bson.M{
			"name":  "alice",
			"age":   42,
			"admin": true,
		})
		assert.Equal(t, "alice", got["name"])
		assert.Equal(t, 42, got["age"])
		assert.Equal(t, true, got["admin"])
		assert.NotContains(t, got, "_truncated")
	})

	t.Run("nested bson.M is replaced with placeholder", func(t *testing.T) {
		t.Parallel()
		got := excerptDoc(bson.M{
			"meta": bson.M{"deep": "value"},
		})
		v, ok := got["meta"].(string)
		require.True(t, ok, "nested doc should serialize to placeholder string")
		assert.True(t, strings.HasPrefix(v, "<") && strings.HasSuffix(v, ">"), "got %q", v)
	})

	t.Run("bson.A array is replaced with placeholder", func(t *testing.T) {
		t.Parallel()
		got := excerptDoc(bson.M{
			"tags": bson.A{"a", "b", "c"},
		})
		v, ok := got["tags"].(string)
		require.True(t, ok, "array should serialize to placeholder string")
		assert.True(t, strings.HasPrefix(v, "<"), "got %q", v)
		assert.True(t, strings.HasSuffix(v, ">"), "got %q", v)
	})

	t.Run("plain []any is replaced with placeholder", func(t *testing.T) {
		t.Parallel()
		got := excerptDoc(bson.M{
			"items": []any{1, 2, 3},
		})
		v, ok := got["items"].(string)
		require.True(t, ok)
		assert.True(t, strings.HasPrefix(v, "<"))
		assert.True(t, strings.HasSuffix(v, ">"))
	})

	t.Run("exactly 12 keys does not trigger truncation", func(t *testing.T) {
		t.Parallel()
		doc := bson.M{}
		for i := 0; i < 12; i++ {
			doc["k"+itoa(i)] = i
		}
		got := excerptDoc(doc)
		assert.Len(t, got, 12)
		assert.NotContains(t, got, "_truncated")
	})

	t.Run("more than 12 keys triggers truncation", func(t *testing.T) {
		t.Parallel()
		doc := bson.M{}
		for i := 0; i < 20; i++ {
			doc["k"+itoa(i)] = i
		}
		got := excerptDoc(doc)
		// 12 real entries + 1 _truncated marker — map iteration is random,
		// so we cannot assert WHICH 12 keys made it in.
		assert.Equal(t, true, got["_truncated"])
		assert.LessOrEqual(t, len(got), 13)
		assert.GreaterOrEqual(t, len(got), 12) // at least the 12 we counted before the break
	})

	t.Run("empty doc returns empty map", func(t *testing.T) {
		t.Parallel()
		got := excerptDoc(bson.M{})
		assert.Empty(t, got)
	})
}

func TestTransformNames(t *testing.T) {
	t.Parallel()

	t.Run("empty input", func(t *testing.T) {
		t.Parallel()
		assert.Empty(t, transformNames(nil))
		assert.Empty(t, transformNames([]Transform{}))
	})

	t.Run("preserves input order", func(t *testing.T) {
		t.Parallel()
		got := transformNames([]Transform{ft("c"), ft("a"), ft("b")})
		assert.Equal(t, []string{"c", "a", "b"}, got)
	})

	t.Run("matches input length", func(t *testing.T) {
		t.Parallel()
		got := transformNames([]Transform{ft("a"), ft("b"), ft("c"), ft("d")})
		assert.Len(t, got, 4)
	})
}

// itoa avoids pulling strconv just for a couple of test loops.  Same
// implementation as strconv.Itoa for non-negative ints (which is all the
// tests pass).
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}
