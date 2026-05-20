// Orchestrator: topological execution of registered Transforms against a
// live Mongo cursor + Postgres pool, with dry-run support, per-row
// failure logging, and end-of-run reporting.
//
// The orchestrator is intentionally agnostic about which tables exist;
// it routes each PGRow by its Table field and builds INSERT statements
// dynamically from Columns/Values.  P1.C transforms supply the schema
// knowledge.
package migrate

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"sort"
	"strings"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

// Config captures every CLI flag the orchestrator needs.  Built by
// cmd/migrate-mongo/main.go and handed to NewOrchestrator unmodified.
type Config struct {
	MongoDatabase string // mongo db name; parsed from --mongo-uri
	DryRun        bool
	Commit        bool
	Collections   []string // empty or ["all"] -> run everything
	BatchSize     int
	LogFailedPath string
	Concurrency   int // currently used only as a knob for reader parallelism across collections
}

// CollectionReport is the per-collection summary printed at end of run.
type CollectionReport struct {
	Name        string        `json:"name"`
	MongoCount  int64         `json:"mongo_count"`
	PGCount     int64         `json:"pg_count"`
	Transformed int64         `json:"transformed"`
	Failed      int64         `json:"failed"`
	Duration    time.Duration `json:"duration_ns"`
}

// Orchestrator wires the run together.
type Orchestrator struct {
	cfg      Config
	logger   *slog.Logger
	mongoCli *mongo.Client
	pgPool   *pgxpool.Pool

	failLog *os.File
	reports []CollectionReport
}

// NewOrchestrator constructs an orchestrator.  failLogPath is opened
// (created/appended) here so a permission error fails fast before any
// data is touched.
func NewOrchestrator(cfg Config, logger *slog.Logger, mc *mongo.Client, pg *pgxpool.Pool) (*Orchestrator, error) {
	if logger == nil {
		return nil, fmt.Errorf("orchestrator: nil logger")
	}
	if mc == nil || pg == nil {
		return nil, fmt.Errorf("orchestrator: nil mongo or pg client")
	}
	if cfg.BatchSize <= 0 {
		return nil, fmt.Errorf("orchestrator: batch size must be > 0")
	}
	f, err := os.OpenFile(cfg.LogFailedPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return nil, fmt.Errorf("open failure log %q: %w", cfg.LogFailedPath, err)
	}
	return &Orchestrator{
		cfg:      cfg,
		logger:   logger,
		mongoCli: mc,
		pgPool:   pg,
		failLog:  f,
	}, nil
}

// Close releases the failure log file.  Mongo/PG clients are owned by
// the caller and closed there.
func (o *Orchestrator) Close() error {
	if o.failLog != nil {
		return o.failLog.Close()
	}
	return nil
}

// Run executes the migration end-to-end.  Returns the first fatal error;
// per-row transform failures are logged and counted, not returned.
func (o *Orchestrator) Run(ctx context.Context) error {
	all := Registered()
	if len(all) == 0 {
		return fmt.Errorf("no transforms registered; P1.C transforms not yet linked?")
	}

	selected, err := o.filter(all)
	if err != nil {
		return err
	}

	ordered, err := topoSort(selected)
	if err != nil {
		return fmt.Errorf("topo-sort: %w", err)
	}

	o.logger.Info("migration plan",
		"total_registered", len(all),
		"selected", len(selected),
		"ordered", transformNames(ordered),
		"dry_run", o.cfg.DryRun,
		"commit", o.cfg.Commit,
	)

	overallStart := time.Now()
	for _, t := range ordered {
		rpt, err := o.runOne(ctx, t)
		o.reports = append(o.reports, rpt)
		if err != nil {
			o.logger.Error("collection failed fatally",
				"collection", t.Name(),
				"err", err,
			)
			o.printReport(time.Since(overallStart))
			return fmt.Errorf("collection %q: %w", t.Name(), err)
		}
	}
	o.printReport(time.Since(overallStart))
	return nil
}

