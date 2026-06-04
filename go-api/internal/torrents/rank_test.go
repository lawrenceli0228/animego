// Package torrents — rank_test.go
//
// Coverage for the dedup + rank pipeline:
//   - dedupByInfohash: same-hash rows collapse keeping the higher-seeder
//     copy; nil seeders loses to any known count; source priority breaks a
//     seeder tie; empty-hash rows pass through untouched (never merged);
//     base32 and hex encodings of one hash dedup together; survivor order
//     follows first appearance; the input slice is not mutated.
//   - rankItems: seeders desc with nil sunk to the bottom; date desc as the
//     secondary key; source priority as the final tie-break; stable for
//     fully-equal rows; the all-nil-seeders case degrades to date order.
//   - sourceRanks: registration order by default; advertised Priority
//     overrides registration order.
package torrents

import (
	"context"
	"testing"
)

// intPtr returns &n.  Local to this file — the seeder tests need an
// *int and no shared helper exists (strPtr already lives in
// garden_test.go for the *string fields).
func intPtr(n int) *int { return &n }

// magnetFor builds a minimal valid v1-hex magnet for a 40-hex infohash,
// so dedup tests can drive parseInfohash off a realistic magnet string.
func magnetFor(hexHash string) string {
	return "magnet:?xt=urn:btih:" + hexHash + "&dn=test"
}

// Two distinct, valid v1 infohashes for the dedup tables.
const (
	hashA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	hashB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
)

// capSource is a test Fetcher that advertises a Capabilities.Priority,
// so sourceRanks's priority-over-registration-order branch is exercised.
// Its Fetch is never called by the rank tests (they operate on
// pre-built item slices), but it satisfies the interface.
type capSource struct {
	name     Source
	priority int
}

func (s capSource) Name() Source { return s.name }
func (s capSource) Fetch(context.Context, string) ([]TorrentItem, error) {
	return nil, nil
}
func (s capSource) Capabilities() Capabilities {
	return Capabilities{Priority: s.priority}
}

// regWith builds a Registry from plain (no-Capabilities) sources in the
// given order, so sourceRanks falls back to pure registration order.
func regWith(names ...Source) *Registry {
	fetchers := make([]Fetcher, 0, len(names))
	for _, n := range names {
		fetchers = append(fetchers, newFuncSource(n, func(context.Context, string) ([]TorrentItem, error) {
			return nil, nil
		}))
	}
	return NewRegistry(fetchers...)
}

// ---------------------------------------------------------------------------
// sourceRanks
// ---------------------------------------------------------------------------

func TestSourceRanks(t *testing.T) {
	t.Parallel()

	t.Run("registration order when no source sets Priority", func(t *testing.T) {
		t.Parallel()
		ranks := sourceRanks(regWith(SourceGarden, SourceAcg, SourceNyaa))
		// garden registered first → highest score; nyaa last → lowest.
		if !(ranks[SourceGarden] > ranks[SourceAcg] && ranks[SourceAcg] > ranks[SourceNyaa]) {
			t.Errorf("expected garden > acg > nyaa, got %v", ranks)
		}
	})

	t.Run("advertised Priority overrides registration order", func(t *testing.T) {
		t.Parallel()
		// nyaa registered LAST but advertises the highest Priority → it must
		// outrank garden/acg despite its position.
		reg := NewRegistry(
			newFuncSource(SourceGarden, func(context.Context, string) ([]TorrentItem, error) { return nil, nil }),
			newFuncSource(SourceAcg, func(context.Context, string) ([]TorrentItem, error) { return nil, nil }),
			capSource{name: SourceNyaa, priority: 100},
		)
		ranks := sourceRanks(reg)
		if !(ranks[SourceNyaa] > ranks[SourceGarden] && ranks[SourceNyaa] > ranks[SourceAcg]) {
			t.Errorf("expected nyaa (high Priority) to outrank others, got %v", ranks)
		}
		// garden still beats acg via registration order (both Priority 0).
		if !(ranks[SourceGarden] > ranks[SourceAcg]) {
			t.Errorf("expected garden > acg on equal Priority, got %v", ranks)
		}
	})
}

