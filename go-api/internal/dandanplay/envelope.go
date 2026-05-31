// Package dandanplay — JSON envelope writers for the 4 /api/dandanplay/*
// endpoints.  All four shapes are NON-standard (they do not wrap in
// `{"data":…}`) so this file lives outside internal/httpx.  Two helpers
// cover every endpoint:
//
//   - writeJSON: marshals any payload directly — used by /match, /search,
//     /episodes/:animeId, and /comments/:episodeId.  Mirrors Express's
//     `res.json(payload)` byte-for-byte (HTML escaping off, no trailing
//     newline, Content-Type with charset).
//   - writeBareErrorJSON: emits `{"error":"<msg>"}` — used by /comments
//     and /episodes when the path/query parameters are malformed or the
//     upstream returns "anime not found".  Express's only two endpoints
//     that diverge from the standard `{error:{code,message}}` envelope.
package dandanplay

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
)

// writeJSON serialises payload directly as the response body.  HTML
// escaping is disabled and the trailing newline json.Encoder appends is
// trimmed — matches httpx.writeJSON byte-output so a byte-level diff vs
// Express stays green.
//
// On marshal failure the response degrades to a 500 with the standard
// `{error:{code,message}}` shape and a slog.Warn so the deploy alarms
// fire.  This is the only branch in this file that uses the standard
// envelope — the dandanplay-specific bare shapes are reserved for
// expected control flow (bad params / not found).
func writeJSON(w http.ResponseWriter, status int, payload any) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(payload); err != nil {
		slog.Warn("dandanplay envelope marshal failed", "err", err)
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":{"code":"SERVER_ERROR","message":"internal error"}}`))
		return
	}
	body := bytes.TrimRight(buf.Bytes(), "\n")

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if _, err := w.Write(body); err != nil {
		slog.Warn("dandanplay envelope write failed", "err", err)
	}
}

// writeBareErrorJSON emits the Express-quirky `{"error":"<msg>"}` shape
// used by /comments/:episodeId (Invalid episodeId) and
// /episodes/:animeId (Anime not found on dandanplay).  These two
// endpoints deviate from the standard `{error:{code,message}}` envelope
// historically — preserved verbatim here so the frontend's error-key
// detection logic doesn't break on cutover.
func writeBareErrorJSON(w http.ResponseWriter, status int, message string) {
	body := struct {
		Error string `json:"error"`
	}{Error: message}
	writeJSON(w, status, body)
}

// marshalNoHTMLEscape serialises v with HTML escaping disabled and the
// trailing newline json.Encoder appends trimmed — produces the same
// byte shape writeJSON would, but as a []byte that can be returned
// from a MarshalJSON implementation.  Used by searchResultItem so the
// inner cache/dandan structs marshal once each through the same rule.
func marshalNoHTMLEscape(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}
