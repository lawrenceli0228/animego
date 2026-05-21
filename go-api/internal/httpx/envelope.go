package httpx

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
)

// Pagination is the flat shape Express uses for list responses.  Fields are
// emitted in declaration order to match the Express controller output
// (data, total, page, hasMore, nextPage).
//
// NextPage is a pointer without omitempty: nil values serialise to JSON
// `null`, matching `nextPage: hasMore ? page + 1 : null` in
// server/controllers/follow.controller.js:59.
type Pagination struct {
	Total    int  `json:"total"`
	Page     int  `json:"page"`
	HasMore  bool `json:"hasMore"`
	NextPage *int `json:"nextPage"`
}

// dataResponse is the single-resource envelope.  Field ordering: data only.
type dataResponse struct {
	Data any `json:"data"`
}

// pageResponse is the paginated envelope.  Field ordering matters — must
// match Express:  data, total, page, hasMore, nextPage.
type pageResponse[T any] struct {
	Data     []T  `json:"data"`
	Total    int  `json:"total"`
	Page     int  `json:"page"`
	HasMore  bool `json:"hasMore"`
	NextPage *int `json:"nextPage"`
}

// errorResponse is the error envelope.  Field ordering: error -> code, message.
type errorResponse struct {
	Error errorBody `json:"error"`
}

type errorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Data writes a single-resource envelope.  Use when the response body has one
// logical entity (object, scalar, or any payload that is not a paginated list).
//
//	httpx.Data(w, http.StatusOK, animeDetail)
//	httpx.Data(w, http.StatusCreated, map[string]bool{"following": true})
//
// On write failure the error is logged via slog.Warn and discarded — callers
// cannot meaningfully recover once the response has started.
func Data(w http.ResponseWriter, status int, payload any) {
	writeJSON(w, status, dataResponse{Data: payload})
}

// Page writes a paginated envelope.  items is the data slice; p carries the
// total / page / hasMore / nextPage fields.  A nil items slice is treated as
// empty (serialises to `[]`) so callers cannot accidentally emit
// `"data":null` for an empty page.
//
// Type parameter T is the element type and only affects compile-time
// signature — runtime marshalling reflects normally.  Use it so callers do not
// pass non-slice values by accident.
//
//	httpx.Page(w, http.StatusOK, anime, httpx.Pagination{
//	    Total: 100, Page: 1, HasMore: true, NextPage: intPtr(2),
//	})
func Page[T any](w http.ResponseWriter, status int, items []T, p Pagination) {
	if items == nil {
		items = []T{}
	}
	writeJSON(w, status, pageResponse[T]{
		Data:     items,
		Total:    p.Total,
		Page:     p.Page,
		HasMore:  p.HasMore,
		NextPage: p.NextPage,
	})
}

// Fail writes an error envelope.  If err is an *APIError its Status, Code and
// Message are used; the optional cause chain is logged at warn level but is
// not exposed to the client.
//
// Any other error is treated as an unclassified internal error:  status 500,
// code SERVER_ERROR, message "internal error", with the original error logged
// via slog so the cause is preserved server-side.
//
//	if err := db.QueryRow(...).Scan(&user); err != nil {
//	    if errors.Is(err, pgx.ErrNoRows) {
//	        httpx.Fail(w, httpx.NewError(404, httpx.CodeNotFound, "用户不存在"))
//	        return
//	    }
//	    httpx.Fail(w, httpx.WrapError(err, 500, httpx.CodeServerError, "query failed"))
//	    return
//	}
func Fail(w http.ResponseWriter, err error) {
	if err == nil {
		slog.Warn("httpx.Fail called with nil error")
		err = NewError(http.StatusInternalServerError, CodeServerError, "internal error")
	}

	apiErr, ok := IsAPIError(err)
	if !ok {
		apiErr = NewError(http.StatusInternalServerError, CodeServerError, "internal error", WithCause(err))
	}

	if apiErr.cause != nil {
		slog.Warn("api error",
			"code", apiErr.Code,
			"status", apiErr.Status,
			"message", apiErr.Message,
			"cause", apiErr.cause.Error(),
		)
	}

	writeJSON(w, apiErr.statusOrDefault(), errorResponse{
		Error: errorBody{Code: apiErr.Code, Message: apiErr.Message},
	})
}

// writeJSON marshals v with HTML escaping disabled and writes it as the
// response body.  HTML escaping is off because the Express server emits raw
// `<` / `>` / `&` characters; matching that behaviour is required for
// byte-level shadow-traffic diff to pass.
//
// json.Encoder appends a trailing newline that the Express response does not
// have; we trim it before writing the body.  Express produces "{...}",
// httpx produces "{...}" — same bytes on the wire.
func writeJSON(w http.ResponseWriter, status int, v any) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		slog.Warn("envelope marshal failed", "err", err)
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":{"code":"SERVER_ERROR","message":"internal error"}}`))
		return
	}
	body := bytes.TrimRight(buf.Bytes(), "\n")

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if _, err := w.Write(body); err != nil {
		slog.Warn("envelope write failed", "err", err)
	}
}
