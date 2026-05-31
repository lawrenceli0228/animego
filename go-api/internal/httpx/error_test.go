package httpx

import (
	"errors"
	"fmt"
	"net/http"
	"testing"
)

func TestNewError_Basic(t *testing.T) {
	t.Parallel()

	e := NewError(http.StatusNotFound, CodeNotFound, "用户不存在")
	if e.Status != http.StatusNotFound {
		t.Errorf("status = %d, want 404", e.Status)
	}
	if e.Code != CodeNotFound {
		t.Errorf("code = %q, want %q", e.Code, CodeNotFound)
	}
	if e.Message != "用户不存在" {
		t.Errorf("message = %q, want 用户不存在", e.Message)
	}
	if e.Unwrap() != nil {
		t.Errorf("unwrap = %v, want nil for no cause", e.Unwrap())
	}
}

func TestNewError_WithCause(t *testing.T) {
	t.Parallel()

	root := errors.New("connection refused")
	e := NewError(http.StatusServiceUnavailable, CodeServerError, "database unreachable", WithCause(root))

	if e.Unwrap() != root {
		t.Errorf("unwrap = %v, want %v", e.Unwrap(), root)
	}
	if !errors.Is(e, root) {
		t.Errorf("errors.Is(e, root) = false; want true")
	}
}

func TestWrapError(t *testing.T) {
	t.Parallel()

	root := errors.New("pgx: connection refused")
	e := WrapError(root, http.StatusInternalServerError, CodeServerError, "query failed")

	if e.Unwrap() != root {
		t.Errorf("unwrap = %v, want %v", e.Unwrap(), root)
	}
	if e.Status != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500", e.Status)
	}
	if e.Code != CodeServerError {
		t.Errorf("code = %q, want SERVER_ERROR", e.Code)
	}
}

func TestError_FormatString(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		e    *APIError
		want string
	}{
		{
			name: "with message",
			e:    NewError(404, CodeNotFound, "用户不存在"),
			want: "NOT_FOUND: 用户不存在",
		},
		{
			name: "empty message",
			e:    NewError(500, CodeServerError, ""),
			want: "SERVER_ERROR: ",
		},
		{
			name: "nil receiver",
			e:    nil,
			want: "<nil APIError>",
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := tc.e.Error()
			if got != tc.want {
				t.Errorf("Error() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestIsAPIError(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		err  error
		want bool
	}{
		{
			name: "direct APIError",
			err:  NewError(404, CodeNotFound, "x"),
			want: true,
		},
		{
			name: "wrapped APIError",
			err:  fmt.Errorf("outer: %w", NewError(500, CodeServerError, "y")),
			want: true,
		},
		{
			name: "plain error",
			err:  errors.New("not an api error"),
			want: false,
		},
		{
			name: "nil",
			err:  nil,
			want: false,
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			apiErr, ok := IsAPIError(tc.err)
			if ok != tc.want {
				t.Errorf("IsAPIError ok = %v, want %v", ok, tc.want)
			}
			if tc.want && apiErr == nil {
				t.Errorf("IsAPIError returned nil APIError with ok=true")
			}
		})
	}
}

func TestStatusOrDefault(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		in   int
		want int
	}{
		{"valid 200", 200, 200},
		{"valid 404", 404, 404},
		{"valid 500", 500, 500},
		{"valid 599", 599, 599},
		{"too low 0", 0, 500},
		{"too low 99", 99, 500},
		{"too high 600", 600, 500},
		{"negative", -1, 500},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			e := &APIError{Status: tc.in, Code: CodeServerError, Message: "x"}
			got := e.statusOrDefault()
			if got != tc.want {
				t.Errorf("statusOrDefault(%d) = %d, want %d", tc.in, got, tc.want)
			}
		})
	}
}

func TestAPIError_NilReceiver(t *testing.T) {
	t.Parallel()

	// Defensive: nil *APIError should not panic when callers do
	// `var e *APIError; e.Unwrap()` after a failed type assertion.
	var e *APIError
	if got := e.Unwrap(); got != nil {
		t.Errorf("nil.Unwrap() = %v, want nil", got)
	}
}

func TestErrorsIsThroughChain(t *testing.T) {
	t.Parallel()

	// Sentinel error pattern: handler tests should be able to assert
	// errors.Is on a known sentinel even through an APIError wrap.
	sentinel := errors.New("table not found")
	wrapped := NewError(500, CodeServerError, "query failed", WithCause(sentinel))

	if !errors.Is(wrapped, sentinel) {
		t.Errorf("errors.Is through APIError chain failed")
	}
}
