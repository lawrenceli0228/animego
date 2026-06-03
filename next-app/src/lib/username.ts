// A username may contain characters that arrive percent-encoded in the route
// param — e.g. "the creator" comes in as "the%20creator". Next.js does NOT
// decode dynamic route params, so the raw param shows "%20" if rendered and
// double-encodes if passed back through encodeURIComponent.
//
// Discipline for the /u/[username] routes: decode the param ONCE at the page
// boundary to recover the real username, display that decoded value, and call
// encodeURIComponent again at every URL/API boundary.

export function decodeUsername(slug: string): string {
  try {
    return decodeURIComponent(slug);
  } catch {
    // Malformed encoding (e.g. a lone "%") — show as-is rather than throw.
    return slug;
  }
}
