// Package torrents — dedup_integration_test.go
//
// End-to-end assertions that the normalise → dedup → rank pass is wired
// into Aggregator.Fetch (not just unit-tested in isolation).  These drive
// the real fan-out via the WithXxxFn stubs and inspect the merged result.
//
// Kept in its own file (rather than appended to aggregator_test.go) so it
// doesn't collide with concurrent edits to the constructor/registration
// tests.  Reuses newTestAggregator / staticFn / strPtr / intPtr from the
// sibling _test.go files in this package.
package torrents

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestFetch_DedupsAndRanksAcrossSources is the integration test for the
// whole feature: two sources surface the SAME torrent (one in hex, one in
// base32) with different seeder counts, plus a couple of unique rows.  The
// merged Fetch result must:
//   - collapse the duplicate to one row (the higher-seeder copy), and
//   - come back ordered by seeders desc, with the nil-seeder row last.
func TestFetch_DedupsAndRanksAcrossSources(t *testing.T) {
	t.Parallel()

	// garden: the duplicate in HEX with 80 seeders, plus a unique 200-seeder
	// row that should rank first overall.
	gardenItems := []TorrentItem{
		{Title: "dup-hex", Magnet: magnetFor(knownV1Hex), Source: SourceGarden, Seeders: intPtr(80)},
		{Title: "garden-top", Magnet: magnetFor(hashB), Source: SourceGarden, Seeders: intPtr(200)},
	}
	// acg: the SAME torrent as garden's dup, but in BASE32 with FEWER seeders
	// (10) — must lose the merge to garden's 80.
	acgItems := []TorrentItem{
		{Title: "dup-base32", Magnet: "magnet:?xt=urn:btih:" + knownV1Base32, Source: SourceAcg, Seeders: intPtr(10)},
	}
	// nyaa: a unique row with UNKNOWN seeders → must sink to the bottom.
	nyaaItems := []TorrentItem{
		{Title: "nyaa-unknown", Magnet: magnetFor(hashA), Source: SourceNyaa, Seeders: nil},
	}

	a := newTestAggregator(t,
		WithGardenFn(staticFn(gardenItems, nil)),
		WithAcgFn(staticFn(acgItems, nil)),
		WithNyaaFn(staticFn(nyaaItems, nil)),
	)

	out, err := a.Fetch(context.Background(), "spy x family")
	require.NoError(t, err)

	// 4 inputs, one cross-source duplicate collapsed → 3 survivors.
	require.Len(t, out, 3, "the hex/base32 duplicate should collapse to one row")

	// Ranked by seeders desc: 200 (garden-top) → 80 (the merged dup) →
	// nil (nyaa-unknown) last.
	titles := []string{out[0].Title, out[1].Title, out[2].Title}
	assert.Equal(t, "garden-top", titles[0], "highest seeders first")
	assert.Equal(t, "nyaa-unknown", titles[2], "unknown seeders sink to the bottom")

	// The merged duplicate is garden's 80-seeder copy, and it carries the
	// normalised hex infohash regardless of which encoding survived.
	dup := out[1]
	require.NotNil(t, dup.Seeders)
	assert.Equal(t, 80, *dup.Seeders, "the higher-seeder copy of the duplicate must win")
	assert.Equal(t, knownV1Hex, dup.Infohash, "survivor carries the normalised hex hash")

	// Every survivor with a parseable magnet got its Infohash stamped.
	for _, it := range out {
		assert.NotEmpty(t, it.Infohash, "row %q should have a stamped infohash", it.Title)
	}
}
