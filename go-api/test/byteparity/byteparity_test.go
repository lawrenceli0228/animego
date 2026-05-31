//go:build byteparity

package byteparity

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestByteParity is a table-driven test where each .json fixture in
// testdata/ becomes one subtest.  The server is assumed to be running
// at BYTEPARITY_BASE_URL (default http://localhost:8080) — the harness
// does NOT spin it up.  Boot it externally via `go run ./cmd/server`
// or docker compose.
//
// Each subtest:
//  1. Loads the fixture metadata + .body
//  2. GETs the path against baseURL
//  3. Asserts status code matches
//  4. Asserts response body == .body byte-for-byte
//
// Use `make byteparity` which boots postgres + go-api + then runs
// this test, OR boot manually and `go test -tags=byteparity ./test/byteparity/...`.
func TestByteParity(t *testing.T) {
	dir := "testdata"
	fixtures, err := LoadAll(dir)
	require.NoError(t, err)
	require.NotEmpty(t, fixtures, "no fixtures found — add at least one to testdata/")

	baseURL := DefaultBaseURL()
	t.Logf("byteparity: baseURL=%s, fixtures=%d", baseURL, len(fixtures))

	for _, f := range fixtures {
		f := f
		t.Run(f.Name, func(t *testing.T) {
			t.Parallel()

			expected, err := LoadBody(dir, f)
			require.NoError(t, err)

			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()

			actual, status, err := FetchActual(ctx, baseURL, f)
			require.NoError(t, err)
			assert.Equal(t, f.ExpectedStatus, status, "status mismatch for %s", f.Path)

			diff, equal := CompareBytes(expected, actual)
			if !equal {
				t.Errorf("byte mismatch for %s (%s):\n%s", f.Name, f.Path, diff)
			}
		})
	}
}
