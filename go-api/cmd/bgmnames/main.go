// cmd/bgmnames — simplified Chinese names for the people and characters
// our titles credit, from the Bangumi Archive dump
// (https://github.com/bangumi/Archive).  The matching rules and why they
// are what they are: internal/bgmnames.
//
// Usage:
//
//	bgmnames --dump DIR [--apply] [--source NAME] [--samples N]
//
// --dump DIR: an extracted dump.  Only person.jsonlines,
//
//	character.jsonlines, subject-persons.jsonlines and
//	person-characters.jsonlines are read; the rest of the zip need not be
//	extracted.
//
// --apply: write the matches to bgm_person_map and bgm_character_map.
//
//	Without it the run is a dry run: it reads, matches, and prints the
//	counts, the conflicts, sample pairs and what a write would change.
//
// --source NAME: the dump name stored with each written row (default: the
//
//	--dump directory's name, so name it after the zip).
//
// --samples N: pairs of each kind to print (default 10).
//
// DATABASE_URL names the database, as for the server.  A write is one
// transaction that leaves both tables holding exactly this run's matches,
// so running it again on the same dump changes nothing, and running it on
// next week's dump applies only what changed.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/lawrenceli0228/animego/go-api/internal/bgmnames"
	"github.com/lawrenceli0228/animego/go-api/internal/config"
	"github.com/lawrenceli0228/animego/go-api/internal/db"
)

func main() {
	opts, samples, err := parseArgs(os.Args[1:], os.Stderr)
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			os.Exit(0)
		}
		fmt.Fprintln(os.Stderr, "bgmnames:", err)
		os.Exit(2)
	}

	ctx := context.Background()
	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintln(os.Stderr, "bgmnames: config:", err)
		os.Exit(1)
	}
	connectCtx, cancel := context.WithTimeout(ctx, db.ConnectTimeout)
	pool, err := db.NewPool(connectCtx, cfg.DatabaseURL)
	cancel()
	if err != nil {
		fmt.Fprintln(os.Stderr, "bgmnames: postgres:", err)
		os.Exit(1)
	}
	defer pool.Close()

	if opts.Apply {
		fmt.Fprintln(os.Stderr, "bgmnames: --apply writes bgm_person_map and bgm_character_map")
	}
	rep, err := bgmnames.Run(ctx, pool, opts)
	if err != nil {
		fmt.Fprintln(os.Stderr, "bgmnames:", err)
		pool.Close()
		os.Exit(1)
	}
	rep.Write(os.Stdout, samples)
}

// parseArgs reads the command line.  --dump is required and must be a
// directory holding every file the import reads; checking that here gives
// a usage error before the database is touched.
func parseArgs(args []string, stderr io.Writer) (bgmnames.Options, int, error) {
	fs := flag.NewFlagSet("bgmnames", flag.ContinueOnError)
	fs.SetOutput(stderr)
	dump := fs.String("dump", "", "extracted Bangumi Archive dump directory (required)")
	apply := fs.Bool("apply", false, "write the matches; without it, a dry run that only reports")
	source := fs.String("source", "", "dump name stored with each written row (default: the --dump directory's name)")
	samples := fs.Int("samples", 10, "sample pairs of each kind to print")
	if err := fs.Parse(args); err != nil {
		return bgmnames.Options{}, 0, err
	}
	if fs.NArg() > 0 {
		return bgmnames.Options{}, 0, fmt.Errorf("unexpected argument %q", fs.Arg(0))
	}
	if *dump == "" {
		return bgmnames.Options{}, 0, errors.New("--dump is required: the directory a Bangumi Archive dump was extracted to")
	}
	for _, name := range bgmnames.DumpFiles {
		if _, err := os.Stat(filepath.Join(*dump, name)); err != nil {
			return bgmnames.Options{}, 0, fmt.Errorf("--dump %s: %w", *dump, err)
		}
	}
	return bgmnames.Options{DumpDir: *dump, Source: *source, Apply: *apply}, *samples, nil
}
