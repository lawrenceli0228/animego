package cache

import (
	"fmt"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// newTestCache builds a Cache[V] for tests with small but valid sizing.
// Defaults are intentionally small (1e4 counters, 1e3 max cost) so tests
// don't allocate 10MB of frequency counters per case.
func newTestCache[V any](t *testing.T, ttl time.Duration) *Cache[V] {
	t.Helper()
	c, err := New[V](Config{
		NumCounters: 1e4,
		MaxCost:     1e3,
		BufferItems: 64,
		DefaultTTL:  ttl,
	})
	require.NoError(t, err)
	t.Cleanup(c.Close)
	return c
}

// TestNew_DefaultsApplied verifies that a zero Config{} produces a
// working cache (i.e. zero fields are replaced with defaults rather than
// being passed through to ristretto, which would reject them).
func TestNew_DefaultsApplied(t *testing.T) {
	c, err := New[string](Config{})
	require.NoError(t, err)
	t.Cleanup(c.Close)

	ok := c.Set("key", "value")
	assert.True(t, ok, "Set should accept under default config")
	c.Wait()

	got, hit := c.Get("key")
	assert.True(t, hit)
	assert.Equal(t, "value", got)
}

// TestNew_InvalidConfig probes ristretto's rejection of negative sizing.
// Ristretto v2 returns an error for any negative NumCounters, MaxCost, or
// BufferItems. Zero values are NOT errors at our layer because
// applyDefaults swaps them in before reaching ristretto.
func TestNew_InvalidConfig(t *testing.T) {
	tests := []struct {
		name string
		cfg  Config
	}{
		{"negative NumCounters", Config{NumCounters: -1, MaxCost: 1e3, BufferItems: 64}},
		{"negative MaxCost", Config{NumCounters: 1e4, MaxCost: -1, BufferItems: 64}},
		{"negative BufferItems", Config{NumCounters: 1e4, MaxCost: 1e3, BufferItems: -1}},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			c, err := New[string](tc.cfg)
			assert.Error(t, err, "ristretto should reject negative sizing")
			assert.Nil(t, c)
		})
	}
}

// TestSet_Get_RoundTrip is the basic happy path.
func TestSet_Get_RoundTrip(t *testing.T) {
	c := newTestCache[string](t, time.Minute)

	require.True(t, c.Set("hello", "world"))
	c.Wait()

	got, ok := c.Get("hello")
	require.True(t, ok)
	assert.Equal(t, "world", got)
}

// TestGet_Miss verifies that an unset key returns zero + false.
func TestGet_Miss(t *testing.T) {
	c := newTestCache[string](t, time.Minute)

	got, ok := c.Get("nope")
	assert.False(t, ok)
	assert.Equal(t, "", got, "miss should return zero value")
}

// testValue is a small struct used to exercise Cache[V] with V as a
// non-string type, proving the generic plumbing works.
type testValue struct {
	ID   int
	Name string
	Tags []string
}

func TestSet_TypedStruct(t *testing.T) {
	c := newTestCache[testValue](t, time.Minute)

	want := testValue{ID: 42, Name: "fate", Tags: []string{"action", "drama"}}
	require.True(t, c.Set("anime:1", want))
	c.Wait()

	got, ok := c.Get("anime:1")
	require.True(t, ok)
	assert.Equal(t, want, got)
}

// TestSetWithTTL_Expires verifies that an entry written with an explicit
// short TTL is visible immediately after Wait() and gone after the TTL
// elapses.
//
// We use 50ms TTL + 200ms sleep + 100ms buffer to keep total wall time
// short while staying well clear of ristretto's TTL bucket granularity.
func TestSetWithTTL_Expires(t *testing.T) {
	// DefaultTTL deliberately long; per-call TTL is what we're testing.
	c := newTestCache[string](t, time.Hour)

	require.True(t, c.SetWithTTL("ephemeral", "boom", 50*time.Millisecond))
	c.Wait()

	got, ok := c.Get("ephemeral")
	require.True(t, ok, "should hit before TTL expires")
	assert.Equal(t, "boom", got)

	time.Sleep(200 * time.Millisecond)

	_, ok = c.Get("ephemeral")
	assert.False(t, ok, "should miss after TTL expires")
}

// TestDelete verifies Set → hit → Delete → miss.
func TestDelete(t *testing.T) {
	c := newTestCache[string](t, time.Minute)

	require.True(t, c.Set("doomed", "v"))
	c.Wait()

	_, ok := c.Get("doomed")
	require.True(t, ok)

	c.Delete("doomed")
	c.Wait()

	_, ok = c.Get("doomed")
	assert.False(t, ok, "Get after Delete should miss")
}

// TestClear verifies that Clear drops every entry.
func TestClear(t *testing.T) {
	c := newTestCache[string](t, time.Minute)

	keys := []string{"a", "b", "c"}
	for _, k := range keys {
		require.True(t, c.Set(k, "v:"+k))
	}
	c.Wait()

	// Sanity: all three should be hits before Clear.
	for _, k := range keys {
		_, ok := c.Get(k)
		require.True(t, ok, "key %q should be present before Clear", k)
	}

	c.Clear()
	c.Wait()

	for _, k := range keys {
		_, ok := c.Get(k)
		assert.False(t, ok, "key %q should be gone after Clear", k)
	}
}

