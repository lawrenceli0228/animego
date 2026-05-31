package admin

// envelope.go — list-envelope helpers and the page-number parser
// shared by the two list endpoints.
//
// httpx.Page emits {data, total, page, hasMore, nextPage} in that
// order — but Express's listEnrichment + listUsers use
// {data, hasMore, total, page} and do NOT emit nextPage.  We can't
// reuse httpx.Page for byte-exact parity, so a dedicated writer
// lives here.  Behaviour mirrors httpx.writeJSON (HTML escaping off,
// no trailing newline) so the bytes-on-the-wire are identical to
// what Express produces.

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
)

// writeListEnvelope serialises v as JSON with HTML-escaping disabled
// and writes it to w.  Used by ListEnrichment + ListUsers because the
// Express response shape is {data, hasMore, total, page} — a custom
// ordering that the httpx package doesn't know about.
//
// On marshal failure the function falls back to the generic 500
// SERVER_ERROR envelope (same shape as httpx.Fail's emergency path).
func writeListEnvelope(w http.ResponseWriter, status int, v any) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		slog.Warn("admin envelope marshal failed", "err", err)
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":{"code":"SERVER_ERROR","message":"internal error"}}`))
		return
	}
	body := bytes.TrimRight(buf.Bytes(), "\n")

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if _, err := w.Write(body); err != nil {
		slog.Warn("admin envelope write failed", "err", err)
	}
}

// parsePage parses the ?page= query parameter with the same
// semantics as Express's `Math.max(1, parseInt(req.query.page, 10) || 1)`:
//   - empty / non-numeric / NaN  → 1
//   - <1                          → 1
//   - otherwise                   → the parsed int
//
// The function deliberately accepts negative / zero values rather
// than erroring — Express clamps silently and we match.
func parsePage(s string) int {
	if s == "" {
		return 1
	}
	n, err := strconv.Atoi(s)
	if err != nil || n < 1 {
		return 1
	}
	return n
}
