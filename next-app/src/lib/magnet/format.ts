// Display formats for the magnet panel's dates and sizes.
//
// Pure: no React, no DOM. Dates are read in the viewer's time zone, which is
// what a "released on" day means to the person reading it.

/** ISO date-time with no zone: how Mikan writes its times, in UTC+8. */
const ZONELESS_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;

/** Mikan's own clock. go-api stamps a zone on these now; this covers anything that slips through. */
const MIKAN_ZONE = "+08:00";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * "2026-08-22", or "" when there is no date or it cannot be read.
 *
 * go-api sends RFC 3339. RFC 1123 ("Sat, 22 Aug 2026 21:17:35 +0800", what
 * the RSS feeds carried before) and Mikan's zoneless times still read, so a
 * response from before that change renders the same.
 */
export function formatReleaseDate(raw: string | null | undefined): string {
  if (!raw) return "";
  const text = raw.trim();
  const parsed = new Date(ZONELESS_ISO.test(text) ? `${text}${MIKAN_ZONE}` : text);
  if (Number.isNaN(parsed.getTime())) return "";
  return `${parsed.getFullYear()}-${pad2(parsed.getMonth() + 1)}-${pad2(parsed.getDate())}`;
}

const SIZE = /^\s*([\d.]+)\s*([KMGT]i?B|B)\s*$/i;

/**
 * The size as the row shows it: "6.6 GB", "352 MB". Binary units are named
 * like the decimal ones, as every other source already writes them; a size
 * under 1 KB is the "0 KB" placeholder some feeds send for "unknown", and
 * shows nothing.
 */
export function formatSize(raw: string | null | undefined): string {
  if (!raw) return "";
  const m = SIZE.exec(raw);
  if (!m) return "";
  const value = Number.parseFloat(m[1]);
  const unit = m[2].toUpperCase().replace("IB", "B");
  if (!Number.isFinite(value) || value <= 0 || unit === "B") return "";
  return `${m[1]} ${unit}`;
}
