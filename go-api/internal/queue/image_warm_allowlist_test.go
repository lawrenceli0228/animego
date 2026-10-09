package queue

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestImageWarmAllowlist_MatchesNginx holds the job's copy of the allowlist
// to nginx's, in the config file production runs.  The job only sends paths
// its own copy accepts, and the warm server answers 403 for any path its copy
// refuses.  A copy here wider than nginx's makes every pass that reaches such
// a path stop on 403s; a narrower one leaves a kind of image unstored, with
// no error anywhere.  The next-app copy is held to the same file by
// next-app/src/lib/images/nginxAllowlist.test.ts.
func TestImageWarmAllowlist_MatchesNginx(t *testing.T) {
	t.Parallel()

	conf, err := os.ReadFile(filepath.Join("..", "..", "..", "nginx", "default.p9.conf"))
	require.NoError(t, err)

	locations := regexp.MustCompile(`location ~ "\^/(img/anilist|warm)/\(\?<anilist_path>(.+)\)\$" \{`).
		FindAllStringSubmatch(string(conf), -1)
	require.Len(t, locations, 2, "nginx has the public and the warm mirror locations")

	want := strings.TrimSuffix(strings.TrimPrefix(imageWarmAllowlist.String(), "^"), "$")
	for _, m := range locations {
		assert.Equal(t, want, m[2], "the allowlist in nginx's /%s/ location", m[1])
	}
}
