package hant

// Package entry point: where the vendored datasets live and how they are
// turned into a Resolver.
//
// The three files are read from disk rather than go:embed'ed.
// cgroup-hk.json is CC BY-SA, and embedding it would compile a
// share-alike dataset into an AGPL Go package and erase the licence
// boundary data/hant/README.md draws.  That is why both callers -- the
// CLI's --data flag and the worker's HANT_DATA_DIR -- take a directory
// rather than nothing at all.

import (
	"os"
	"path/filepath"
)

// The three vendored files.  Named here rather than at each call site so
// the CLI and the worker cannot disagree about what a data directory is
// supposed to contain.
const (
	anilistFile = "anilist-chinese.json"
	cgroupFile  = "cgroup-hk.json"
	openccFile  = "opencc-s2twp.txt"
)

// DataDirEnv is the environment variable the server-side worker reads its
// dataset directory from.
//
// The Docker image bakes the files at /usr/local/share/animego/hant (see
// go-api/Dockerfile), which is not where a developer running from a
// checkout has them, so the location cannot be a constant.
const DataDirEnv = "HANT_DATA_DIR"

// DefaultDataDir is the relative path a checkout has, i.e. what
// `go run ./cmd/hantbackfill` from go-api/ finds.  It matches the --data
// flag's default so a developer who sets neither gets the same directory
// from either entry point.
const DefaultDataDir = "data/hant"

// DataDirFromEnv resolves the dataset directory for a caller that has no
// flags to parse.
//
// Empty is treated as unset rather than as "the current directory": an
// env var set to "" in a compose file is a misconfiguration, and
// silently reading the process's working directory would surface as
// "anilist-chinese.json: no such file" from wherever the container
// happened to start.
func DataDirFromEnv() string {
	if dir := os.Getenv(DataDirEnv); dir != "" {
		return dir
	}
	return DefaultDataDir
}

// NewResolverFromDir loads the three vendored files and derives the gate.
func NewResolverFromDir(dir string) (*Resolver, error) {
	conv, err := LoadConverter(filepath.Join(dir, openccFile))
	if err != nil {
		return nil, err
	}
	g, err := newGate(conv)
	if err != nil {
		return nil, err
	}
	as, err := loadAnilistSet(filepath.Join(dir, anilistFile))
	if err != nil {
		return nil, err
	}
	cs, err := loadCgroupSet(filepath.Join(dir, cgroupFile))
	if err != nil {
		return nil, err
	}
	return &Resolver{cgroup: cs, anilist: as, gate: g, conv: conv}, nil
}

// LoadStats are the dataset sizes a caller logs immediately after
// loading.
//
// They exist because a truncated or half-written dataset file still
// parses: a JSON array with 40 records instead of 8,492 is valid JSON,
// and the run that consumes it silently demotes thousands of rows from
// the anilist tier to opencc -- which is a mass rewrite of exactly the
// column that must not be machine-converted.  Printed at load time, the
// numbers are checkable against the README before anything is written.
type LoadStats struct {
	AnilistRecords  int
	CgroupKeys      int
	CgroupDropped   int
	SimplifiedRunes int
}

// LoadStats reports how much of each dataset survived loading.
func (r *Resolver) LoadStats() LoadStats {
	return LoadStats{
		AnilistRecords:  len(r.anilist.byID),
		CgroupKeys:      len(r.cgroup.byKey),
		CgroupDropped:   len(r.cgroup.Dropped),
		SimplifiedRunes: len(r.gate.simplified),
	}
}