// ---------------------------------------------------------------------------
// dedupByInfohash
// ---------------------------------------------------------------------------

func TestDedup(t *testing.T) {
	t.Parallel()

	// Default registry order garden > acg > nyaa for the priority tie-break.
	ranks := sourceRanks(regWith(SourceGarden, SourceAcg, SourceNyaa))

	t.Run("same hash collapses keeping the higher-seeder copy", func(t *testing.T) {
		t.Parallel()
		in := []TorrentItem{
			{Title: "low", Magnet: magnetFor(hashA), Source: SourceGarden, Seeders: intPtr(5)},
			{Title: "high", Magnet: magnetFor(hashA), Source: SourceNyaa, Seeders: intPtr(50)},
		}
		out := dedupByInfohash(in, ranks)
		if len(out) != 1 {
			t.Fatalf("expected 1 deduped item, got %d: %+v", len(out), out)
		}
		if out[0].Title != "high" || *out[0].Seeders != 50 {
			t.Errorf("expected the 50-seeder copy to win, got %+v", out[0])
		}
		// The kept copy is stamped with the normalised hash.
		if out[0].Infohash != hashA {
			t.Errorf("expected Infohash %q stamped, got %q", hashA, out[0].Infohash)
		}
	})

	t.Run("nil seeders loses to a known count (even zero)", func(t *testing.T) {
		t.Parallel()
		in := []TorrentItem{
			{Title: "unknown", Magnet: magnetFor(hashA), Source: SourceGarden, Seeders: nil},
			{Title: "zero", Magnet: magnetFor(hashA), Source: SourceNyaa, Seeders: intPtr(0)},
		}
		out := dedupByInfohash(in, ranks)
		if len(out) != 1 {
			t.Fatalf("expected 1 item, got %d", len(out))
		}
		if out[0].Title != "zero" {
			t.Errorf("a known 0-seeder count must beat nil/unknown, got %+v", out[0])
		}
	})

	t.Run("source priority breaks a seeder tie", func(t *testing.T) {
		t.Parallel()
		// Same hash, same seeders → garden (higher registration priority)
		// wins over nyaa even though nyaa appears second.
		in := []TorrentItem{
			{Title: "nyaa-copy", Magnet: magnetFor(hashA), Source: SourceNyaa, Seeders: intPtr(10)},
			{Title: "garden-copy", Magnet: magnetFor(hashA), Source: SourceGarden, Seeders: intPtr(10)},
		}
		out := dedupByInfohash(in, ranks)
		if len(out) != 1 {
			t.Fatalf("expected 1 item, got %d", len(out))
		}
		if out[0].Source != SourceGarden {
			t.Errorf("expected garden to win the seeder tie via priority, got %+v", out[0])
		}
	})

	t.Run("empty-hash rows pass through and are never merged", func(t *testing.T) {
		t.Parallel()
		// Two magnet-less rows (no btih) plus one real hash.  The two
		// empty-hash rows must BOTH survive (not collapsed into each other).
		in := []TorrentItem{
			{Title: "no-hash-1", Magnet: "magnet:?dn=a", Source: SourceAcg},
			{Title: "real", Magnet: magnetFor(hashA), Source: SourceGarden, Seeders: intPtr(3)},
			{Title: "no-hash-2", Magnet: "https://nyaa.si/x", Source: SourceNyaa},
		}
		out := dedupByInfohash(in, ranks)
		if len(out) != 3 {
			t.Fatalf("expected all 3 rows to survive (2 empty-hash + 1 real), got %d: %+v", len(out), out)
		}
		// Empty-hash rows keep an empty Infohash.
		for _, it := range out {
			if it.Title == "no-hash-1" || it.Title == "no-hash-2" {
				if it.Infohash != "" {
					t.Errorf("empty-hash row %q should keep empty Infohash, got %q", it.Title, it.Infohash)
				}
			}
		}
	})

	t.Run("base32 and hex encodings of one hash dedup together", func(t *testing.T) {
		t.Parallel()
		in := []TorrentItem{
			{Title: "hex", Magnet: magnetFor(knownV1Hex), Source: SourceNyaa, Seeders: intPtr(7)},
			{Title: "base32", Magnet: "magnet:?xt=urn:btih:" + knownV1Base32, Source: SourceGarden, Seeders: intPtr(99)},
		}
		out := dedupByInfohash(in, ranks)
		if len(out) != 1 {
			t.Fatalf("base32 and hex of one torrent must collapse to 1, got %d: %+v", len(out), out)
		}
		if *out[0].Seeders != 99 {
			t.Errorf("expected the 99-seeder copy to win across encodings, got %+v", out[0])
		}
		if out[0].Infohash != knownV1Hex {
			t.Errorf("survivor should carry the normalised hex hash, got %q", out[0].Infohash)
		}
	})

	t.Run("distinct hashes are both kept in first-seen order", func(t *testing.T) {
		t.Parallel()
		in := []TorrentItem{
			{Title: "B", Magnet: magnetFor(hashB), Source: SourceGarden},
			{Title: "A", Magnet: magnetFor(hashA), Source: SourceGarden},
		}
		out := dedupByInfohash(in, ranks)
		if len(out) != 2 {
			t.Fatalf("expected 2 distinct items, got %d", len(out))
		}
		if out[0].Title != "B" || out[1].Title != "A" {
			t.Errorf("survivor order should follow first appearance, got %+v", out)
		}
	})

	t.Run("does not mutate the input slice", func(t *testing.T) {
		t.Parallel()
		in := []TorrentItem{
			{Title: "low", Magnet: magnetFor(hashA), Source: SourceGarden, Seeders: intPtr(5)},
			{Title: "high", Magnet: magnetFor(hashA), Source: SourceNyaa, Seeders: intPtr(50)},
		}
		_ = dedupByInfohash(in, ranks)
		// The originals must be untouched (no Infohash stamped onto them).
		if in[0].Infohash != "" || in[1].Infohash != "" {
			t.Errorf("dedup must not mutate input items, got %+v", in)
		}
		if in[0].Title != "low" || in[1].Title != "high" {
			t.Errorf("dedup must not reorder/overwrite input, got %+v", in)
		}
	})
}

