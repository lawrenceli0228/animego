// Package migrate contains the one-shot MongoDB -> PostgreSQL migration
// orchestrator and supporting infrastructure for AnimeGo.
//
// This file defines the Transform interface every per-collection migrator
// must implement, plus a package-level registry that concrete transforms
// (added in P1.C) hook into via init().  The orchestrator (orchestrator.go)
// consumes the registry, topo-sorts by DependsOn, and executes each
// Transform against a live Mongo cursor and Postgres pool.
//
// Keep this file free of collection-specific logic — it is the contract
// between the orchestration layer and the (future) per-collection
// transforms.
package migrate

import (
	"context"
	"fmt"
	"sort"
	"sync"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// PGRow is the unit a Transform emits per output row.
//
// Columns is the ordered list of Postgres column names for the target table.
// Values is the matching ordered list of Go values bound to those columns.
// len(Columns) must equal len(Values); the orchestrator validates this and
// routes the failure to the failure log when it does not.
//
// A single Mongo document may produce multiple PGRow values targeting
// different tables — e.g. one anime_cache document fans out to one
// anime_cache row plus N anime_genres rows, M anime_studios rows, etc.
// Table on each PGRow tells the orchestrator where to write that row.
type PGRow struct {
	Table   string
	Columns []string
	Values  []any
}

// Transform is the contract every per-collection migrator implements.
//
// One Transform owns the mapping from a single Mongo collection to one or
// more Postgres tables.  Implementations live in their own files inside
// internal/migrate/transforms/ and register themselves via init() calls
// to migrate.Register().
//
// Interfaces are kept small per project convention — five methods, all
// pure except TransformRow which may allocate.
type Transform interface {
	// Name is the human-readable identifier used in logs, the CLI
	// --collections filter, and DependsOn references.  Conventionally
	// matches MongoCollection() but does not have to.
	Name() string

	// MongoCollection is the source collection name as it appears in
	// the Mongo database (e.g. "users", "anime_cache").
	MongoCollection() string

	// PGTable is the *primary* destination table.  A Transform that
	// fans out into multiple tables still reports a primary table here
	// for logging and reporting purposes; the actual per-row routing
	// uses PGRow.Table.
	PGTable() string

	// ConflictTarget is the ON CONFLICT clause body used for idempotent
	// UPSERT.  Examples: "id", "(user_id, anilist_id)".  Return empty
	// string to disable UPSERT and use plain INSERT (will fail on
	// duplicates — only use for tables guaranteed to be empty on a
	// fresh run).
	ConflictTarget() string

	// DependsOn returns the Name() values of Transforms that must
	// complete successfully before this one runs.  Used by the
	// orchestrator's topo-sort.  Empty slice = no dependencies.
	DependsOn() []string

	// TransformRow converts one Mongo document into 0..N Postgres rows.
	// Returning (nil, nil) means "skip this doc silently" (e.g. soft-
	// deleted records).  Returning (nil, err) routes the doc to the
	// failure log; orchestration continues with the next doc.
	TransformRow(ctx context.Context, doc bson.M) ([]PGRow, error)
}

// registry is the package-level set of registered Transforms.
//
// Concrete transforms call Register() from their init() functions; the
// orchestrator reads the registry via Registered() once at startup.
var (
	registryMu sync.RWMutex
	registry   = map[string]Transform{}
)

// Register adds a Transform to the package registry.  Intended to be
// called from init() in per-collection files.  Duplicate names panic
// because the conflict would otherwise silently shadow a transform.
func Register(t Transform) {
	if t == nil {
		panic("migrate.Register: nil transform")
	}
	name := t.Name()
	if name == "" {
		panic("migrate.Register: transform has empty Name()")
	}
	registryMu.Lock()
	defer registryMu.Unlock()
	if _, dup := registry[name]; dup {
		panic(fmt.Sprintf("migrate.Register: duplicate transform name %q", name))
	}
	registry[name] = t
}

// Registered returns a snapshot of all registered Transforms, sorted by
// Name() for deterministic iteration in tests.  Topological ordering is
// applied separately by the orchestrator.
func Registered() []Transform {
	registryMu.RLock()
	defer registryMu.RUnlock()
	out := make([]Transform, 0, len(registry))
	for _, t := range registry {
		out = append(out, t)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name() < out[j].Name() })
	return out
}

// Lookup returns the Transform registered under name, or nil if none.
// Used by the CLI --collections filter to validate user input.
func Lookup(name string) Transform {
	registryMu.RLock()
	defer registryMu.RUnlock()
	return registry[name]
}

// resetRegistryForTest clears the registry; tests use this via the
// export_test.go pattern.  Not exported.
func resetRegistryForTest() {
	registryMu.Lock()
	defer registryMu.Unlock()
	registry = map[string]Transform{}
}
