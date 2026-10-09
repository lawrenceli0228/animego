//go:build linux || darwin

package queue

import (
	"fmt"
	"syscall"
)

// hostFreeBytes reports the space an unprivileged writer can still use on
// the file system that holds path: the blocks statfs calls available, not
// the free ones the root reserve is part of.
func hostFreeBytes(path string) (uint64, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, fmt.Errorf("statfs %s: %w", path, err)
	}
	return uint64(st.Bavail) * uint64(st.Bsize), nil
}