// ---------------------------------------------------------------------------
// rankItems
// ---------------------------------------------------------------------------

func TestRank(t *testing.T) {
	t.Parallel()

	ranks := sourceRanks(regWith(SourceGarden, SourceAcg, SourceNyaa))

	t.Run("seeders desc with nil sunk to the bottom", func(t *testing.T) {
		t.Parallel()
		in := []TorrentItem{
			{Title: "unknown", Source: SourceGarden, Seeders: nil},
			{Title: "mid", Source: SourceGarden, Seeders: intPtr(20)},
			{Title: "top", Source: SourceGarden, Seeders: intPtr(100)},
			{Title: "zero", Source: SourceGarden, Seeders: intPtr(0)},
		}
		out := rankItems(in, ranks)
		gotOrder := []string{out[0].Title, out[1].Title, out[2].Title, out[3].Title}
		want := []string{"top", "mid", "zero", "unknown"}
		for i := range want {
			if gotOrder[i] != want[i] {
				t.Fatalf("seeder ordering wrong: got %v, want %v", gotOrder, want)
			}
		}
	})

	t.Run("date desc breaks a seeder tie (or all-nil seeders)", func(t *testing.T) {
		t.Parallel()
		// All seeders nil → key 1 inert → falls through to date desc.
		in := []TorrentItem{
			{Title: "older", Source: SourceGarden, Date: strPtr("Mon, 01 Jan 2024 00:00:00 GMT")},
			{Title: "newer", Source: SourceGarden, Date: strPtr("Wed, 01 Jan 2025 00:00:00 GMT")},
			{Title: "no-date", Source: SourceGarden, Date: nil},
		}
		out := rankItems(in, ranks)
		// newer first, then older, then the unparseable/nil date (oldest).
		if out[0].Title != "newer" || out[1].Title != "older" || out[2].Title != "no-date" {
			t.Errorf("date ordering wrong: %v", []string{out[0].Title, out[1].Title, out[2].Title})
		}
	})

	t.Run("source priority is the final tie-break", func(t *testing.T) {
		t.Parallel()
		// Identical seeders + identical date → garden outranks acg outranks
		// nyaa via the registry priority.
		d := strPtr("Wed, 01 Jan 2025 00:00:00 GMT")
		in := []TorrentItem{
			{Title: "nyaa", Source: SourceNyaa, Seeders: intPtr(5), Date: d},
			{Title: "acg", Source: SourceAcg, Seeders: intPtr(5), Date: d},
			{Title: "garden", Source: SourceGarden, Seeders: intPtr(5), Date: d},
		}
		out := rankItems(in, ranks)
		if out[0].Source != SourceGarden || out[1].Source != SourceAcg || out[2].Source != SourceNyaa {
			t.Errorf("source tie-break wrong: %v",
				[]Source{out[0].Source, out[1].Source, out[2].Source})
		}
	})

	t.Run("stable for fully-equal rows", func(t *testing.T) {
		t.Parallel()
		// Same source, same seeders, same date → input order preserved.
		d := strPtr("Wed, 01 Jan 2025 00:00:00 GMT")
		in := []TorrentItem{
			{Title: "first", Source: SourceGarden, Seeders: intPtr(5), Date: d},
			{Title: "second", Source: SourceGarden, Seeders: intPtr(5), Date: d},
			{Title: "third", Source: SourceGarden, Seeders: intPtr(5), Date: d},
		}
		out := rankItems(in, ranks)
		if out[0].Title != "first" || out[1].Title != "second" || out[2].Title != "third" {
			t.Errorf("stable sort should preserve input order for equal rows, got %v",
				[]string{out[0].Title, out[1].Title, out[2].Title})
		}
	})

	t.Run("all-nil seeders degrades cleanly to date then source order", func(t *testing.T) {
		t.Parallel()
		in := []TorrentItem{
			{Title: "acg-newer", Source: SourceAcg, Date: strPtr("Wed, 01 Jan 2025 00:00:00 GMT")},
			{Title: "garden-older", Source: SourceGarden, Date: strPtr("Mon, 01 Jan 2024 00:00:00 GMT")},
		}
		out := rankItems(in, ranks)
		// Even though garden has higher source priority, the NEWER date wins
		// the higher-precedence key, so acg-newer sorts first.
		if out[0].Title != "acg-newer" {
			t.Errorf("date must outrank source priority: got %v",
				[]string{out[0].Title, out[1].Title})
		}
	})

	t.Run("RFC3339 (garden) and RFC1123 (rss) dates compare correctly", func(t *testing.T) {
		t.Parallel()
		in := []TorrentItem{
			{Title: "rss-2024", Source: SourceNyaa, Date: strPtr("Mon, 01 Jan 2024 00:00:00 GMT")},
			{Title: "garden-2025", Source: SourceGarden, Date: strPtr("2025-01-01T00:00:00Z")},
		}
		out := rankItems(in, ranks)
		if out[0].Title != "garden-2025" {
			t.Errorf("cross-format date comparison wrong: got %v",
				[]string{out[0].Title, out[1].Title})
		}
	})

	t.Run("does not mutate the input slice", func(t *testing.T) {
		t.Parallel()
		in := []TorrentItem{
			{Title: "low", Source: SourceGarden, Seeders: intPtr(1)},
			{Title: "high", Source: SourceGarden, Seeders: intPtr(9)},
		}
		_ = rankItems(in, ranks)
		if in[0].Title != "low" || in[1].Title != "high" {
			t.Errorf("rankItems must not reorder the input, got %v",
				[]string{in[0].Title, in[1].Title})
		}
	})
}
