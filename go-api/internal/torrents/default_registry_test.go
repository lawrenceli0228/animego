// Package torrents — default_registry_test.go
//
// Locks in the default fan-out registry that New() builds now that dmhy,
// mikan and tosho are registered: the canonical merge order must be
// garden → acg → nyaa → dmhy → mikan → tosho (the first three unchanged so
// the existing order-sensitive tests keep holding; the newer sources
// appended last).  Also verifies the default dmhyFn / mikanFn are wired
// (non-nil) when no override is supplied, mirroring the gardenFn /
// acgFn / nyaaFn default-wiring contract.
package torrents

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNew_DefaultRegistry_OrderAndNewSources(t *testing.T) {
	t.Parallel()

	a, err := New()
	require.NoError(t, err)
	t.Cleanup(a.Close)

	got := a.registry.Sources()
	names := make([]Source, len(got))
	for i, s := range got {
		names[i] = s.Name()
	}

	assert.Equal(t,
		[]Source{SourceGarden, SourceAcg, SourceNyaa, SourceDmhy, SourceMikan, SourceTosho},
		names,
		"default registry order: garden → acg → nyaa → dmhy → mikan → tosho (new sources appended last)",
	)
}

func TestNew_DefaultDmhyMikanFnsWired(t *testing.T) {
	t.Parallel()

	a, err := New()
	require.NoError(t, err)
	t.Cleanup(a.Close)

	require.NotNil(t, a.dmhyFn, "default dmhyFn should be wired to the real adapter")
	require.NotNil(t, a.mikanFn, "default mikanFn should be wired to the real adapter")
}

// WithDmhyFn / WithMikanFn must override IN PLACE — the new source keeps
// its appended position so merge order is unchanged.
func TestNew_WithDmhyMikanFn_PreservesPosition(t *testing.T) {
	t.Parallel()

	a, err := New(
		WithDmhyFn(staticFn([]TorrentItem{stubItem(SourceDmhy)}, nil)),
		WithMikanFn(staticFn([]TorrentItem{stubItem(SourceMikan)}, nil)),
	)
	require.NoError(t, err)
	t.Cleanup(a.Close)

	got := a.registry.Sources()
	require.Len(t, got, 6)
	assert.Equal(t, SourceDmhy, got[3].Name(), "dmhy override keeps position 3")
	assert.Equal(t, SourceMikan, got[4].Name(), "mikan override keeps position 4")
	assert.Equal(t, SourceTosho, got[5].Name(), "tosho stays appended at position 5")
}
