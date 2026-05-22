//go:build byteparity

// Package byteparity — golden-file byte parity test harness for the
// 9 /api/anime/* endpoints.  Builds with the `byteparity` tag so the
// default test runs (CI + `go test ./...`) skip this suite; it's
// run explicitly via `make byteparity` or `go test -tags=byteparity ./test/byteparity/...`.
//
// Fixture format (testdata/<name>.json):
//
//	{
//	  "name": "completed-gems-default",
//	  "method": "GET",
//	  "path": "/api/anime/completed-gems?limit=2",
//	  "expected_status": 200,
//	  "expected_body_path": "completed-gems-default.body",
//	  "captured_from": "go-api@stage=P2.1.9",
//	  "captured_at": "2026-05-22T...",
//	  "notes": "optional context"
//	}
//
// The body itself lives in a sibling .body file (raw bytes — no JSON
// wrapper so trailing newlines / escape are preserved byte-exact).
// .body files MAY contain UTF-8 text that's also valid JSON, but the
// harness reads them as opaque bytes.
//
// Fixture lifecycle:
//
//  1. Capture: run the server, curl an endpoint, save the raw body
//     to <name>.body and write the metadata to <name>.json.  See
//     testdata/README.md for the recipe.
//  2. Verify: `make byteparity` walks every <name>.json under
//     testdata/, spins up the Go server (or hits a running one —
//     see RunMode), curls the path, and asserts the body matches
//     <name>.body byte-for-byte.
//  3. Express parity (future P8.5): re-capture <name>.body from
//     Express prod responses.  Same harness now gates Go's parity.
package byteparity

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Fixture is the on-disk metadata for one byte-parity case.
type Fixture struct {
	Name             string `json:"name"`
	Method           string `json:"method"`
	Path             string `json:"path"`
	ExpectedStatus   int    `json:"expected_status"`
	ExpectedBodyPath string `json:"expected_body_path"` // relative to fixture's directory
	CapturedFrom     string `json:"captured_from"`
	CapturedAt       string `json:"captured_at"`
	Notes            string `json:"notes,omitempty"`
}

// LoadAll walks dir and returns one Fixture per .json file (excluding
// .body and README.md).  Errors on malformed JSON.
func LoadAll(dir string) ([]Fixture, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("byteparity: read fixture dir %q: %w", dir, err)
	}

	var fixtures []Fixture
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if !strings.HasSuffix(name, ".json") {
			continue
		}
		// Skip non-fixture json files if any (e.g. package.json hypothetically).
		// .body and README.md are already excluded by the suffix check.
		full := filepath.Join(dir, name)
		raw, err := os.ReadFile(full)
		if err != nil {
			return nil, fmt.Errorf("byteparity: read fixture %q: %w", full, err)
		}
		var f Fixture
		dec := json.NewDecoder(strings.NewReader(string(raw)))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&f); err != nil {
			return nil, fmt.Errorf("byteparity: decode fixture %q: %w", full, err)
		}
		if f.Name == "" {
			return nil, fmt.Errorf("byteparity: fixture %q missing 'name'", full)
		}
		if f.Method == "" {
			f.Method = http.MethodGet
		}
		if f.Path == "" {
			return nil, fmt.Errorf("byteparity: fixture %q missing 'path'", full)
		}
		if f.ExpectedBodyPath == "" {
			return nil, fmt.Errorf("byteparity: fixture %q missing 'expected_body_path'", full)
		}
		fixtures = append(fixtures, f)
	}

	// Deterministic ordering by Name for stable test output.
	sort.Slice(fixtures, func(i, j int) bool {
		return fixtures[i].Name < fixtures[j].Name
	})

	return fixtures, nil
}

// LoadBody reads the sibling .body file for a fixture.  Returns
// the raw bytes — no transformation.
func LoadBody(fixtureDir string, f Fixture) ([]byte, error) {
	bodyPath := filepath.Join(fixtureDir, f.ExpectedBodyPath)
	b, err := os.ReadFile(bodyPath)
	if err != nil {
		return nil, fmt.Errorf("byteparity: read body %q for fixture %q: %w", bodyPath, f.Name, err)
	}
	return b, nil
}

