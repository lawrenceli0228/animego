// Package main is a one-shot CLI tool that builds the vendored map from
// AniList ids and Bangumi subject ids to Mikan Project bangumi ids, out of
// bangumi-data's dist/data.json (https://github.com/bangumi-data/bangumi-data,
// CC BY 4.0).  The magnet search uses it to read a show's per-bangumi Mikan
// feed instead of searching Mikan by title.
//
// Usage:
//
//	go run ./cmd/mikanmap \
//	  --version  latest \
//	  --registry https://registry.npmjs.org/bangumi-data \
//	  --data     'https://raw.githubusercontent.com/bangumi-data/bangumi-data/v{version}/dist/data.json' \
//	  --out      internal/mikanidmap/mikan_map.json \
//	  --report   /tmp/mikanmap-report.md
//
// "latest" asks the npm registry for the newest bangumi-data release, which
// is then downloaded from that release's git tag, so the release recorded in
// the output is the one the map was built from.  The report is the refresh
// PR's body: the conflicts the build left out and what changed against the
// map already at --out.
package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// versionPlaceholder in --data is replaced by the resolved release.
const versionPlaceholder = "{version}"

// versionRE accepts a plain release number.  It goes into a URL and into the
// generated file, so nothing else is let through.
var versionRE = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+$`)

type options struct {
	version, registry, data, out, report string
}

func main() {
	var o options
	flag.StringVar(&o.version, "version", "latest",
		`bangumi-data release to build from, e.g. 0.3.231, or "latest" to ask the npm registry`)
	flag.StringVar(&o.registry, "registry", "https://registry.npmjs.org/bangumi-data",
		`npm registry document for bangumi-data; resolves --version latest`)
	flag.StringVar(&o.data, "data",
		"https://raw.githubusercontent.com/bangumi-data/bangumi-data/v"+versionPlaceholder+"/dist/data.json",
		`HTTP(S) URL or local path of bangumi-data's dist/data.json; "`+versionPlaceholder+`" becomes the release`)
	flag.StringVar(&o.out, "out", "internal/mikanidmap/mikan_map.json",
		"Output file path for the map")
	flag.StringVar(&o.report, "report", "",
		"If set, write a markdown review report (the refresh PR body) here")
	flag.Parse()

	if err := run(o); err != nil {
		fmt.Fprintf(os.Stderr, "ERROR: %v\n", err)
		os.Exit(1)
	}
}

func run(o options) error {
	version, err := resolveVersion(o)
	if err != nil {
		return err
	}
	src := strings.ReplaceAll(o.data, versionPlaceholder, version)
	fmt.Fprintf(os.Stderr, "Loading bangumi-data %s from %s…\n", version, src)
	raw, err := load(src)
	if err != nil {
		return fmt.Errorf("loading bangumi-data: %w", err)
	}
	var data Data
	if err := json.Unmarshal(raw, &data); err != nil {
		return fmt.Errorf("decoding bangumi-data: %w", err)
	}
	if len(data.Items) == 0 {
		return errors.New("bangumi-data has no items; refusing to write an empty map")
	}

	prev, err := readPrevious(o.out)
	if err != nil {
		return err
	}
	res := BuildMap(data.Items)
	next := Map{Version: version, Anilist: res.Anilist, Bgm: res.Bgm, AnilistConflicts: res.AnilistConflicts()}
	if err := writeFile(o.out, Render(next)); err != nil {
		return err
	}
	if o.report != "" {
		report := RenderReport(ReportInput{
			Prev: prev, Next: next, Conflicts: res.Conflicts,
			Pages: PageIndex(data.Items), Stats: res.Stats,
		})
		if err := writeFile(o.report, []byte(report)); err != nil {
			return err
		}
	}

	printSummary(os.Stderr, version, res)
	return nil
}

// resolveVersion returns the release to build from: --version as given, or
// the npm registry's latest.  A --data without the placeholder is a fixed
// file whose release the registry cannot vouch for, so it needs --version.
func resolveVersion(o options) (string, error) {
	if o.version != "latest" {
		if !versionRE.MatchString(o.version) {
			return "", fmt.Errorf("--version %q is not a release number like 0.3.231", o.version)
		}
		return o.version, nil
	}
	if !strings.Contains(o.data, versionPlaceholder) {
		return "", fmt.Errorf("--data %s names one fixed file; pass the release it holds with --version", o.data)
	}
	raw, err := load(strings.TrimRight(o.registry, "/") + "/latest")
	if err != nil {
		return "", fmt.Errorf("asking the registry for the latest release: %w", err)
	}
	var latest struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(raw, &latest); err != nil {
		return "", fmt.Errorf("decoding the registry's latest release: %w", err)
	}
	if !versionRE.MatchString(latest.Version) {
		return "", fmt.Errorf("the registry's latest release %q is not a release number", latest.Version)
	}
	return latest.Version, nil
}

// readPrevious reads the map a previous run left at path, so the report can
// say what this run changes.  A missing file is a first run, not an error.
func readPrevious(path string) (Map, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return Map{}, nil
	}
	if err != nil {
		return Map{}, fmt.Errorf("reading previous %s: %w", path, err)
	}
	m, err := ParseMap(data)
	if err != nil {
		return Map{}, fmt.Errorf("previous %s: %w", path, err)
	}
	return m, nil
}

// writeFile writes data to path, creating the directory if needed.
func writeFile(path string, data []byte) error {
	if dir := filepath.Dir(path); dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return fmt.Errorf("creating %s: %w", dir, err)
		}
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		return fmt.Errorf("writing %s: %w", path, err)
	}
	return nil
}

// load fetches src over HTTP(S), or reads it as a local file.
func load(src string) ([]byte, error) {
	if !strings.HasPrefix(src, "http://") && !strings.HasPrefix(src, "https://") {
		return os.ReadFile(src)
	}
	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Get(src)
	if err != nil {
		return nil, fmt.Errorf("GET %s: %w", src, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET %s: HTTP %d", src, resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("GET %s: reading body: %w", src, err)
	}
	return body, nil
}

func printSummary(w io.Writer, version string, res Result) {
	conflicts := map[Key]int{}
	for _, c := range res.Conflicts {
		conflicts[c.Key]++
	}
	fmt.Fprintf(w, "Done.\n  bangumi-data release : %s\n  items                : %d\n  items linking Mikan  : %d (%d without an AniList link)\n  anilist keys         : %d\n  bgm keys             : %d\n  conflicts (left out) : anilist %d, bgm %d\n  non-numeric ids      : %d\n",
		version, res.Stats.Items, res.Stats.WithMikan, res.Stats.NoAnilist,
		len(res.Anilist), len(res.Bgm), conflicts[KeyAnilist], conflicts[KeyBgm], res.Stats.BadIDs)
	for _, c := range res.Conflicts {
		fmt.Fprintf(w, "  conflict: %s %d -> mikan %v\n", c.Key, c.ID, c.Mikan)
	}
}
