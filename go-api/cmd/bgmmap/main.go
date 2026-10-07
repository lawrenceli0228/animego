// Package main is a one-shot CLI tool that builds an AniList→Bangumi id map by
// joining two community cross-reference datasets on MAL and AniDB ids, plus an
// AniList→AniDB map straight from Fribb.
//
// Usage:
//
//	go run ./cmd/bgmmap \
//	  --fribb     https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json \
//	  --bel       https://raw.githubusercontent.com/Rhilip/BangumiExtLinker/main/data/anime_map.json \
//	  --out       internal/bgmidmap/anilist_bgm_map.json \
//	  --anidb-out internal/bgmidmap/anilist_anidb_map.json \
//	  --overrides cmd/bgmmap/overrides.json \
//	  --report    /tmp/bgmmap-report.md
//
// The report is the refresh PR's body: what changed against the map already
// at --out, which ids the join refused and why, and what overrides.json holds.
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
	"strings"
	"time"
)

type options struct {
	fribb, bel, out, anidbOut, overrides, report string
}

func main() {
	var o options
	flag.StringVar(&o.fribb, "fribb",
		"https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json",
		"HTTP(S) URL or local file path for Fribb/anime-lists full JSON")
	flag.StringVar(&o.bel, "bel",
		"https://raw.githubusercontent.com/Rhilip/BangumiExtLinker/main/data/anime_map.json",
		"HTTP(S) URL or local file path for Rhilip/BangumiExtLinker anime_map.json")
	flag.StringVar(&o.out, "out", "internal/bgmidmap/anilist_bgm_map.json",
		"Output file path for the AniList→Bangumi map")
	flag.StringVar(&o.anidbOut, "anidb-out", "internal/bgmidmap/anilist_anidb_map.json",
		"Output file path for the AniList→AniDB map")
	flag.StringVar(&o.overrides, "overrides", "cmd/bgmmap/overrides.json",
		"Hand-verified AniList→Bangumi pins that outrank the join")
	flag.StringVar(&o.report, "report", "",
		"If set, write a markdown review report (the refresh PR body) here")
	flag.Parse()

	if err := run(o); err != nil {
		fmt.Fprintf(os.Stderr, "ERROR: %v\n", err)
		os.Exit(1)
	}
}

// inputs is everything one run reads before it builds anything.
type inputs struct {
	fribb     []FribbEntry
	bel       []BelEntry
	overrides []Override
	prev      []MapEntry   // the Bangumi map already at --out
	prevAnidb []AnidbEntry // the AniDB map already at --anidb-out
}

func loadInputs(o options) (inputs, error) {
	var in inputs
	if err := loadJSON("fribb source", o.fribb, &in.fribb); err != nil {
		return in, err
	}
	if err := loadJSON("bel source", o.bel, &in.bel); err != nil {
		return in, err
	}
	raw, err := os.ReadFile(o.overrides)
	if err != nil {
		return in, fmt.Errorf("reading overrides: %w", err)
	}
	if in.overrides, err = ParseOverrides(raw); err != nil {
		return in, err
	}
	if err := readPrevious(o.out, &in.prev); err != nil {
		return in, err
	}
	return in, readPrevious(o.anidbOut, &in.prevAnidb)
}

func run(o options) error {
	in, err := loadInputs(o)
	if err != nil {
		return err
	}
	res := BuildMap(in.fribb, in.bel)
	entries, outcomes := ApplyOverrides(res, in.overrides)
	anidb := BuildAnidbMap(in.fribb)

	if err := writeJSON(o.out, entries); err != nil {
		return err
	}
	if err := writeJSON(o.anidbOut, anidb); err != nil {
		return err
	}
	if o.report != "" {
		report := RenderReport(ReportInput{
			Prev: in.prev, Next: entries, Skips: res.Skips, Overrides: outcomes,
			Subjects: SubjectIndex(in.bel), Stats: res.Stats,
			Anidb: DiffAnidb(in.prevAnidb, anidb),
		})
		if err := os.WriteFile(o.report, []byte(report), 0o644); err != nil {
			return fmt.Errorf("writing report: %w", err)
		}
	}

	fmt.Fprintf(os.Stderr, "Done.\n  fribb entries : %d\n  bel entries   : %d\n  mapped        : %d (+%d overrides)\n  refused       : %d\n  anidb pairs   : %d\n",
		res.Stats.FribbCount, res.Stats.BelCount, res.Stats.Mapped, len(in.overrides), res.Stats.Skipped, len(anidb))
	return nil
}

// loadJSON fetches or reads src and decodes it into v.
func loadJSON(what, src string, v any) error {
	fmt.Fprintf(os.Stderr, "Loading %s…\n", what)
	data, err := load(src)
	if err != nil {
		return fmt.Errorf("loading %s: %w", what, err)
	}
	if err := json.Unmarshal(data, v); err != nil {
		return fmt.Errorf("decoding %s: %w", what, err)
	}
	return nil
}

// readPrevious decodes the map a previous run left at path, so the report
// can say what this run changes.  A missing file is a first run, not an error.
func readPrevious(path string, v any) error {
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("reading previous %s: %w", path, err)
	}
	if err := json.Unmarshal(data, v); err != nil {
		return fmt.Errorf("decoding previous %s: %w", path, err)
	}
	return nil
}

// writeJSON writes v as indented JSON, creating the directory if needed.
func writeJSON(path string, v any) error {
	if dir := dirOf(path); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return fmt.Errorf("creating %s: %w", dir, err)
		}
	}
	f, err := os.Create(path)
	if err != nil {
		return fmt.Errorf("creating %s: %w", path, err)
	}
	enc := json.NewEncoder(f)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		f.Close()
		return fmt.Errorf("writing %s: %w", path, err)
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("closing %s: %w", path, err)
	}
	return nil
}

func load(src string) ([]byte, error) {
	if strings.HasPrefix(src, "http://") || strings.HasPrefix(src, "https://") {
		client := &http.Client{Timeout: 120 * time.Second}
		resp, err := client.Get(src)
		if err != nil {
			return nil, fmt.Errorf("GET %s: %w", src, err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("GET %s: HTTP %d", src, resp.StatusCode)
		}
		return io.ReadAll(resp.Body)
	}
	return os.ReadFile(src)
}

// dirOf returns the directory component of a slash-separated path.
func dirOf(p string) string {
	i := strings.LastIndexByte(p, '/')
	if i < 0 {
		return ""
	}
	return p[:i]
}
