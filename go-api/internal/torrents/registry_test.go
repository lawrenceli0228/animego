// Package torrents — registry_test.go
//
// Covers the pluggable-source seam added in the source-registry
// refactor.  These tests are additive — the pre-existing aggregator /
// fetcher tests are untouched and still exercise behaviour parity.
//
//   - Registry preserves registration order via Sources()
//   - Register appends in order
//   - replaceByName swaps a source in place (position preserved)
//   - the aggregator merges results in registry order even when a later
//     source finishes BEFORE an earlier one (ordering must come from the
//     registry, not goroutine completion timing)
//   - compile-time: the three built-in source adapters satisfy Fetcher,
//     and the RSS sources deliberately do NOT satisfy Capable
package torrents

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// ---------------------------------------------------------------------------
// Compile-time: adapters satisfy Fetcher; Capable is opt-in.
// ---------------------------------------------------------------------------

var (
	_ Fetcher = gardenSource{}
	_ Fetcher = acgSource{}
	_ Fetcher = nyaaSource{}
	_ Fetcher = funcSource{}
)

func TestRSSSources_DoNotImplementCapable(t *testing.T) {
	t.Parallel()

	// RSS scrapes have no seeders / special budget — they must stay the
	// zero-Capabilities default so a future ranker doesn't treat them as
	// richer than they are.
	if _, ok := any(acgSource{}).(Capable); ok {
		t.Fatal("acgSource should NOT implement Capable")
	}
	if _, ok := any(nyaaSource{}).(Capable); ok {
		t.Fatal("nyaaSource should NOT implement Capable")
	}

	// CapabilitiesOf falls back to the zero value for a non-Capable source.
	assert.Equal(t, Capabilities{}, CapabilitiesOf(acgSource{}))
	assert.Equal(t, Capabilities{}, CapabilitiesOf(nyaaSource{}))
}

// ---------------------------------------------------------------------------
// Registry ordering primitives.
// ---------------------------------------------------------------------------

func TestRegistry_PreservesRegistrationOrder(t *testing.T) {
	t.Parallel()

	g := newFuncSource(SourceGarden, staticFn(nil, nil))
	a := newFuncSource(SourceAcg, staticFn(nil, nil))
	n := newFuncSource(SourceNyaa, staticFn(nil, nil))

	r := NewRegistry(g, a, n)
	got := r.Sources()
	require.Len(t, got, 3)
	assert.Equal(t, SourceGarden, got[0].Name())
	assert.Equal(t, SourceAcg, got[1].Name())
	assert.Equal(t, SourceNyaa, got[2].Name())

	// Register appends last.
	extra := newFuncSource(Source("extra"), staticFn(nil, nil))
	r.Register(extra)
	got = r.Sources()
	require.Len(t, got, 4)
	assert.Equal(t, Source("extra"), got[3].Name())

	// Sources() returns a copy — mutating it must not affect the registry.
	got[0] = extra
	assert.Equal(t, SourceGarden, r.Sources()[0].Name(),
		"Sources() must return a defensive copy")
}

func TestRegistry_ReplaceByName_PreservesPosition(t *testing.T) {
	t.Parallel()

	r := NewRegistry(
		newFuncSource(SourceGarden, staticFn(nil, nil)),
		newFuncSource(SourceAcg, staticFn(nil, nil)),
		newFuncSource(SourceNyaa, staticFn(nil, nil)),
	)

	// Replace the middle source; order must be unchanged and the swap
	// must report a hit.
	replacement := newFuncSource(SourceAcg, staticFn([]TorrentItem{stubItem(SourceAcg)}, nil))
	require.True(t, r.replaceByName(replacement))

	got := r.Sources()
	assert.Equal(t, SourceGarden, got[0].Name())
	assert.Equal(t, SourceAcg, got[1].Name(), "replaced source keeps its position")
	assert.Equal(t, SourceNyaa, got[2].Name())

	// A name not present is a no-op miss.
	assert.False(t, r.replaceByName(newFuncSource(Source("nope"), staticFn(nil, nil))))
	assert.Len(t, r.Sources(), 3)
}

// ---------------------------------------------------------------------------
// Fan-out order: registry order wins over goroutine completion timing.
// ---------------------------------------------------------------------------

// TestRegistry_FanoutOrder asserts the merged output follows the
// registration order (garden → acg → nyaa) even when the FIRST source is
// the SLOWEST to return.  If the aggregator merged by completion order
// this would fail — it must merge by registry position.
func TestRegistry_FanoutOrder(t *testing.T) {
	t.Parallel()

	// garden is slow but registered first; acg/nyaa are instant.  The
	// slow source must still appear first in the merged slice.
	slowGarden := func(ctx context.Context, _ string) ([]TorrentItem, error) {
		select {
		case <-time.After(40 * time.Millisecond):
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		return []TorrentItem{stubItem(SourceGarden)}, nil
	}

	a := newTestAggregator(t,
		WithGardenFn(slowGarden),
		WithAcgFn(staticFn([]TorrentItem{stubItem(SourceAcg)}, nil)),
		WithNyaaFn(staticFn([]TorrentItem{stubItem(SourceNyaa)}, nil)),
	)

	out, err := a.Fetch(context.Background(), "naruto")
	require.NoError(t, err)
	require.Len(t, out, 3)
	assert.Equal(t, SourceGarden, out[0].Source, "garden registered first → merged first despite being slowest")
	assert.Equal(t, SourceAcg, out[1].Source)
	assert.Equal(t, SourceNyaa, out[2].Source)
}
