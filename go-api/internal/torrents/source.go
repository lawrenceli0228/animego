// Package torrents — source.go
//
// The pluggable-source abstraction the aggregator fans out over.  Each
// upstream (garden / acg / nyaa, and any future addition) is a Source:
// it knows its own Name and how to Fetch for a query.  The aggregator
// no longer hard-codes three fetcher fields — it iterates whatever the
// Registry holds (see registry.go), so adding a source is "register one
// implementation", not "edit the fan-out core".
//
// This file is a pure structural extraction: the concrete Fetch bodies
// still live in garden.go / acgrip.go / nyaa.go (the FetchXxx exported
// functions are untouched).  The thin source structs there wrap those.
package torrents

import (
	"context"
	"time"
)

// Fetcher is one upstream source the aggregator fans out to.
// Deliberately tiny (accept-interfaces / return-structs): a Name for
// identity + logging, and a Fetch that returns this source's items for a
// query.
//
// (The interface is named Fetcher rather than "Source" because the
// pre-existing Source string type — the upstream identifier returned by
// Name — already owns that name and is referenced throughout the package
// and its tests.)
//
// Fetch's contract matches the legacy per-source fetcher exactly:
//   - (items, nil)  → success (items may be empty)
//   - (nil, err)    → this source failed; the aggregator logs it and
//     substitutes an empty slice so the other sources still flow through
//     (partial-failure tolerance).  A Fetcher MUST NOT panic — return an
//     error instead.
//
// Fetch receives the per-source child context (already carrying the
// aggregator's per-source timeout); implementations should honour
// ctx.Done().
type Fetcher interface {
	// Name reports which upstream this is.  Used as the merge-order key
	// and the failure-log tag; must be stable and unique within a
	// Registry.
	Name() Source
	// Fetch returns this source's torrents for q.  See the interface
	// docstring for the error contract.
	Fetch(ctx context.Context, q string) ([]TorrentItem, error)
}

// Capabilities describes optional, source-specific hints the aggregator
// can consult.  It exists so a future scheduler / ranker can treat
// richer sources differently WITHOUT the aggregator growing a switch on
// concrete types.  Nothing in this PR reads these fields yet — they're
// the forward-looking seam for seeders, per-source budgets, and
// priority ordering that later PRs will wire in.
//
// Zero value is the "no special capabilities" default the aggregator
// falls back to when a Source does not implement Capable.
type Capabilities struct {
	// SupportsSeeders reports whether this source can populate a
	// seeders/leechers count.  RSS scrapes (acg / nyaa) cannot; a richer
	// JSON source could.  Default false.
	SupportsSeeders bool
	// Budget is a per-source time budget hint.  Zero means "use the
	// aggregator's default per-source timeout".
	Budget time.Duration
	// Priority orders sources when a future ranker needs a tie-break.
	// Higher wins.  Zero is the neutral default.
	Priority int
}

// Capable is the optional companion interface a Fetcher may implement to
// advertise Capabilities.  The aggregator type-asserts for it and falls
// back to the zero Capabilities when a source does not implement it, so
// implementing Capable is strictly opt-in.  The RSS sources (acg / nyaa)
// deliberately do NOT implement it.
type Capable interface {
	Capabilities() Capabilities
}

// CapabilitiesOf returns the Capabilities a Fetcher advertises, or the
// zero value when it does not implement Capable.  Centralised so every
// call site does the type-assert the same way (and so the default is
// defined in exactly one place).
func CapabilitiesOf(f Fetcher) Capabilities {
	if c, ok := f.(Capable); ok {
		return c.Capabilities()
	}
	return Capabilities{}
}

// fetchFn is the shape of a single upstream fetcher.  Kept as a named
// type so the WithXxxFn option setters can swap in test stubs without
// caring about the concrete source behind them.
type fetchFn func(ctx context.Context, q string) ([]TorrentItem, error)

// funcSource adapts a bare fetchFn + a name into a Fetcher.  It is the
// mechanism the WithGardenFn / WithAcgFn / WithNyaaFn options use to
// override a registered source by Name with a single-function stub —
// the registry swap preserves position so merge order is unchanged.
type funcSource struct {
	name  Source
	fetch fetchFn
}

// newFuncSource wraps fn as a Fetcher named name.
func newFuncSource(name Source, fn fetchFn) funcSource {
	return funcSource{name: name, fetch: fn}
}

func (s funcSource) Name() Source { return s.name }

func (s funcSource) Fetch(ctx context.Context, q string) ([]TorrentItem, error) {
	return s.fetch(ctx, q)
}
