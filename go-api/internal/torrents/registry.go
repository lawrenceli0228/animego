// Package torrents — registry.go
//
// Registry is the ordered collection of Fetchers the aggregator fans out
// over.  It replaces the three hard-coded fetcher fields on Aggregator:
// the fan-out loop iterates Sources() instead of naming garden / acg /
// nyaa explicitly, so adding a source is a Register call rather than an
// edit to the aggregator core.
//
// Order is load-bearing.  The aggregator merges results in registration
// order (garden → acg → nyaa by default), and several tests assert that
// order, so Registry preserves insertion order and replaceByName swaps a
// source in place rather than re-appending it.
package torrents

// Registry holds the ordered set of Fetchers to fan out to.  It is NOT
// safe for concurrent mutation; build it fully during construction (in
// New / via options) and treat it as read-only once Fetch is running.
// Sources() returns a defensive copy so callers cannot mutate the
// backing slice mid-flight.
type Registry struct {
	sources []Fetcher
}

// NewRegistry builds a Registry from the given fetchers, preserving
// order.  Passing zero fetchers yields an empty registry (the aggregator
// then merges nothing — a valid, if inert, configuration).
func NewRegistry(fetchers ...Fetcher) *Registry {
	// Copy into a freshly-sized slice so the caller's variadic backing
	// array can't be aliased and mutated out from under us.
	cp := make([]Fetcher, len(fetchers))
	copy(cp, fetchers)
	return &Registry{sources: cp}
}

// Register appends a fetcher to the end of the registry, so it merges
// last relative to the sources already present.
func (r *Registry) Register(f Fetcher) {
	r.sources = append(r.sources, f)
}

// Sources returns the registered fetchers in registration order.  The
// returned slice is a copy — mutating it does not affect the registry.
func (r *Registry) Sources() []Fetcher {
	out := make([]Fetcher, len(r.sources))
	copy(out, r.sources)
	return out
}

// replaceByName swaps the first fetcher whose Name equals replacement's
// Name, in place (preserving its position so merge order is unchanged),
// and reports whether a match was found.  When no fetcher matches, the
// registry is left untouched and false is returned.
//
// This is the primitive the WithGardenFn / WithAcgFn / WithNyaaFn
// options use to override a built-in source with a single-function stub
// without disturbing the order of the other sources.
func (r *Registry) replaceByName(replacement Fetcher) bool {
	for i, s := range r.sources {
		if s.Name() == replacement.Name() {
			r.sources[i] = replacement
			return true
		}
	}
	return false
}
