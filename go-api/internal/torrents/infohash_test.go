// Package torrents — infohash_test.go
//
// Table-driven coverage for parseInfohash: v1 hex, v2 hex, base32→hex
// normalisation, case-folding, the xt-key / urn-prefix case-insensitivity,
// multi-parameter magnets, and every "no parseable hash" path (missing
// scheme, missing xt, wrong length, non-hex, undecodable base32).
package torrents

import "testing"

// knownV1Hex and knownV1Base32 are the SAME v1 infohash in the two
// encodings sources emit.  The base32 form decodes to exactly this hex,
// which is what lets dedup match a base32 source against a hex source.
const (
	knownV1Hex    = "c12fe1c06bba254a9dc9f519b335aa7c1367a88a"
	knownV1Base32 = "YEX6DQDLXISUVHOJ6UM3GNNKPQJWPKEK"
	// A v2 (SHA-256) infohash is 64 hex chars.
	knownV2Hex = "caf1e1d3a3f2b9c4e5d6071829364554637281901a2b3c4d5e6f70819a2b3c4d"
)

func TestParseInfohash(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		magnet string
		want   string
	}{
		{
			name:   "v1 hex lowercase",
			magnet: "magnet:?xt=urn:btih:" + knownV1Hex + "&dn=Some.Anime",
			want:   knownV1Hex,
		},
		{
			name:   "v1 hex uppercase is lowercased",
			magnet: "magnet:?xt=urn:btih:C12FE1C06BBA254A9DC9F519B335AA7C1367A88A",
			want:   knownV1Hex,
		},
		{
			name:   "v1 hex mixed case is lowercased",
			magnet: "magnet:?xt=urn:btih:C12fe1C06bba254A9dc9F519b335AA7c1367a88A",
			want:   knownV1Hex,
		},
		{
			name:   "v1 base32 decodes to the SAME hex as the hex form",
			magnet: "magnet:?xt=urn:btih:" + knownV1Base32 + "&dn=Some.Anime",
			want:   knownV1Hex,
		},
		{
			name:   "v1 base32 lowercased still decodes",
			magnet: "magnet:?xt=urn:btih:yex6dqdlxisuvhoj6um3gnnkpqjwpkek",
			want:   knownV1Hex,
		},
		{
			name:   "v2 hash (64 hex) is preserved at full length, not truncated",
			magnet: "magnet:?xt=urn:btih:" + knownV2Hex,
			want:   knownV2Hex,
		},
		{
			name:   "xt key is matched case-insensitively",
			magnet: "magnet:?XT=urn:btih:" + knownV1Hex,
			want:   knownV1Hex,
		},
		{
			name:   "urn:btih prefix is matched case-insensitively",
			magnet: "magnet:?xt=URN:BTIH:" + knownV1Hex,
			want:   knownV1Hex,
		},
		{
			name:   "btih xt found among other parameters",
			magnet: "magnet:?dn=Anime&xt=urn:btih:" + knownV1Hex + "&tr=http%3A%2F%2Ftracker%2Fannounce",
			want:   knownV1Hex,
		},
		{
			name:   "semicolon-separated parameters are accepted",
			magnet: "magnet:?dn=Anime;xt=urn:btih:" + knownV1Hex,
			want:   knownV1Hex,
		},
		{
			name:   "missing magnet scheme yields empty",
			magnet: "https://nyaa.si/download/123.torrent",
			want:   "",
		},
		{
			name:   "magnet with no parameters yields empty",
			magnet: "magnet:",
			want:   "",
		},
		{
			name:   "magnet with no xt parameter yields empty",
			magnet: "magnet:?dn=Anime&tr=http%3A%2F%2Ftracker",
			want:   "",
		},
		{
			name:   "non-btih xt (ed2k) yields empty",
			magnet: "magnet:?xt=urn:ed2k:31d6cfe0d16ae931b73c59d7e0c089c0",
			want:   "",
		},
		{
			name:   "wrong-length hex (39 chars) yields empty",
			magnet: "magnet:?xt=urn:btih:c12fe1c06bba254a9dc9f519b335aa7c1367a88",
			want:   "",
		},
		{
			name:   "40 chars but non-hex (contains g/z) yields empty",
			magnet: "magnet:?xt=urn:btih:g12fe1c06bba254a9dc9f519b335aa7c1367a88z",
			want:   "",
		},
		{
			name:   "32 chars but invalid base32 alphabet (contains 0/1/8/9) yields empty",
			magnet: "magnet:?xt=urn:btih:00000000000000000000000000000018",
			want:   "",
		},
		{
			name:   "empty string yields empty",
			magnet: "",
			want:   "",
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := parseInfohash(tc.magnet)
			if got != tc.want {
				t.Errorf("parseInfohash(%q) = %q, want %q", tc.magnet, got, tc.want)
			}
		})
	}
}

// TestParseInfohash_Base32EqualsHex locks in the core dedup invariant:
// the base32 encoding and the hex encoding of one torrent normalise to
// the identical string, so two sources emitting different encodings still
// dedup together.
func TestParseInfohash_Base32EqualsHex(t *testing.T) {
	t.Parallel()

	hexForm := parseInfohash("magnet:?xt=urn:btih:" + knownV1Hex)
	b32Form := parseInfohash("magnet:?xt=urn:btih:" + knownV1Base32)

	if hexForm == "" || b32Form == "" {
		t.Fatalf("both encodings must parse: hex=%q base32=%q", hexForm, b32Form)
	}
	if hexForm != b32Form {
		t.Errorf("base32 and hex must normalise equal: hex=%q base32=%q", hexForm, b32Form)
	}
}
