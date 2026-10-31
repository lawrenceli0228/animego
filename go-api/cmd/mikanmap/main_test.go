package main

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
)

// upstream serves the npm registry's latest-release document and the
// fixture as the release's dist/data.json, the two things a default run
// downloads.  It counts registry hits.
func upstream(t *testing.T, latest string) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	data, err := os.ReadFile("testdata/data.json")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var registryHits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/bangumi-data/latest":
			registryHits.Add(1)
			_, _ = w.Write([]byte(`{"name":"bangumi-data","version":"` + latest + `","license":"CC-BY-4.0"}`))
		case "/v0.3.231/dist/data.json":
			_, _ = w.Write(data)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv, &registryHits
}

func runOptions(srv *httptest.Server, dir string) options {
	return options{
		version:  "latest",
		registry: srv.URL + "/bangumi-data",
		data:     srv.URL + "/v" + versionPlaceholder + "/dist/data.json",
		out:      filepath.Join(dir, "internal", "mikan_map.json"),
		report:   filepath.Join(dir, "report.md"),
	}
}

// A default run asks the registry for the latest release, downloads that
// release's file, and writes the map, recording the release.  A second run
// over the same input writes the same bytes.
func TestRun_LatestReleaseEndToEnd(t *testing.T) {
	srv, _ := upstream(t, "0.3.231")
	o := runOptions(srv, t.TempDir())

	if err := run(o); err != nil {
		t.Fatalf("run: %v", err)
	}
	first, err := os.ReadFile(o.out)
	if err != nil {
		t.Fatalf("read output: %v", err)
	}
	m, err := ParseMap(first)
	if err != nil {
		t.Fatalf("output does not parse: %v", err)
	}
	if m.Version != "0.3.231" || m.Anilist[154587] != 3141 || m.Bgm[999001] != 4001 {
		t.Errorf("unexpected map: %+v", m)
	}
	// The AniList conflict is written down, so the lookup can refuse it;
	// the Bangumi conflict is not needed there.
	if want := map[int][]int{21: {228, 3977}}; !reflect.DeepEqual(m.AnilistConflicts, want) {
		t.Errorf("anilistConflicts: want %v, got %v", want, m.AnilistConflicts)
	}

	report, err := os.ReadFile(o.report)
	if err != nil {
		t.Fatalf("read report: %v", err)
	}
	if !strings.Contains(string(report), "### Conflicts: AniList ids read from every page, Bangumi ids left out (2)") {
		t.Errorf("report should list the fixture's two conflicts:\n%s", report)
	}

	if err := run(o); err != nil {
		t.Fatalf("second run: %v", err)
	}
	second, _ := os.ReadFile(o.out)
	if !bytes.Equal(first, second) {
		t.Error("the same input produced different output")
	}
}

func TestRun_PinnedVersionSkipsTheRegistry(t *testing.T) {
	srv, registryHits := upstream(t, "9.9.9")
	o := runOptions(srv, t.TempDir())
	o.version = "0.3.231"

	if err := run(o); err != nil {
		t.Fatalf("run: %v", err)
	}
	if n := registryHits.Load(); n != 0 {
		t.Errorf("a pinned --version must not ask the registry, asked %d times", n)
	}
}

func TestRun_RefusesBadVersions(t *testing.T) {
	srv, _ := upstream(t, "../../etc")
	cases := map[string]func(*options){
		"registry answers junk": func(*options) {},
		"pinned junk":           func(o *options) { o.version = "v1" },
		// A fixed file's release cannot be looked up, so it must be given.
		"fixed file, no version": func(o *options) { o.data = "testdata/data.json" },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			o := runOptions(srv, t.TempDir())
			mutate(&o)
			if err := run(o); err == nil {
				t.Fatal("want an error")
			}
			if _, err := os.Stat(o.out); err == nil {
				t.Error("no map may be written when the release is unknown")
			}
		})
	}
}

// A local file plus an explicit release is the offline path.
func TestRun_LocalFileWithVersion(t *testing.T) {
	dir := t.TempDir()
	o := options{version: "0.3.231", data: "testdata/data.json", out: filepath.Join(dir, "map.json")}
	if err := run(o); err != nil {
		t.Fatalf("run: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "report.md")); err == nil {
		t.Error("no report was asked for")
	}
}

func TestRun_RefusesAnEmptyDataset(t *testing.T) {
	dir := t.TempDir()
	empty := filepath.Join(dir, "empty.json")
	if err := os.WriteFile(empty, []byte(`{"siteMeta":{},"items":[]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	o := options{version: "0.3.231", data: empty, out: filepath.Join(dir, "map.json")}
	if err := run(o); err == nil {
		t.Fatal("an empty dataset must not overwrite the map")
	}
}

func TestLoad_HTTPErrorStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	t.Cleanup(srv.Close)
	if _, err := load(srv.URL + "/missing.json"); err == nil {
		t.Error("want an error for HTTP 404")
	}
}
