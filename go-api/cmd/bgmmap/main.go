// Package main is a one-shot CLI tool that builds an AniList→Bangumi id map by
// joining two community cross-reference datasets on MAL id (AniDB id fallback).
//
// Usage:
//
//	go run ./cmd/bgmmap \
//	  --fribb https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json \
//	  --bel   https://raw.githubusercontent.com/Rhilip/BangumiExtLinker/main/data/anime_map.json \
//	  --out   internal/bgmidmap/anilist_bgm_map.json
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

func main() {
	fribbURL := flag.String("fribb",
		"https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json",
		"HTTP(S) URL or local file path for Fribb/anime-lists full JSON")
	belURL := flag.String("bel",
		"https://raw.githubusercontent.com/Rhilip/BangumiExtLinker/main/data/anime_map.json",
		"HTTP(S) URL or local file path for Rhilip/BangumiExtLinker anime_map.json")
	outPath := flag.String("out", "internal/bgmidmap/anilist_bgm_map.json",
		"Output file path for the generated map")
	flag.Parse()

	// Fetch / read both sources.
	fmt.Fprintln(os.Stderr, "Loading Fribb anime-lists…")
	fribbData, err := load(*fribbURL)
	if err != nil {
		fmt.Fprintf(os.Stderr, "ERROR: loading fribb source: %v\n", err)
		os.Exit(1)
	}

	fmt.Fprintln(os.Stderr, "Loading BangumiExtLinker anime_map…")
	belData, err := load(*belURL)
	if err != nil {
		fmt.Fprintf(os.Stderr, "ERROR: loading bel source: %v\n", err)
		os.Exit(1)
	}

	// Decode.
	var fribb []FribbEntry
	if err := json.Unmarshal(fribbData, &fribb); err != nil {
		fmt.Fprintf(os.Stderr, "ERROR: decoding fribb JSON: %v\n", err)
		os.Exit(1)
	}

	var bel []BelEntry
	if err := json.Unmarshal(belData, &bel); err != nil {
		fmt.Fprintf(os.Stderr, "ERROR: decoding bel JSON: %v\n", err)
		os.Exit(1)
	}

	// Build the join.
	fmt.Fprintln(os.Stderr, "Building map…")
	entries, stats := BuildMap(fribb, bel)

	// Write output.
	outDir := dirOf(*outPath)
	if outDir != "" && outDir != "." {
		if err := os.MkdirAll(outDir, 0o755); err != nil {
			fmt.Fprintf(os.Stderr, "ERROR: creating output directory: %v\n", err)
			os.Exit(1)
		}
	}

	f, err := os.Create(*outPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "ERROR: creating output file: %v\n", err)
		os.Exit(1)
	}
	defer f.Close()

	enc := json.NewEncoder(f)
	enc.SetIndent("", "  ")
	if err := enc.Encode(entries); err != nil {
		fmt.Fprintf(os.Stderr, "ERROR: writing output JSON: %v\n", err)
		os.Exit(1)
	}

	// Report stats to stderr.
	fmt.Fprintf(os.Stderr, "Done.\n")
	fmt.Fprintf(os.Stderr, "  fribb entries : %d\n", stats.FribbCount)
	fmt.Fprintf(os.Stderr, "  bel entries   : %d\n", stats.BelCount)
	fmt.Fprintf(os.Stderr, "  mapped        : %d\n", stats.Mapped)
	fmt.Fprintf(os.Stderr, "  conflicts     : %d\n", stats.Conflicts)
	fmt.Fprintf(os.Stderr, "  output        : %s\n", *outPath)
}

// load reads from an HTTP(S) URL or a local file path.
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
