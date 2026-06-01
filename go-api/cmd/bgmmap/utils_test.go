package main

// utils_test.go — unit tests for the pure helper functions:
//   - mustInt   (string→int, handles blank, error, valid)
//   - dirOf     (path string → directory component)
//   - load      (local file path AND HTTP variants)

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// ─── mustInt ─────────────────────────────────────────────────────────────────

func TestMustInt(t *testing.T) {
	t.Parallel()

	cases := []struct {
		in   string
		want int
	}{
		{"0", 0},
		{"1", 1},
		{"12345", 12345},
		{"999999", 999999},
		{"", 0},          // blank → 0
		{"abc", 0},       // non-numeric → 0
		{"-1", -1},       // negative handled by strconv.Atoi
		{"3.14", 0},      // float string → 0 (not parseable as int)
		{"  42  ", 0},    // spaces → 0 (strconv.Atoi doesn't trim)
		{"2147483647", 2147483647}, // max int32 value
	}

	for _, tc := range cases {
		tc := tc
		t.Run("input_"+tc.in, func(t *testing.T) {
			t.Parallel()
			got := mustInt(tc.in)
			if got != tc.want {
				t.Errorf("mustInt(%q) = %d, want %d", tc.in, got, tc.want)
			}
		})
	}
}

// ─── dirOf ───────────────────────────────────────────────────────────────────

func TestDirOf(t *testing.T) {
	t.Parallel()

	cases := []struct {
		path string
		want string
	}{
		{"internal/bgmidmap/anilist_bgm_map.json", "internal/bgmidmap"},
		{"out.json", ""},
		{"a/b/c/d.json", "a/b/c"},
		{"/absolute/path/file.json", "/absolute/path"},
		{"", ""},
		{"nodircomponent", ""},
		{"a/", "a"},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.path, func(t *testing.T) {
			t.Parallel()
			got := dirOf(tc.path)
			if got != tc.want {
				t.Errorf("dirOf(%q) = %q, want %q", tc.path, got, tc.want)
			}
		})
	}
}

// ─── load (local file path) ───────────────────────────────────────────────────

func TestLoad_LocalFile_Success(t *testing.T) {
	t.Parallel()
	tmp := filepath.Join(t.TempDir(), "data.json")
	content := []byte(`[{"anilist_id":1}]`)
	if err := os.WriteFile(tmp, content, 0o644); err != nil {
		t.Fatalf("write temp file: %v", err)
	}

	got, err := load(tmp)
	if err != nil {
		t.Fatalf("load(%q) returned error: %v", tmp, err)
	}
	if string(got) != string(content) {
		t.Errorf("load() = %q, want %q", got, content)
	}
}

func TestLoad_LocalFile_NotFound(t *testing.T) {
	t.Parallel()
	_, err := load("/tmp/does-not-exist-bgmmap-test.json")
	if err == nil {
		t.Error("expected error for missing file, got nil")
	}
}

func TestLoad_LocalFile_EmptyFile(t *testing.T) {
	t.Parallel()
	tmp := filepath.Join(t.TempDir(), "empty.json")
	if err := os.WriteFile(tmp, []byte{}, 0o644); err != nil {
		t.Fatalf("write empty file: %v", err)
	}

	got, err := load(tmp)
	if err != nil {
		t.Fatalf("load empty file returned error: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("load empty file: len = %d, want 0", len(got))
	}
}

// ─── load (HTTP path) ─────────────────────────────────────────────────────────

func TestLoad_HTTP_Success(t *testing.T) {
	t.Parallel()
	body := `[{"anilist_id":42}]`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)

	got, err := load(srv.URL + "/data.json")
	if err != nil {
		t.Fatalf("load HTTP returned error: %v", err)
	}
	if string(got) != body {
		t.Errorf("load HTTP = %q, want %q", got, body)
	}
}

func TestLoad_HTTP_NonOKStatus_ReturnsError(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	t.Cleanup(srv.Close)

	_, err := load(srv.URL + "/data.json")
	if err == nil {
		t.Error("expected error for HTTP 404, got nil")
	}
}
