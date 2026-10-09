//go:build linux || darwin

package queue

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestHostFreeBytes reads the real file system: a figure for a path that
// exists, and an error -- not a zero that would read as a full disk -- for
// one that does not.
func TestHostFreeBytes(t *testing.T) {
	t.Parallel()

	free, err := hostFreeBytes(t.TempDir())
	require.NoError(t, err)
	assert.Positive(t, free)

	_, err = hostFreeBytes("/no/such/path/for/image-warm")
	assert.Error(t, err)
}
