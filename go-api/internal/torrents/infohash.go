// Package torrents — infohash.go
//
// parseInfohash extracts and normalises the BitTorrent infohash from a
// magnet URI so the aggregator can dedup the same torrent surfaced by
// different sources.  It is deliberately source-agnostic: it works off
// the magnet string every source already produces, so no source needs a
// pre-populated Infohash field for dedup to function (nyaa builds its
// magnet from <nyaa:infoHash>, garden/acg carry it inline).
//
// Normalisation rules — two magnets are "the same torrent" iff their
// normalised hashes are byte-equal:
//
//   - The hash is read from the xt=urn:btih:<hash> parameter (the
//     "btih" — BitTorrent Info Hash — URN).  The xt key and the
//     "urn:btih:" prefix are matched case-insensitively; everything
//     after the prefix is the raw hash.
//   - A 40-char hex string is a v1 infohash; a 64-char hex string is a
//     v2 infohash.  Both are lower-cased and returned verbatim (length
//     preserved — v1 and v2 are NEVER truncated to align, since a 64-hex
//     v2 hash and its 40-hex truncation are different identifiers).
//   - A 32-char RFC4648 base32 string is the base32 ENCODING of a v1
//     hash; it is decoded to its 20 raw bytes and rendered as 40-char
//     lowercase hex.  This matters because some sources emit base32 and
//     others (nyaa) emit hex for the SAME torrent — comparing the two
//     encodings literally would miss the duplicate.
//   - Anything else (no xt=urn:btih:, an unrecognised length, or
//     undecodable base32) yields "" — the caller treats an empty hash as
//     "not deduplicable" and passes the row through untouched.
package torrents

import (
	"encoding/base32"
	"encoding/hex"
	"strings"
)

// btihPrefix is the URN that precedes a BitTorrent infohash inside a
// magnet's xt parameter.  Matched case-insensitively (the spec allows
// either case for the scheme/URN portions).
const btihPrefix = "urn:btih:"

// infohash length classes (in encoded characters):
//   - v1 hex:    40 chars (20 bytes)
//   - v2 hex:    64 chars (32 bytes)
//   - v1 base32: 32 chars (20 bytes, RFC4648 unpadded)
const (
	hexLenV1    = 40
	hexLenV2    = 64
	base32LenV1 = 32
)

// parseInfohash extracts the normalised infohash from magnet, or "" when
// the magnet carries no parseable xt=urn:btih:<hash>.  See the file
// docstring for the full normalisation contract.
//
// The result is suitable as a dedup key: equal non-empty results denote
// the same torrent.  v1 and v2 hashes land in distinct length buckets
// (40 vs 64 hex) so they never collide.
func parseInfohash(magnet string) string {
	raw := extractBtih(magnet)
	if raw == "" {
		return ""
	}
	return normaliseHash(raw)
}

// extractBtih pulls the raw (un-normalised) hash out of the first
// xt=urn:btih:<hash> parameter in the magnet.  Returns "" when there is
// no magnet scheme or no btih xt parameter.
//
// Parsing is done by hand rather than via net/url because magnet "URIs"
// are not strictly RFC-3986 query strings (the values are not
// percent-encoded in practice and url.Parse is needlessly strict about
// the opaque body); a split on '&'/';' over the part after '?' is the
// robust, allocation-light approach the wider BitTorrent ecosystem uses.
func extractBtih(magnet string) string {
	if !hasMagnetScheme(magnet) {
		return ""
	}

	// Everything after the first '?' is the parameter list.  A magnet with
	// no '?' has no xt, so there's nothing to extract.
	q := magnet[len(magnetScheme):]
	if i := strings.IndexByte(q, '?'); i >= 0 {
		q = q[i+1:]
	} else {
		return ""
	}

	// Parameters are '&'-separated; some producers use ';' as well, so we
	// accept either by normalising ';' to '&' first.
	q = strings.ReplaceAll(q, ";", "&")
	for _, param := range strings.Split(q, "&") {
		// xt is "exact topic"; multi-file v2 magnets may carry xt.1 / xt.2,
		// but the single-hash form (xt=...) is what every source here emits.
		// Match the key case-insensitively up to '='.
		eq := strings.IndexByte(param, '=')
		if eq < 0 {
			continue
		}
		if !strings.EqualFold(param[:eq], "xt") {
			continue
		}
		val := param[eq+1:]
		if len(val) >= len(btihPrefix) && strings.EqualFold(val[:len(btihPrefix)], btihPrefix) {
			return val[len(btihPrefix):]
		}
	}
	return ""
}

// normaliseHash canonicalises a raw infohash string into the comparison
// form: lowercase hex, with base32 v1 hashes decoded to 40-char hex.
// Returns "" for any input that isn't a recognised v1/v2 hex or v1
// base32 encoding.
func normaliseHash(raw string) string {
	raw = strings.TrimSpace(raw)

	switch len(raw) {
	case hexLenV1, hexLenV2:
		// Hex v1 (40) or v2 (64).  Validate it really is hex before
		// lower-casing so a 40-char non-hex blob doesn't masquerade as a
		// v1 hash; keep the original length (no truncation between
		// versions).
		lower := strings.ToLower(raw)
		if !isHex(lower) {
			return ""
		}
		return lower
	case base32LenV1:
		// base32-encoded v1 hash → decode to 20 bytes → 40-char hex.
		// RFC4648 base32 is upper-case A-Z2-7; upper-case the input so a
		// lower-cased magnet still decodes.
		decoded, err := base32.StdEncoding.DecodeString(strings.ToUpper(raw))
		if err != nil {
			return ""
		}
		return hex.EncodeToString(decoded)
	default:
		return ""
	}
}

// isHex reports whether s is non-empty and made up solely of [0-9a-f].
// Used on already-lowercased input, so upper-case hex digits are not
// accepted here (the caller lower-cases first).
func isHex(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}
