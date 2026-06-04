// Package torrents — rss_test.go
//
// Direct unit coverage of the shared RSS mapping helper (mapRSSItems) —
// the filtering + field-mapping seam that dmhy and mikan plug their
// magnet/size resolvers into.  The HTTP fetch loop (fetchRSS) is covered
// transitively by the dmhy fixture tests; here we pin the pure mapping
// rules without any network/XML plumbing.
package torrents

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// identityMagnet returns the enclosure URL verbatim (the dmhy rule),
// constMagnet/constSize are tiny resolvers for the table cases.
func identityMagnet(it rssItem) string { return it.Enclosure.URL }

func TestMapRSSItems_FilterAndMapping(t *testing.T) {
	t.Parallel()

	items := []rssItem{
		// kept: magnet + title
		{
			Title:   "[GroupA] Show - 01",
			PubDate: "Sat, 01 Jan 2026 00:00:00 GMT",
			Enclosure: rssEnclosure{
				URL:    "magnet:?xt=urn:btih:aaa",
				Length: "1500000000",
			},
		},
		// dropped: non-magnet URL
		{
			Title:     "[GroupB] HTTP only",
			Enclosure: rssEnclosure{URL: "https://example/x.torrent"},
		},
		// dropped: empty title even though magnet present
		{
			Title:     "",
			Enclosure: rssEnclosure{URL: "magnet:?xt=urn:btih:bbb"},
		},
	}

	out := mapRSSItems(items, SourceDmhy, identityMagnet, func(it rssItem) string {
		return FormatBytes(it.Enclosure.Length)
	})

	require.Len(t, out, 1, "only the titled magnet item survives")
	it := out[0]
	assert.Equal(t, "[GroupA] Show - 01", it.Title)
	assert.Equal(t, "magnet:?xt=urn:btih:aaa", it.Magnet)
	assert.Equal(t, "1.5 GB", it.Size)
	assert.Equal(t, SourceDmhy, it.Source)
	require.NotNil(t, it.Fansub)
	assert.Equal(t, "GroupA", *it.Fansub)
	require.NotNil(t, it.Date)
	assert.Equal(t, "Sat, 01 Jan 2026 00:00:00 GMT", *it.Date)
	assert.Nil(t, it.Provider, "RSS sources never set provider")
}

// Empty / no-PubDate items must yield a nil Date (JSON null), matching
// the other fetchers via stringPtr.
func TestMapRSSItems_MissingDateIsNil(t *testing.T) {
	t.Parallel()

	items := []rssItem{{
		Title:     "[G] No date",
		Enclosure: rssEnclosure{URL: "magnet:?xt=urn:btih:ccc"},
	}}

	out := mapRSSItems(items, SourceDmhy, identityMagnet, func(rssItem) string { return "" })
	require.Len(t, out, 1)
	assert.Nil(t, out[0].Date, "absent pubDate → nil Date")
	assert.Equal(t, "", out[0].Size)
}

// An empty input slice yields a non-nil empty slice (never nil), so the
// aggregator can append unconditionally.
func TestMapRSSItems_EmptyInput(t *testing.T) {
	t.Parallel()

	out := mapRSSItems(nil, SourceDmhy, identityMagnet, func(rssItem) string { return "" })
	assert.NotNil(t, out)
	assert.Empty(t, out)
}
