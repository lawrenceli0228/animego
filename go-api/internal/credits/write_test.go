package credits

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestModeFor(t *testing.T) {
	assert.Equal(t, WholeList, ModeFor(false, true), "a last first page is the whole list")
	assert.Equal(t, FirstPage, ModeFor(true, true))
	assert.Equal(t, FirstPage, ModeFor(false, false), "not knowing must not delete")
}
