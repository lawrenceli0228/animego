package hant

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// NewResolverFromDir is the first thing both entry points do, and its
// failure is the one an operator hits most: the default is a relative
// path, so running from anywhere but go-api/ finds nothing.  Whichever
// file is missing has to be named, or the message is just "no such file".
func TestNewResolverFromDirNamesTheMissingFile(t *testing.T) {
	// Each case supplies the files listed and expects the loader to stop
	// on the first one it still cannot find, in ladder order.
	cases := []struct {
		name    string
		present []string
		wantIn  string
	}{
		{"nothing at all", nil, openccFile},
		{"conversion table only", []string{openccFile}, anilistFile},
		{"missing the Hong Kong overlay", []string{openccFile, anilistFile}, cgroupFile},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			for _, name := range tc.present {
				blob, err := os.ReadFile(filepath.Join(dataDir(t), name))
				if err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(dir, name), blob, 0o644); err != nil {
					t.Fatal(err)
				}
			}

			_, err := NewResolverFromDir(dir)
			if err == nil {
				t.Fatalf("loaded a Resolver from a directory holding only %v", tc.present)
			}
			if !strings.Contains(err.Error(), tc.wantIn) {
				t.Errorf("error %q does not name the missing %s", err, tc.wantIn)
			}
		})
	}
}

// Prevents: an env var set to the empty string being read as "the
// current directory".
//
// A compose file with `HANT_DATA_DIR:` and nothing after it, or an
// entrypoint that exports the variable before computing it, both produce
// "" — and os.Getenv cannot tell that apart from unset.  Resolving it to
// "" would make filepath.Join produce bare filenames, so the worker would
// look for the datasets in whatever directory the container started in
// and report a missing file instead of a missing setting.
func TestDataDirFromEnv(t *testing.T) {
	cases := []struct {
		name string
		set  bool
		env  string
		want string
	}{
		{name: "unset falls back to the checkout path", want: DefaultDataDir},
		{name: "empty is treated as unset", set: true, env: "", want: DefaultDataDir},
		{name: "the image path wins when set", set: true, env: "/usr/local/share/animego/hant", want: "/usr/local/share/animego/hant"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if tc.set {
				t.Setenv(DataDirEnv, tc.env)
			} else {
				// t.Setenv restores on cleanup, so clearing here is safe
				// even when the developer's shell has the variable set.
				t.Setenv(DataDirEnv, "")
				os.Unsetenv(DataDirEnv)
			}
			if got := DataDirFromEnv(); got != tc.want {
				t.Errorf("DataDirFromEnv() = %q, want %q", got, tc.want)
			}
		})
	}
}

// The vendored directory has to satisfy the loader it ships for.  A file
// renamed upstream, or a dataset regenerated into a shape the parser no
// longer accepts, is otherwise only discovered by the first production
// run after a deploy.
func TestVendoredDirectoryLoads(t *testing.T) {
	r, err := NewResolverFromDir(dataDir(t))
	if err != nil {
		t.Fatalf("NewResolverFromDir(%s): %v", dataDir(t), err)
	}
	stats := r.LoadStats()
	if stats.AnilistRecords < 8000 {
		t.Errorf("AnilistRecords = %d, want the full dataset (~8,492) — a truncated file still parses and silently demotes thousands of rows to opencc", stats.AnilistRecords)
	}
	if stats.CgroupKeys == 0 {
		t.Error("CgroupKeys = 0, so the Hong Kong overlay would never win a row")
	}
	if stats.SimplifiedRunes == 0 {
		t.Error("SimplifiedRunes = 0, so the Simplified gate would accept everything")
	}
}
