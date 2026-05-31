package httpx

import (
	"errors"
	"fmt"
	"net/http"
)

// APIError is the typed error value handlers return when they want a specific
// HTTP status + envelope code.  The cause field is preserved through
// errors.Unwrap but never sent to the client.
type APIError struct {
	Status  int    // HTTP status code (4xx or 5xx)
	Code    string // one of the constants in codes.go
	Message string // user-facing message; may be Chinese
	cause   error  // private internal error chain; surfaced via Unwrap
}

// Error implements the error interface.  Format is "<code>: <message>" so the
// raw error string is grep-able in logs without leaking the cause chain.
func (e *APIError) Error() string {
	if e == nil {
		return "<nil APIError>"
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

// Unwrap exposes the inner cause to errors.Is / errors.As consumers.  Returns
// nil if no cause was attached.
func (e *APIError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.cause
}

// Option configures an APIError at construction time.  Functional-options
// pattern — see ~/.claude/rules/golang/patterns.md.
type Option func(*APIError)

// WithCause attaches an internal error to the APIError.  The cause is not
// serialised to the client but is logged by Fail and survives errors.Unwrap.
func WithCause(err error) Option {
	return func(e *APIError) {
		e.cause = err
	}
}

// NewError builds an APIError without an existing error chain.  Pass
// WithCause(err) as an Option when an internal error should be preserved.
//
//	return httpx.NewError(404, httpx.CodeNotFound, "用户不存在")
//	return httpx.NewError(503, httpx.CodeServerError, "database unreachable",
//	                      httpx.WithCause(pingErr))
func NewError(status int, code, message string, opts ...Option) *APIError {
	e := &APIError{Status: status, Code: code, Message: message}
	for _, opt := range opts {
		opt(e)
	}
	return e
}

// WrapError converts an existing error into an APIError while preserving the
// cause chain.  Equivalent to NewError(..., WithCause(err)) but reads more
// naturally at call sites that already have an err value.
//
//	if err := db.Query(...); err != nil {
//	    return httpx.WrapError(err, 500, httpx.CodeServerError, "query failed")
//	}
func WrapError(err error, status int, code, message string) *APIError {
	return &APIError{Status: status, Code: code, Message: message, cause: err}
}

// IsAPIError extracts the APIError from an error chain if present.  Equivalent
// to errors.As but with a clearer return shape for handler call sites.
func IsAPIError(err error) (*APIError, bool) {
	var apiErr *APIError
	if errors.As(err, &apiErr) {
		return apiErr, true
	}
	return nil, false
}

// statusOrDefault returns the APIError's Status, or 500 if the value is in an
// unexpected range.  Defensive — handlers shouldn't construct status=0 errors,
// but Fail must never write WriteHeader(0).
func (e *APIError) statusOrDefault() int {
	if e.Status >= 100 && e.Status < 600 {
		return e.Status
	}
	return http.StatusInternalServerError
}
