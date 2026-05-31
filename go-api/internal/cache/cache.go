// Package cache provides a thin, typed TTL wrapper around ristretto/v2.
//
// The Express backend used a handful of Map-based caches with hand-rolled
// TTL. Ristretto is more accurate (TinyLFU eviction, real concurrency
// safety) and the wrapper here keeps the call sites identical to the JS
// originals: Set / Get / Delete / Clear, with TTL baked into Set.
//
// Each call site is expected to instantiate its own Cache[V] with a chosen
// DefaultTTL. Example:
//
//	searchCache, err := cache.New[SearchResult](cache.Config{
//	    NumCounters: 1e7,
//	    MaxCost:     1e8,
//	    DefaultTTL:  10 * time.Minute,
//	})
//	if err != nil { ... }
//	defer searchCache.Close()
//	searchCache.Set("query:foo", result)
//
// Note on visibility: ristretto's Set/SetWithTTL are asynchronous (writes
// flow through a small channel before becoming visible to Get). Production
// callers do not need to think about this — eventual visibility is fine —
// but tests that need read-after-write semantics MUST call Wait() in
// between.
package cache

import (
	"time"

	"github.com/dgraph-io/ristretto/v2"
)

// Sensible defaults, applied when Config fields are zero. These mirror the
// ristretto README recommendation: NumCounters ~ 10x expected items,
// MaxCost as a unit-less capacity (cost=1 per Set), BufferItems=64.
const (
	defaultNumCounters int64 = 1e7
	defaultMaxCost     int64 = 1e8
	defaultBufferItems int64 = 64
)

// itemCost is the cost we charge for every entry. We don't size by bytes;
// MaxCost is effectively a max-entry-count when cost is always 1.
const itemCost int64 = 1

// Config controls the underlying ristretto.Cache.
//
// Any field left at its zero value is replaced with a sensible default at
// New time:
//   - NumCounters = 1e7  (10M frequency counters, ~10MB)
//   - MaxCost     = 1e8  (with itemCost=1 => 100M entries cap)
//   - BufferItems = 64   (ristretto's recommended channel size)
//   - DefaultTTL  = 0    (no TTL; caller should override per cache)
//
// Negative values are passed through to ristretto, which will reject them
// with an error from New.
type Config struct {
	NumCounters int64
	MaxCost     int64
	BufferItems int64
	DefaultTTL  time.Duration
}

// Cache[V] is a typed TTL cache. V can be any type — for reference types
// (slices, maps, pointers) the value is handed back as-is from Get with no
// defensive copy, so callers must treat returned values as shared.
//
// Concurrency: ristretto is goroutine-safe; this wrapper adds no locks.
type Cache[V any] struct {
	inner *ristretto.Cache[string, V]
	ttl   time.Duration
}

// New constructs a Cache. Returns an error if ristretto rejects the
// configuration (negative NumCounters / MaxCost / BufferItems). Zero
// values for those fields are replaced with defaults before construction,
// so the zero Config{} is valid.
func New[V any](c Config) (*Cache[V], error) {
	cfg := applyDefaults(c)

	inner, err := ristretto.NewCache(&ristretto.Config[string, V]{
		NumCounters: cfg.NumCounters,
		MaxCost:     cfg.MaxCost,
		BufferItems: cfg.BufferItems,
	})
	if err != nil {
		return nil, err
	}

	return &Cache[V]{
		inner: inner,
		ttl:   cfg.DefaultTTL,
	}, nil
}

// applyDefaults returns a new Config with zero fields replaced by
// package defaults. Negative values are left untouched so ristretto can
// report them as configuration errors.
func applyDefaults(c Config) Config {
	if c.NumCounters == 0 {
		c.NumCounters = defaultNumCounters
	}
	if c.MaxCost == 0 {
		c.MaxCost = defaultMaxCost
	}
	if c.BufferItems == 0 {
		c.BufferItems = defaultBufferItems
	}
	return c
}

// Set stores value at key using the cache's DefaultTTL.
//
// Returns true if the write was accepted into ristretto's setBuf channel.
// Under cost pressure or a full buffer ristretto may reject the write and
// return false; this is rare in practice but the contract is "best
// effort".
//
// Note: ristretto's writes are asynchronous. A Get immediately following a
// Set may miss until the write is drained. Callers that need
// read-after-write must call Wait().
func (c *Cache[V]) Set(key string, value V) bool {
	return c.inner.SetWithTTL(key, value, itemCost, c.ttl)
}

// SetWithTTL overrides DefaultTTL for a single entry. A ttl of 0 means
// "never expire"; a negative ttl is treated as a no-op by ristretto and
// returns false.
func (c *Cache[V]) SetWithTTL(key string, value V, ttl time.Duration) bool {
	return c.inner.SetWithTTL(key, value, itemCost, ttl)
}

// Get returns (value, true) on hit, (zero, false) on miss or expiry.
func (c *Cache[V]) Get(key string) (V, bool) {
	return c.inner.Get(key)
}

// Delete removes key from the cache. No-op if the key is absent.
func (c *Cache[V]) Delete(key string) {
	c.inner.Del(key)
}

// Clear removes all entries from the cache.
func (c *Cache[V]) Clear() {
	c.inner.Clear()
}

// Wait blocks until any pending Set/SetWithTTL operations are visible to
// Get. Tests must call this between Set and Get because ristretto's
// writes are batched through a channel.
func (c *Cache[V]) Wait() {
	c.inner.Wait()
}

// Close releases ristretto's background goroutines. After Close, all
// methods on this Cache become no-ops (Set/SetWithTTL return false, Get
// returns the zero value, etc.). Calling Close twice is safe.
func (c *Cache[V]) Close() {
	c.inner.Close()
}
