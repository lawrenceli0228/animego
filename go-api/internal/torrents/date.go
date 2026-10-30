// Package torrents — date.go
//
// One date format on the wire.  Every source writes its timestamps its
// own way:
//
//	nyaa    "Sat, 12 Sep 2026 15:45:00 -0000"   (RFC 1123, numeric zone)
//	dmhy    "Sat, 22 Aug 2026 21:17:35 +0800"   (RFC 1123, numeric zone)
//	acg.rip "Sat, 01 Jan 2026 00:00:00 GMT"     (RFC 1123, zone name)
//	garden  "2026-08-11T22:07:00.000Z"          (RFC 3339, millis)
//	tosho   unix seconds                        (formatted by toshoDate)
//	Mikan   "2026-05-11T17:35:00"               (no zone at all)
//
// Passing them through verbatim left the frontend to parse six layouts,
// and the zone-less Mikan string defeated rank.go's parser outright, so
// every Mikan-only release sorted as "oldest".  Each mapper now runs its
// raw date through normalizeDate / normalizeMikanDate and the API emits
// one layout: RFC 3339 in UTC with whole seconds.
package torrents

import (
	"strings"
	"time"
)

// wireDateLayout is the one layout dates leave this package in: RFC 3339,
// UTC, whole seconds.  rank.go's RFC3339 layout parses it.
const wireDateLayout = "2006-01-02T15:04:05Z"

// zonedDateLayouts are the upstream layouts that carry their own offset.
// RFC3339 also accepts fractional seconds on parse, which covers garden's
// ".000Z".
var zonedDateLayouts = []string{
	time.RFC1123Z, // nyaa, dmhy
	time.RFC1123,  // acg.rip ("GMT")
	time.RFC3339,  // garden, tosho
}

// mikanDateLayout is Mikan's zone-less <torrent><pubDate>.  Go accepts a
// fractional-seconds tail on parse even though the layout omits it, which
// covers the per-bangumi feed's "2026-08-12T06:12:15.638227".
const mikanDateLayout = "2006-01-02T15:04:05"

// mikanLocation is the wall clock Mikan's zone-less timestamps are in.
// Checked 2026-10-31 by infohash against dmhy, which states its offset:
// Mikan "2026-10-17T23:42:00" is dmhy "Sat, 17 Oct 2026 23:42:42 +0800",
// Mikan "2026-08-22T21:17:00" is dmhy "Sat, 22 Aug 2026 21:17:35 +0800"
// (Mikan truncates to the minute).  A fixed zone rather than
// Asia/Shanghai keeps the binary independent of tzdata; China observes
// no daylight saving, so the two never differ.
var mikanLocation = time.FixedZone("UTC+8", 8*60*60)

// normalizeDate parses a timestamp that carries its own zone and returns
// it in wireDateLayout.  Empty or unparseable input yields nil (JSON
// null): a date we can't read is better absent than passed through in a
// layout the frontend and ranker don't understand.
func normalizeDate(raw string) *string {
	s := strings.TrimSpace(raw)
	if s == "" {
		return nil
	}
	for _, layout := range zonedDateLayouts {
		if t, err := time.Parse(layout, s); err == nil {
			return formatWireDate(t)
		}
	}
	return nil
}

// normalizeMikanDate parses Mikan's zone-less timestamp as UTC+8 (see
// mikanLocation).  A string that does carry a zone is honoured as-is, so
// a future Mikan feed that adds one keeps working.
func normalizeMikanDate(raw string) *string {
	if d := normalizeDate(raw); d != nil {
		return d
	}
	s := strings.TrimSpace(raw)
	if s == "" {
		return nil
	}
	t, err := time.ParseInLocation(mikanDateLayout, s, mikanLocation)
	if err != nil {
		return nil
	}
	return formatWireDate(t)
}

// formatWireDate renders t in wireDateLayout.  Fractional seconds are
// dropped: no source is precise below the second (Mikan not even below
// the minute), and one fixed width keeps the strings comparable.
func formatWireDate(t time.Time) *string {
	s := t.UTC().Format(wireDateLayout)
	return &s
}
