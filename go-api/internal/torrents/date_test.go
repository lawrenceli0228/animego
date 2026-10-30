package torrents

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestNormalizeDate_EverySourceLayout feeds each source's real date
// layout through normalizeDate and expects the single wire layout back.
func TestNormalizeDate_EverySourceLayout(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		raw  string
		want string
	}{
		{"nyaa RFC1123Z -0000", "Sat, 12 Sep 2026 15:45:00 -0000", "2026-09-12T15:45:00Z"},
		{"dmhy RFC1123Z +0800", "Sat, 22 Aug 2026 21:17:35 +0800", "2026-08-22T13:17:35Z"},
		{"acg.rip RFC1123 GMT", "Sat, 01 Jan 2026 00:00:00 GMT", "2026-01-01T00:00:00Z"},
		{"garden RFC3339 millis", "2026-08-11T22:07:00.000Z", "2026-08-11T22:07:00Z"},
		{"RFC3339 with offset", "2026-08-11T22:07:00+09:00", "2026-08-11T13:07:00Z"},
		{"already wire layout", "2026-08-11T22:07:00Z", "2026-08-11T22:07:00Z"},
		{"surrounding whitespace", "  Sat, 12 Sep 2026 15:45:00 -0000\n", "2026-09-12T15:45:00Z"},
	}
	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := normalizeDate(tc.raw)
			require.NotNil(t, got)
			assert.Equal(t, tc.want, *got)
		})
	}
}

// TestNormalizeDate_UnparseableIsNil: a date we can't read becomes JSON
// null, never a pass-through string in an unknown layout.  A zone-less
// Mikan string is unparseable here on purpose — only normalizeMikanDate
// knows which zone it is in.
func TestNormalizeDate_UnparseableIsNil(t *testing.T) {
	t.Parallel()

	for _, raw := range []string{"", "   ", "t", "yesterday", "2026-13-45", "2026-05-11T17:35:00"} {
		assert.Nil(t, normalizeDate(raw), "raw %q", raw)
	}
}

// TestNormalizeMikanDate_ZonelessIsUTCPlus8 pins Mikan's zone.  The pairs
// are the same releases (matched by infohash) in Mikan's and dmhy's RSS
// for one search on 2026-10-31; dmhy states +0800 and Mikan, which
// truncates to the minute, agrees on the wall-clock minute.
func TestNormalizeMikanDate_ZonelessIsUTCPlus8(t *testing.T) {
	t.Parallel()

	tests := []struct {
		mikan string
		dmhy  string
	}{
		{"2026-10-17T23:42:00", "Sat, 17 Oct 2026 23:42:42 +0800"},
		{"2026-08-22T21:17:00", "Sat, 22 Aug 2026 21:17:35 +0800"},
		{"2026-08-28T05:32:00", "Fri, 28 Aug 2026 05:32:34 +0800"},
	}
	for _, tc := range tests {
		got := normalizeMikanDate(tc.mikan)
		require.NotNil(t, got, tc.mikan)
		dm := normalizeDate(tc.dmhy)
		require.NotNil(t, dm, tc.dmhy)

		mt, err := time.Parse(time.RFC3339, *got)
		require.NoError(t, err)
		dt, err := time.Parse(time.RFC3339, *dm)
		require.NoError(t, err)
		assert.Equal(t, dt.Truncate(time.Minute), mt,
			"Mikan %s and dmhy %s are the same release; read as UTC+8 they land on the same minute", tc.mikan, tc.dmhy)
	}

	got := normalizeMikanDate("2026-05-11T17:35:00")
	require.NotNil(t, got)
	assert.Equal(t, "2026-05-11T09:35:00Z", *got)
}

// TestNormalizeMikanDate_FractionAndZonedInput: the per-bangumi feed adds
// microseconds, which are dropped; a value that carries a zone is
// honoured as-is rather than forced to UTC+8.
func TestNormalizeMikanDate_FractionAndZonedInput(t *testing.T) {
	t.Parallel()

	got := normalizeMikanDate("2026-08-12T06:12:15.638227")
	require.NotNil(t, got)
	assert.Equal(t, "2026-08-11T22:12:15Z", *got)

	got = normalizeMikanDate("Sat, 03 Jan 2026 09:00:00 GMT")
	require.NotNil(t, got)
	assert.Equal(t, "2026-01-03T09:00:00Z", *got)

	assert.Nil(t, normalizeMikanDate(""))
	assert.Nil(t, normalizeMikanDate("not a date"))
}

// TestToshoDate_WireLayout: AnimeTosho's unix seconds come out in the
// same layout as every other source.
func TestToshoDate_WireLayout(t *testing.T) {
	t.Parallel()

	got := toshoDate(time.Date(2026, 9, 12, 15, 45, 0, 0, time.UTC).Unix())
	require.NotNil(t, got)
	assert.Equal(t, "2026-09-12T15:45:00Z", *got)
	assert.Nil(t, toshoDate(0))
}

// TestRankItems_MikanDateNoLongerSinks is the bug the normalisation
// fixes: a Mikan row used to carry a zone-less date that parseItemDate
// could not read, so it sorted as the oldest row however new it was.
func TestRankItems_MikanDateNoLongerSinks(t *testing.T) {
	t.Parallel()

	items := []TorrentItem{
		{Title: "older nyaa", Source: SourceNyaa, Date: normalizeDate("Sat, 12 Sep 2026 15:45:00 -0000")},
		{Title: "newer mikan", Source: SourceMikan, Date: normalizeMikanDate("2026-10-17T23:42:00")},
	}
	ranked := rankItems(items, map[Source]int{SourceNyaa: 2, SourceMikan: 1})
	require.Len(t, ranked, 2)
	assert.Equal(t, "newer mikan", ranked[0].Title, "the October Mikan release must rank above the September Nyaa one")
}