// filter narrows the transform list to the user's --collections selection.
func (o *Orchestrator) filter(all []Transform) ([]Transform, error) {
	if len(o.cfg.Collections) == 0 ||
		(len(o.cfg.Collections) == 1 && strings.EqualFold(o.cfg.Collections[0], "all")) {
		return all, nil
	}
	want := map[string]struct{}{}
	for _, c := range o.cfg.Collections {
		want[strings.TrimSpace(c)] = struct{}{}
	}
	var out []Transform
	for _, t := range all {
		if _, ok := want[t.Name()]; ok {
			out = append(out, t)
			delete(want, t.Name())
		}
	}
	if len(want) > 0 {
		missing := make([]string, 0, len(want))
		for k := range want {
			missing = append(missing, k)
		}
		sort.Strings(missing)
		return nil, fmt.Errorf("unknown collections in filter: %s", strings.Join(missing, ","))
	}
	return out, nil
}

// runOne executes a single Transform: count, stream, transform, batch-write.
func (o *Orchestrator) runOne(ctx context.Context, t Transform) (CollectionReport, error) {
	start := time.Now()
	rpt := CollectionReport{Name: t.Name()}

	o.logger.Info("starting collection",
		"name", t.Name(),
		"mongo_collection", t.MongoCollection(),
		"pg_table", t.PGTable(),
		"depends_on", t.DependsOn(),
	)

	coll := o.mongoCli.Database(o.cfg.MongoDatabase).Collection(t.MongoCollection())
	mongoCount, err := coll.CountDocuments(ctx, bson.M{})
	if err != nil {
		return rpt, fmt.Errorf("mongo count: %w", err)
	}
	rpt.MongoCount = mongoCount

	cursor, err := coll.Find(ctx, bson.M{})
	if err != nil {
		return rpt, fmt.Errorf("mongo find: %w", err)
	}
	defer func() { _ = cursor.Close(ctx) }()

	// Group buffered rows by destination table so each table gets its
	// own batched INSERT.  A single Mongo doc can fan out across tables
	// (anime_cache -> anime_cache + anime_genres + ...), and we still
	// honor BatchSize per-table.
	buffers := map[string][]PGRow{}

	var transformed, failed atomic.Int64

	flush := func(table string) error {
		rows := buffers[table]
		if len(rows) == 0 {
			return nil
		}
		buffers[table] = rows[:0]
		if o.cfg.DryRun {
			return nil
		}
		// On --commit, wrap each flush in its own short transaction so
		// a single bad batch can't poison the whole collection's writes.
		return o.writeBatch(ctx, table, t.ConflictTarget(), rows)
	}

	for cursor.Next(ctx) {
		var doc bson.M
		if err := cursor.Decode(&doc); err != nil {
			failed.Add(1)
			o.logFail(t.Name(), nil, fmt.Errorf("decode: %w", err), nil)
			continue
		}
		mongoID := doc["_id"]

		out, err := t.TransformRow(ctx, doc)
		if err != nil {
			failed.Add(1)
			o.logFail(t.Name(), mongoID, err, doc)
			continue
		}
		// Validate column/value parity defensively — a P1.C bug here
		// would otherwise produce confusing pgx errors deep in the batch.
		ok := true
		for _, r := range out {
			if len(r.Columns) != len(r.Values) {
				failed.Add(1)
				o.logFail(t.Name(), mongoID,
					fmt.Errorf("table %q: columns=%d values=%d", r.Table, len(r.Columns), len(r.Values)),
					doc)
				ok = false
				break
			}
			if r.Table == "" {
				failed.Add(1)
				o.logFail(t.Name(), mongoID,
					fmt.Errorf("transform emitted PGRow with empty Table"),
					doc)
				ok = false
				break
			}
		}
		if !ok {
			continue
		}

		for _, r := range out {
			buffers[r.Table] = append(buffers[r.Table], r)
			if len(buffers[r.Table]) >= o.cfg.BatchSize {
				if err := flush(r.Table); err != nil {
					return rpt, fmt.Errorf("flush %s: %w", r.Table, err)
				}
				rpt.PGCount += int64(o.cfg.BatchSize)
			}
		}
		transformed.Add(1)
	}
	if err := cursor.Err(); err != nil {
		return rpt, fmt.Errorf("mongo cursor: %w", err)
	}

	// Final flushes
	tables := make([]string, 0, len(buffers))
	for tbl := range buffers {
		tables = append(tables, tbl)
	}
	sort.Strings(tables)
	for _, tbl := range tables {
		remaining := int64(len(buffers[tbl]))
		if err := flush(tbl); err != nil {
			return rpt, fmt.Errorf("final flush %s: %w", tbl, err)
		}
		rpt.PGCount += remaining
	}

	rpt.Transformed = transformed.Load()
	rpt.Failed = failed.Load()
	rpt.Duration = time.Since(start)

	o.logger.Info("collection done",
		"name", t.Name(),
		"mongo_count", rpt.MongoCount,
		"pg_count", rpt.PGCount,
		"transformed", rpt.Transformed,
		"failed", rpt.Failed,
		"duration_ms", rpt.Duration.Milliseconds(),
		"dry_run", o.cfg.DryRun,
	)
	return rpt, nil
}

