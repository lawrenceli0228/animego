//go:build !linux && !darwin

package queue

import "errors"

// hostFreeBytes has no statfs to call on this platform.  The disk guard
// then skips every pass, which is the safe way round.
func hostFreeBytes(string) (uint64, error) {
	return 0, errors.New("free disk space is not measured on this platform")
}