// FetchActual hits the configured baseURL + fixture.Path and returns
// the response body bytes + HTTP status.  Uses a default 30s timeout.
// No content negotiation — accepts whatever the server sends and
// returns it verbatim.
func FetchActual(ctx context.Context, baseURL string, f Fixture) ([]byte, int, error) {
	method := f.Method
	if method == "" {
		method = http.MethodGet
	}
	url := strings.TrimRight(baseURL, "/") + f.Path

	req, err := http.NewRequestWithContext(ctx, method, url, nil)
	if err != nil {
		return nil, 0, fmt.Errorf("byteparity: build request for %s %s: %w", method, url, err)
	}

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, 0, fmt.Errorf("byteparity: do request %s %s: %w", method, url, err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, resp.StatusCode, fmt.Errorf("byteparity: read response body for %s %s: %w", method, url, err)
	}
	return body, resp.StatusCode, nil
}

// CompareBytes returns a multi-line diff between expected and actual
// suitable for t.Errorf output.  Uses a simple line-by-line diff that
// quotes non-printable bytes — for an envelope-level test, the diff
// rarely exceeds a few lines.  For full divergence, falls back to
// "bytes differ: N expected vs M actual, first diff at offset K".
func CompareBytes(expected, actual []byte) (string, bool) {
	if equalBytes(expected, actual) {
		return "", true
	}

	// Find first differing byte offset for fallback summary.
	firstDiff := -1
	minLen := len(expected)
	if len(actual) < minLen {
		minLen = len(actual)
	}
	for i := 0; i < minLen; i++ {
		if expected[i] != actual[i] {
			firstDiff = i
			break
		}
	}
	if firstDiff == -1 {
		// One is a prefix of the other.
		firstDiff = minLen
	}

	var b strings.Builder
	fmt.Fprintf(&b, "bytes differ: %d expected vs %d actual, first diff at offset %d\n",
		len(expected), len(actual), firstDiff)

	// Show a context window around the first diff (±64 bytes).
	winStart := firstDiff - 64
	if winStart < 0 {
		winStart = 0
	}
	winEndExp := firstDiff + 64
	if winEndExp > len(expected) {
		winEndExp = len(expected)
	}
	winEndAct := firstDiff + 64
	if winEndAct > len(actual) {
		winEndAct = len(actual)
	}
	fmt.Fprintf(&b, "expected[%d:%d] = %q\n", winStart, winEndExp, expected[winStart:winEndExp])
	fmt.Fprintf(&b, "actual  [%d:%d] = %q\n", winStart, winEndAct, actual[winStart:winEndAct])

	// Best-effort line-by-line diff when both look like text.
	expLines := strings.Split(string(expected), "\n")
	actLines := strings.Split(string(actual), "\n")
	if len(expLines) < 200 && len(actLines) < 200 {
		b.WriteString("--- line-by-line ---\n")
		maxLines := len(expLines)
		if len(actLines) > maxLines {
			maxLines = len(actLines)
		}
		for i := 0; i < maxLines; i++ {
			var el, al string
			if i < len(expLines) {
				el = expLines[i]
			}
			if i < len(actLines) {
				al = actLines[i]
			}
			if el == al {
				continue
			}
			fmt.Fprintf(&b, "line %d:\n  - exp: %q\n  + act: %q\n", i+1, el, al)
		}
	}

	return b.String(), false
}

// equalBytes — explicit byte equality to keep the dependency surface
// minimal (no `bytes` import needed for anything else, but bytes.Equal
// is the canonical answer; we inline it here for clarity).
func equalBytes(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// DefaultBaseURL is os.Getenv("BYTEPARITY_BASE_URL") with fallback
// to http://localhost:8080.  Tests can override per-case.
func DefaultBaseURL() string {
	if v := os.Getenv("BYTEPARITY_BASE_URL"); v != "" {
		return v
	}
	return "http://localhost:8080"
}
