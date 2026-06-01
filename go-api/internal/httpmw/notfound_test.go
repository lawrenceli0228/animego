package httpmw

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestNotFound_StatusAndBody(t *testing.T) {
	t.Parallel()

	req := httptest.NewRequest(http.MethodGet, "/api/nonexistent/endpoint", nil)
	rec := httptest.NewRecorder()
	NotFound(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", rec.Code)
	}

	var envelope struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("body is not valid JSON: %v\nbody: %s", err, rec.Body.String())
	}
	if envelope.Error.Code != "NOT_FOUND" {
		t.Errorf("code = %q, want NOT_FOUND", envelope.Error.Code)
	}
	if envelope.Error.Message != "Route not found" {
		t.Errorf("message = %q, want \"Route not found\"", envelope.Error.Message)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json; charset=utf-8" {
		t.Errorf("Content-Type = %q, want application/json; charset=utf-8", ct)
	}
}

func TestMethodNotAllowed_StatusAndBody(t *testing.T) {
	t.Parallel()

	req := httptest.NewRequest(http.MethodDelete, "/api/anime/1", nil)
	rec := httptest.NewRecorder()
	MethodNotAllowed(rec, req)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("status = %d, want 405", rec.Code)
	}

	var envelope struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("body is not valid JSON: %v\nbody: %s", err, rec.Body.String())
	}
	// MethodNotAllowed uses CodeNotFound ("NOT_FOUND") for Express compat.
	if envelope.Error.Code != "NOT_FOUND" {
		t.Errorf("code = %q, want NOT_FOUND", envelope.Error.Code)
	}
	if envelope.Error.Message != "Route not found" {
		t.Errorf("message = %q, want \"Route not found\"", envelope.Error.Message)
	}
}