// TestConcurrent_NoRace spawns 50 goroutines hammering Set + Get + Delete
// in a loop. The assertion is structural: no panic, no race (when run
// with -race), and Wait() drains cleanly at the end.
//
// We deliberately do not assert hit/miss counts because ristretto's
// admission policy and async setBuf make per-op outcomes nondeterministic
// under contention.
func TestConcurrent_NoRace(t *testing.T) {
	c := newTestCache[int](t, time.Minute)

	const (
		goroutines = 50
		iterations = 200
	)

	var wg sync.WaitGroup
	wg.Add(goroutines)

	for g := 0; g < goroutines; g++ {
		go func(g int) {
			defer wg.Done()
			for i := 0; i < iterations; i++ {
				key := fmt.Sprintf("g%d:i%d", g, i)
				c.Set(key, i)
				_, _ = c.Get(key)
				if i%10 == 0 {
					c.Delete(key)
				}
			}
		}(g)
	}

	wg.Wait()
	c.Wait() // drain pending Sets so cleanup is quiet
}

// TestClose verifies that after Close, all operations behave as safe
// no-ops. This matches ristretto's documented behavior:
//
//   - Set/SetWithTTL return false on a closed cache
//   - Get returns (zero, false)
//   - Delete/Clear/Wait return silently
//   - Close itself is idempotent
func TestClose(t *testing.T) {
	c, err := New[string](Config{
		NumCounters: 1e4,
		MaxCost:     1e3,
		BufferItems: 64,
		DefaultTTL:  time.Minute,
	})
	require.NoError(t, err)

	// Populate something so Close has work to do.
	require.True(t, c.Set("pre-close", "v"))
	c.Wait()

	c.Close()

	// All subsequent operations must be safe no-ops, not panics.
	assert.NotPanics(t, func() {
		ok := c.Set("post-close", "v")
		assert.False(t, ok, "Set on closed cache should return false")
	})

	assert.NotPanics(t, func() {
		ok := c.SetWithTTL("post-close", "v", time.Second)
		assert.False(t, ok)
	})

	assert.NotPanics(t, func() {
		got, ok := c.Get("post-close")
		assert.False(t, ok)
		assert.Equal(t, "", got)
	})

	assert.NotPanics(t, func() { c.Delete("post-close") })
	assert.NotPanics(t, func() { c.Clear() })
	assert.NotPanics(t, func() { c.Wait() })

	// Idempotent Close.
	assert.NotPanics(t, func() { c.Close() })
}

// ─── MaxCost does not mean "entries" unless you ask it to ──────────────────

// fillDistinct writes n unique keys, drains, and reports how many are
// still retrievable. Set → Wait → Get is the strongest read-after-write
// contract this wrapper offers, so anything missing afterwards was
// refused by the admission policy, not merely not-yet-visible.
func fillDistinct[V any](t *testing.T, c *Cache[V], n int, val V) int {
	t.Helper()
	for i := 0; i < n; i++ {
		c.SetWithTTL(strconv.Itoa(i), val, time.Minute)
	}
	c.Wait()
	present := 0
	for i := 0; i < n; i++ {
		if _, ok := c.Get(strconv.Itoa(i)); ok {
			present++
		}
	}
	return present
}

func TestMaxCostCountsRistrettoOverheadUnlessIgnored(t *testing.T) {
	// The trap this pins: itemCost is 1, so MaxCost reads like an entry
	// cap — and is not one. Ristretto adds sizeof(storeItem[any]) = 56
	// bytes to every entry before the admission policy sees it, so the
	// real ceiling is MaxCost/57.
	//
	// It fails SILENTLY, which is what makes it worth a test rather
	// than a comment: SetWithTTL returns true, Wait() returns, and Get
	// still misses. A cache sized by this arithmetic does not report
	// that it is 57x smaller than intended — it just keeps sending
	// callers back to whatever it was supposed to be saving them from.
	const maxCost = 1000
	const writes = 900 // comfortably under maxCost, far over maxCost/57

	t.Run("default: MaxCost is a byte budget including overhead", func(t *testing.T) {
		c, err := New[string](Config{NumCounters: 1e4, MaxCost: maxCost})
		require.NoError(t, err)
		t.Cleanup(c.Close)

		present := fillDistinct(t, c, writes, "v")
		t.Logf("%d/%d survived admission with MaxCost=%d", present, writes, maxCost)
		assert.Less(t, present, writes/2,
			"MaxCost still behaved like an entry cap — either ristretto stopped "+
				"charging its internal cost, or itemCost changed; re-read the "+
				"sizing comments on every cache.New call site before trusting them")
	})

	t.Run("IgnoreInternalCost: MaxCost is an entry cap", func(t *testing.T) {
		c, err := New[string](Config{
			NumCounters:        1e4,
			MaxCost:            maxCost,
			IgnoreInternalCost: true,
		})
		require.NoError(t, err)
		t.Cleanup(c.Close)

		present := fillDistinct(t, c, writes, "v")
		t.Logf("%d/%d survived admission with MaxCost=%d", present, writes, maxCost)
		assert.Equal(t, writes, present,
			"entries were rejected below the configured entry cap")
	})
}