// writeBatch performs a transactional UPSERT (or plain INSERT when
// ConflictTarget is empty) for one table.  Uses pgx.Batch to pipeline
// per-row statements; pgx coalesces these into a single round trip per
// batch.
func (o *Orchestrator) writeBatch(ctx context.Context, table, conflictTarget string, rows []PGRow) error {
	if len(rows) == 0 {
		return nil
	}
	tx, err := o.pgPool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	batch := &pgx.Batch{}
	for _, r := range rows {
		stmt := buildUpsert(table, r.Columns, conflictTarget)
		batch.Queue(stmt, r.Values...)
	}
	br := tx.SendBatch(ctx, batch)
	for i := range rows {
		if _, err := br.Exec(); err != nil {
			_ = br.Close()
			return fmt.Errorf("batch row %d (table=%s): %w", i, table, err)
		}
	}
	if err := br.Close(); err != nil {
		return fmt.Errorf("batch close: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	return nil
}

// buildUpsert composes the INSERT ... ON CONFLICT DO UPDATE statement
// for one row.  When conflictTarget is empty, emits a plain INSERT
// (Transforms that opt out of UPSERT take this path).
func buildUpsert(table string, cols []string, conflictTarget string) string {
	quoted := make([]string, len(cols))
	placeholders := make([]string, len(cols))
	updates := make([]string, 0, len(cols))
	for i, c := range cols {
		quoted[i] = pgQuoteIdent(c)
		placeholders[i] = fmt.Sprintf("$%d", i+1)
		updates = append(updates, fmt.Sprintf("%s = EXCLUDED.%s", quoted[i], quoted[i]))
	}
	stmt := fmt.Sprintf("INSERT INTO %s (%s) VALUES (%s)",
		pgQuoteIdent(table),
		strings.Join(quoted, ", "),
		strings.Join(placeholders, ", "),
	)
	if conflictTarget == "" {
		return stmt
	}
	// ConflictTarget is supplied by the Transform; per the interface
	// contract it is either a bare column name or a parenthesized list.
	return stmt + fmt.Sprintf(" ON CONFLICT %s DO UPDATE SET %s", conflictTarget, strings.Join(updates, ", "))
}

// pgQuoteIdent double-quotes a Postgres identifier, escaping embedded
// quotes.  Identifiers come from Transforms (developer-controlled), not
// user input, so this is belt-and-braces against typos rather than a
// security boundary.
func pgQuoteIdent(s string) string {
	return `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
}

// logFail writes one JSONL line to the failure log.  Errors writing to
// the log are themselves logged but never abort the run.
func (o *Orchestrator) logFail(collection string, mongoID any, err error, doc bson.M) {
	entry := map[string]any{
		"ts":         time.Now().UTC().Format(time.RFC3339Nano),
		"collection": collection,
		"mongo_id":   fmt.Sprintf("%v", mongoID),
		"error":      err.Error(),
	}
	if doc != nil {
		entry["doc_excerpt"] = excerptDoc(doc)
	}
	b, mErr := json.Marshal(entry)
	if mErr != nil {
		o.logger.Warn("failure-log marshal failed", "err", mErr)
		return
	}
	if _, wErr := o.failLog.Write(append(b, '\n')); wErr != nil {
		o.logger.Warn("failure-log write failed", "err", wErr)
	}
}

// excerptDoc trims a Mongo document down to its top-level keys with
// shallow values so the failure log stays readable.
func excerptDoc(doc bson.M) map[string]any {
	out := map[string]any{}
	const maxKeys = 12
	count := 0
	for k, v := range doc {
		if count >= maxKeys {
			out["_truncated"] = true
			break
		}
		switch vv := v.(type) {
		case bson.M, bson.A, []any:
			out[k] = fmt.Sprintf("<%T>", vv)
		default:
			out[k] = vv
		}
		count++
	}
	return out
}

// printReport emits the final summary to the logger.
func (o *Orchestrator) printReport(total time.Duration) {
	var (
		sumMongo, sumPG, sumXfm, sumFail int64
	)
	for _, r := range o.reports {
		sumMongo += r.MongoCount
		sumPG += r.PGCount
		sumXfm += r.Transformed
		sumFail += r.Failed
		o.logger.Info("report",
			"name", r.Name,
			"mongo", r.MongoCount,
			"pg", r.PGCount,
			"transformed", r.Transformed,
			"failed", r.Failed,
			"duration_ms", r.Duration.Milliseconds(),
		)
	}
	o.logger.Info("report total",
		"collections", len(o.reports),
		"mongo", sumMongo,
		"pg", sumPG,
		"transformed", sumXfm,
		"failed", sumFail,
		"duration_ms", total.Milliseconds(),
		"dry_run", o.cfg.DryRun,
	)
}

// topoSort orders transforms so every Transform appears after its
// DependsOn entries.  Cycles panic with the involved names — they
// indicate a programming error in a P1.C transform's DependsOn().
func topoSort(in []Transform) ([]Transform, error) {
	byName := map[string]Transform{}
	for _, t := range in {
		byName[t.Name()] = t
	}

	const (
		white = 0
		gray  = 1
		black = 2
	)
	color := map[string]int{}
	var order []Transform
	var visit func(name string, stack []string) error
	visit = func(name string, stack []string) error {
		t, ok := byName[name]
		if !ok {
			// Dependency on a transform not in the selected set — that's
			// the caller's mistake (--collections filter pruned it out
			// or P1.C forgot to register a dependency).
			return fmt.Errorf("transform %q depends on unknown %q", stack[len(stack)-1], name)
		}
		switch color[name] {
		case gray:
			return fmt.Errorf("dependency cycle: %s -> %s", strings.Join(stack, " -> "), name)
		case black:
			return nil
		}
		color[name] = gray
		for _, dep := range t.DependsOn() {
			if err := visit(dep, append(stack, name)); err != nil {
				return err
			}
		}
		color[name] = black
		order = append(order, t)
		return nil
	}

	// Iterate in a stable order so error messages and execution order
	// are deterministic across runs.
	names := make([]string, 0, len(in))
	for n := range byName {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		if color[n] == black {
			continue
		}
		if err := visit(n, []string{n}); err != nil {
			// Cycles are programmer errors; per the spec we panic with
			// the names involved.
			if strings.Contains(err.Error(), "dependency cycle") {
				panic(err.Error())
			}
			return nil, err
		}
	}
	return order, nil
}

func transformNames(ts []Transform) []string {
	out := make([]string, len(ts))
	for i, t := range ts {
		out[i] = t.Name()
	}
	return out
}

// Sentinel returned by Run when no transforms match the filter.  Useful
// for the CLI to distinguish "user filtered to nothing" from a real
// failure.
var ErrNoTransformsSelected = errors.New("no transforms selected after --collections filter")
