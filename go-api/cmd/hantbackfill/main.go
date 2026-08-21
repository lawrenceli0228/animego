// cmd/hantbackfill — fills anime_cache.title_hant and .description_hant
// from the vendored zh-Hant datasets, with a machine-converted tail.
//
// Usage:
//
//	hantbackfill [--report] [--apply] [--restale] [--limit N]
//	             [--data DIR] [--out FILE]
//
// Every run is a report: it walks every row, runs the precedence ladder,
// prints the tier distribution, and writes a JSON report to --out (default
// hant-report.json).  The report carries the per-rule gate rejection counts
// and the full list of dataset titles dropped for containing Simplified
// characters, which is the queue for hand promotion to source='manual'.
// Without --apply, that is all it does.
//
// --report: assert read-only.  Exits 2 if --apply is also set.  The report
//
//	is written either way, so this flag does not select a mode — it states
//	an intention the tool will hold you to.
//
// --apply: WRITES.  Back up every affected row to backup-<ts>.json first,
//
//	then write the rows whose resolved (value, source, hash) differs from
//	what is stored, in 500-row batches.  Rows with source='manual' are
//	never touched — enforced here, and again in the UPDATE's WHERE clause.
//	SIGINT/SIGTERM stops cleanly at the next batch boundary.  The backup
//	path is printed before the first UPDATE and again in the summary; an
//	existing backup is never overwritten, so a second run in the same
//	second lands on backup-<ts>-2.json rather than replacing the first
//	run's only undo file.
//
// --restale: narrow the run to rows whose stored *_hant_source_hash no
//
//	longer matches the input their source claims to derive from.  On its
//	own it reports; with --apply it rewrites only those rows, so an
//	operator can repair drift without also promoting tiers.
//
// --limit N: stop after N rows (0=all).  For smoke runs.  It does NOT
//
//	reduce the read: ListAnimeForHantBackfill is a whole-table statement and
//	the cap is applied in Go once the rows are already here, so --limit buys
//	a shorter classification pass and nothing else.  It also writes its
//	report to hant-report-limit-N.json rather than the default path, so a
//	smoke run cannot replace the full report an operator is working from.
//
// --data DIR: vendored dataset directory (default data/hant, i.e. run
//
//	this from go-api/).
//
// --out FILE: report JSON path (default hant-report.json).
//
// Why a standalone CLI and not a river sweep
// ------------------------------------------
// description_backfill.go rejected a CLI because its work spends a shared
// rate-limit budget that a second process would blow.  Nothing here
// touches the network: both datasets and the conversion table are
// vendored files.  The only shared resource is Postgres, and the writes
// are idempotent, so a CLI is the right shape — an operator can run it,
// read the report, and decide.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"syscall"
	"time"

	"github.com/lawrenceli0228/animego/go-api/internal/config"
	"github.com/lawrenceli0228/animego/go-api/internal/db"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

const (
	applyBatchSize = 500

	anilistFile = "anilist-chinese.json"
	cgroupFile  = "cgroup-hk.json"
	openccFile  = "opencc-s2twp.txt"

	defaultReportFile = "hant-report.json"
)

func main() {
	reportMode := flag.Bool("report", false, "assert read-only: refuse to run if --apply is also set")
	applyMode := flag.Bool("apply", false, "WRITES: fill title_hant / description_hant")
	restaleMode := flag.Bool("restale", false, "narrow to rows whose stored source hash no longer matches its input")
	limit := flag.Int("limit", 0, "stop after N rows (0=all)")
	dataDir := flag.String("data", filepath.Join("data", "hant"), "vendored dataset directory")
	outFile := flag.String("out", defaultReportFile, "path for the JSON report")
	flag.Parse()

	// Whether --out was typed, not whether it differs from the default: an
	// operator who names the file gets the file they named, --limit or not.
	outExplicit := false
	flag.Visit(func(f *flag.Flag) {
		if f.Name == "out" {
			outExplicit = true
		}
	})
	reportFile := reportPath(*outFile, outExplicit, *limit)

	mode := resolveMode(*reportMode, *applyMode)
	if mode.Stderr != "" {
		fmt.Fprintln(os.Stderr, mode.Stderr)
	}
	if mode.ExitCode != 0 {
		os.Exit(mode.ExitCode)
	}

	// SIGINT/SIGTERM cancels between write batches.  --apply against
	// production touches ~12k rows; an operator who spots something wrong
	// mid-run should be able to stop it at a batch boundary instead of
	// killing the process somewhere inside one.  Each batch is a single
	// statement, so the partial state is always a whole number of batches.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	res, err := newResolverFromDir(*dataDir)
	if err != nil {
		slog.Error("load vendored datasets failed", "err", err, "dir", *dataDir)
		os.Exit(1)
	}
	slog.Info("datasets loaded",
		"dir", *dataDir,
		"anilist_records", len(res.anilist.byID),
		"cgroup_keys", len(res.cgroup.byKey),
		"cgroup_keys_dropped_ambiguous", len(res.cgroup.Dropped),
		"simplified_runes", len(res.gate.simplified),
	)

	cfg, err := config.Load()
	if err != nil {
		slog.Error("config load failed", "err", err)
		os.Exit(1)
	}
	connectCtx, cancelConn := context.WithTimeout(ctx, db.ConnectTimeout)
	pool, err := db.NewPool(connectCtx, cfg.DatabaseURL)
	cancelConn()
	if err != nil {
		slog.Error("postgres pool init failed", "err", err)
		os.Exit(1)
	}
	defer pool.Close()
	q := dbgen.New(pool)

	slog.Info("fetching anime_cache rows")
	dbRows, err := q.ListAnimeForHantBackfill(ctx)
	if err != nil {
		slog.Error("ListAnimeForHantBackfill failed", "err", err)
		os.Exit(1)
	}
	rows := make([]animeRow, 0, len(dbRows))
	for _, r := range dbRows {
		if *limit > 0 && len(rows) >= *limit {
			break
		}
		rows = append(rows, animeRow{
			AnilistID:       r.AnilistID,
			TitleNative:     r.TitleNative,
			TitleChinese:    r.TitleChinese,
			DescriptionCN:   r.DescriptionCn,
			TitleHant:       r.TitleHant,
			TitleHantSource: r.TitleHantSource,
			TitleHantHash:   r.TitleHantSourceHash,
			DescHant:        r.DescriptionHant,
			DescHantSource:  r.DescriptionHantSource,
			DescHantHash:    r.DescriptionHantSourceHash,
		})
	}
	slog.Info("rows fetched", "total", len(rows))

	results := classifyAll(res, rows)
	rep := buildReport(res, results, *restaleMode)
	printSummary(os.Stdout, rep)

	if err := writeJSON(reportFile, rep); err != nil {
		slog.Error("write report failed", "err", err, "path", reportFile)
		os.Exit(1)
	}
	slog.Info("report written", "path", reportFile)

	if mode.Writes {
		if err := runApply(ctx, os.Stdout, q, results, *restaleMode); err != nil {
			slog.Error("apply failed", "err", err)
			os.Exit(1)
		}
	}
}

// ─── mode resolution ─────────────────────────────────────────────────────────

// modeExitConflict is what --report --apply exits with.  Distinct from 1
// on purpose: 1 is a run that started and broke, 2 is a run that was
// never coherent enough to start, and a wrapper script should be able to
// tell those apart without parsing stderr.
const modeExitConflict = 2

// runMode is what the --report / --apply pair resolves to.
type runMode struct {
	// Writes gates runApply.  It is the only thing that does, so a
	// combination that must not write has to come out of here false.
	Writes bool
	// ExitCode is 0 when the pair is coherent and modeExitConflict when
	// it is not.
	ExitCode int
	// Stderr is the line to print before acting on ExitCode: the refusal
	// on a conflict, the WRITES warning on an apply, empty otherwise.
	Stderr string
}

// resolveMode turns the two mode flags into a decision.
//
// --report is an assertion, not a mode.  The report is built and written
// on every run -- there is no point deciding whether to classify when
// --apply needs the classification anyway -- so a flag that merely
// selected "report mode" would do nothing at all, which is exactly what
// it used to do.  What it does instead is refuse to write: an operator
// who types --report means "do not touch the table", and pairing it with
// --apply is a mistake worth failing on rather than resolving by
// precedence.
func resolveMode(reportMode, applyMode bool) runMode {
	if reportMode && applyMode {
		return runMode{
			ExitCode: modeExitConflict,
			Stderr:   "error: --report asserts read-only and cannot be combined with --apply",
		}
	}
	if applyMode {
		return runMode{
			Writes: true,
			Stderr: "WARNING: --apply will WRITE title_hant / description_hant to production rows. Proceeding...",
		}
	}
	return runMode{}
}

// reportPath keeps a --limit smoke run from replacing the full report.
//
// --limit stops the classification after N rows, so the report it produces
// describes N rows -- but it used to land on the same default path as a
// whole-table run, so `--limit 20` silently overwrote the full report an
// operator was working from.  That report is not a log: its
// simplified_rejections list is the queue for hand-promoting titles to
// source='manual', and a 20-row queue that looks like the whole queue is
// the same failure as a truncated backup.  A limited run gets its own
// name, unless the operator named one.
func reportPath(out string, outExplicit bool, limit int) string {
	if limit <= 0 || outExplicit {
		return out
	}
	return fmt.Sprintf("hant-report-limit-%d.json", limit)
}

// newResolverFromDir loads the three vendored files and derives the gate.
func newResolverFromDir(dir string) (*resolver, error) {
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
	return &resolver{cgroup: cs, anilist: as, gate: g, conv: conv}, nil
}

// ─── classification ──────────────────────────────────────────────────────────

// rowResult is one row's full outcome: what the ladder proposes, what is
// stored, and whether the two differ.
type rowResult struct {
	row animeRow

	titleManual bool
	descManual  bool

	title decision
	desc  decision

	titleChanged bool
	descChanged  bool

	titleStale staleKind
	descStale  staleKind
}

func classifyAll(r *resolver, rows []animeRow) []rowResult {
	out := make([]rowResult, 0, len(rows))
	for i, row := range rows {
		if i > 0 && i%2000 == 0 {
			slog.Info("classification progress", "processed", i, "total", len(rows))
		}

		res := rowResult{
			row:         row,
			titleManual: isManual(row.TitleHantSource),
			descManual:  isManual(row.DescHantSource),
			titleStale:  r.checkStale(row, row.TitleHant, row.TitleHantSource, row.TitleHantHash),
			descStale:   r.checkDescriptionStale(row),
		}

		if !res.titleManual {
			res.title = r.resolveTitle(row)
			res.titleChanged = differs(res.title, row.TitleHant, row.TitleHantSource, row.TitleHantHash)
		}
		if !res.descManual {
			res.desc = r.resolveDescription(row)
			res.descChanged = differs(res.desc, row.DescHant, row.DescHantSource, row.DescHantHash)
		}
		out = append(out, res)
	}
	slog.Info("classification complete", "total", len(rows))
	return out
}

// differs reports whether a proposed decision would change the stored
// triple.  A decision with no source proposes nothing and therefore never
// changes anything — the ladder reaching none of its tiers is not a
// reason to blank a column someone else filled.
func differs(d decision, value, source, hash *string) bool {
	if d.Source == "" {
		return false
	}
	return !eq(value, d.Value) || !eq(source, d.Source) || !eq(hash, d.Hash)
}

func eq(stored *string, want string) bool {
	return stored != nil && *stored == want
}

// writable returns the rows this run would actually write, honouring
// --restale.
func writable(results []rowResult, restaleOnly bool) (titles, descs []rowResult) {
	for _, r := range results {
		if !r.titleManual && r.titleChanged && (!restaleOnly || r.titleStale != staleNone) {
			titles = append(titles, r)
		}
		if !r.descManual && r.descChanged && (!restaleOnly || r.descStale != staleNone) {
			descs = append(descs, r)
		}
	}
	return titles, descs
}

// ─── apply ───────────────────────────────────────────────────────────────────

// backupRow is one pre-write snapshot.  Written before anything is
// touched so a bad run is a psql script away from being undone.
type backupRow struct {
	AnilistID int32 `json:"anilist_id"`

	TitleHant           *string `json:"title_hant"`
	TitleHantSource     *string `json:"title_hant_source"`
	TitleHantSourceHash *string `json:"title_hant_source_hash"`

	DescriptionHant           *string `json:"description_hant"`
	DescriptionHantSource     *string `json:"description_hant_source"`
	DescriptionHantSourceHash *string `json:"description_hant_source_hash"`
}

// hantWriter is the slice of *dbgen.Queries that runApply uses.  Narrow
// on purpose: the generated Querier carries a hundred-odd methods, and an
// interface that wide cannot be faked in a test without a pool, which
// would leave the whole apply path -- backup-before-write, the alignment
// guard, the offered-vs-written gap -- provable only by reading it.
type hantWriter interface {
	ApplyHantTitleBatch(ctx context.Context, anilistIds []int32, titles []string, sources []string, hashes []string) (int64, error)
	ApplyHantDescriptionBatch(ctx context.Context, anilistIds []int32, descriptions []string, sources []string, hashes []string) (int64, error)
}

func runApply(ctx context.Context, out io.Writer, q hantWriter, results []rowResult, restaleOnly bool) error {
	titles, descs := writable(results, restaleOnly)
	if len(titles) == 0 && len(descs) == 0 {
		fmt.Fprintf(out, "\nApply complete: nothing to write.\n\n")
		return nil
	}

	// Backup every row either write would touch, deduplicated, before the
	// first UPDATE runs.
	seen := make(map[int32]struct{}, len(titles)+len(descs))
	var backup []backupRow
	for _, group := range [][]rowResult{titles, descs} {
		for _, r := range group {
			if _, dup := seen[r.row.AnilistID]; dup {
				continue
			}
			seen[r.row.AnilistID] = struct{}{}
			backup = append(backup, backupRow{
				AnilistID:                 r.row.AnilistID,
				TitleHant:                 r.row.TitleHant,
				TitleHantSource:           r.row.TitleHantSource,
				TitleHantSourceHash:       r.row.TitleHantHash,
				DescriptionHant:           r.row.DescHant,
				DescriptionHantSource:     r.row.DescHantSource,
				DescriptionHantSourceHash: r.row.DescHantHash,
			})
		}
	}
	sort.Slice(backup, func(i, j int) bool { return backup[i].AnilistID < backup[j].AnilistID })

	backupPath, err := writeBackupJSON(time.Now().UTC().Format(backupStamp), backup)
	if err != nil {
		return fmt.Errorf("write backup: %w", err)
	}
	slog.Info("backup written", "path", backupPath, "rows", len(backup))

	// Announced here rather than only in the completion summary, because
	// the run an operator most needs this path for is the one that never
	// reaches a completion summary.  Every error return below this line --
	// a failed statement, Ctrl-C between batches -- leaves rows written and
	// used to leave the operator hunting for the undo file in slog output.
	fmt.Fprintf(out, "\nBackup:  %s  (%d rows)\n", backupPath, len(backup))

	titlesWritten, err := applyBatches(ctx, len(titles), func(start, end int) (int64, error) {
		ids, vals, srcs, hashes := columns(titles[start:end], func(r rowResult) decision { return r.title })
		return writeBatch(ctx, ids, vals, srcs, hashes, q.ApplyHantTitleBatch)
	})
	if err != nil {
		return fmt.Errorf("title_hant: %w", err)
	}

	descsWritten, err := applyBatches(ctx, len(descs), func(start, end int) (int64, error) {
		ids, vals, srcs, hashes := columns(descs[start:end], func(r rowResult) decision { return r.desc })
		return writeBatch(ctx, ids, vals, srcs, hashes, q.ApplyHantDescriptionBatch)
	})
	if err != nil {
		return fmt.Errorf("description_hant: %w", err)
	}

	fmt.Fprintf(out, "\nApply complete:\n")
	printWritten(out, "title_hant", titlesWritten, len(titles))
	printWritten(out, "description_hant", descsWritten, len(descs))
	fmt.Fprintf(out, "  Backup:  %s\n\n", backupPath)
	return nil
}

// printWritten reports rows actually updated, and says so explicitly when
// that is fewer than the rows offered.
//
// The gap is not an error: the UPDATE's manual guard skips a row that was
// hand-promoted to source='manual' between the report and the apply,
// which is the guard doing its job.  It is worth surfacing rather than
// hiding, because the only other explanation is that an id vanished from
// anime_cache mid-run.
func printWritten(w io.Writer, column string, written int64, offered int) {
	if int(written) == offered {
		fmt.Fprintf(w, "  %-17s %d rows written\n", column, written)
		return
	}
	fmt.Fprintf(w, "  %-17s %d rows written (%d offered; %d skipped by the manual guard or gone)\n",
		column, written, offered, offered-int(written))
}

// columns pivots a slice of rowResult into the four parallel arrays the
// batch statements take.
func columns(rows []rowResult, pick func(rowResult) decision) (ids []int32, values, sources, hashes []string) {
	ids = make([]int32, 0, len(rows))
	values = make([]string, 0, len(rows))
	sources = make([]string, 0, len(rows))
	hashes = make([]string, 0, len(rows))
	for _, r := range rows {
		d := pick(r)
		ids = append(ids, r.row.AnilistID)
		values = append(values, d.Value)
		sources = append(sources, d.Source)
		hashes = append(hashes, d.Hash)
	}
	return ids, values, sources, hashes
}

// checkAligned refuses to send arrays of unequal length to an unnest join.
//
// Postgres evaluates several set-returning functions in one SELECT list
// in lockstep and pads the shorter ones with NULL instead of raising, so
// four ids and three hashes writes a NULL hash onto the last row and
// reports success.  columns() builds all four in a single pass and cannot
// produce a mismatch, which is exactly why the check is here rather than
// trusted to stay true -- it costs four comparisons per batch and turns a
// silent corruption into a refusal.
func checkAligned(ids []int32, values, sources, hashes []string) error {
	n := len(ids)
	if len(values) == n && len(sources) == n && len(hashes) == n {
		return nil
	}
	return fmt.Errorf(
		"refusing to write: unnest arrays are not the same length (ids=%d values=%d sources=%d hashes=%d); "+
			"Postgres would pad the short ones with NULL rather than fail",
		n, len(values), len(sources), len(hashes))
}

// batchWriter is the shape of both generated :execrows statements.
type batchWriter func(ctx context.Context, ids []int32, values, sources, hashes []string) (int64, error)

// writeBatch is checkAligned and the statement, in that order.
//
// The order is the whole point, so it lives in one named function rather
// than being spelled out at each of the two call sites: a guard that runs
// after the UPDATE, or that a later edit drops from one of the two
// closures, protects nothing.  Written this way the ordering is a thing a
// test can hold, with a fake statement that records whether it was
// reached.
func writeBatch(ctx context.Context, ids []int32, values, sources, hashes []string, write batchWriter) (int64, error) {
	if err := checkAligned(ids, values, sources, hashes); err != nil {
		return 0, err
	}
	return write(ctx, ids, values, sources, hashes)
}

// applyBatches runs fn over [0,n) in applyBatchSize chunks and sums the
// rows each one actually updated.
func applyBatches(ctx context.Context, n int, fn func(start, end int) (int64, error)) (int64, error) {
	var written int64
	for start := 0; start < n; start += applyBatchSize {
		// Checked before the batch, not after: cancellation should stop
		// the next write, and a check that only runs after the last one
		// can never prevent anything.
		if err := ctx.Err(); err != nil {
			return written, fmt.Errorf("interrupted after %d rows: %w", written, err)
		}
		end := min(start+applyBatchSize, n)
		rows, err := fn(start, end)
		if err != nil {
			return written, fmt.Errorf("batch [%d:%d]: %w", start, end, err)
		}
		written += rows
		slog.Info("batch written", "start", start, "end", end, "rows_updated", rows)
	}
	return written, nil
}

// backupStamp is the timestamp in the backup filename.  One-second
// resolution, which is why writeBackupJSON cannot assume the name is free.
const backupStamp = "20060102T150405Z"

// backupAttempts bounds the search for a free backup filename.  A hundred
// files sharing one second is not an operator re-running a command, it is
// something looping, and spinning on O_EXCL would hide it.
const backupAttempts = 100

// writeBackupJSON writes the pre-apply undo file and never opens one that
// already exists.
//
// os.Create truncates, and the name carries a one-second timestamp, so two
// --apply runs in the same second used to resolve to the same path -- the
// second run emptying the first run's undo file, which is the one file
// this code Syncs, checks Close on, and refuses to proceed without.
// (backfill-out/ is shared with cmd/bgmbackfill, which writes a
// backup-<ts>.json of its own on the same layout, so the collision does
// not even need two hantbackfill runs.)
//
// O_CREATE|O_EXCL|O_WRONLY turns that from data loss into EEXIST.  What is
// done with EEXIST is a suffix rather than a refusal: the operator asked
// to write, the collision is an artefact of this tool's clock resolution
// rather than anything they did wrong, and refusing would leave them
// waiting out a second to retry a production apply.  Both undo files
// survive, which is the property that matters.  Any error that is not
// EEXIST aborts immediately -- a read-only mount or a missing directory is
// not something a different filename fixes, and it has to abort the apply
// rather than be retried a hundred times.
//
// A failure part-way through encoding leaves the partial file where it is.
// Nothing was written to the table (runApply returns before the first
// UPDATE), so it is a diagnostic rather than a trap, and deleting evidence
// of a disk problem is worse than leaving it.
func writeBackupJSON(stamp string, v any) (string, error) {
	for attempt := range backupAttempts {
		path := backupName(stamp, attempt)
		f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
		if errors.Is(err, fs.ErrExist) {
			continue
		}
		if err != nil {
			return "", fmt.Errorf("create %s: %w", path, err)
		}
		if err := encodeSyncClose(path, f, v); err != nil {
			return "", err
		}
		return path, nil
	}
	return "", fmt.Errorf(
		"refusing to write: %d backup filenames for %s are already taken, and overwriting one would destroy the only undo path for the run that made it",
		backupAttempts, stamp)
}

// backupName is backup-<ts>.json, then backup-<ts>-2.json and up.  The
// first attempt keeps the documented name so the ordinary case reads the
// way the package comment says it does.
func backupName(stamp string, attempt int) string {
	if attempt == 0 {
		return fmt.Sprintf("backup-%s.json", stamp)
	}
	return fmt.Sprintf("backup-%s-%d.json", stamp, attempt+1)
}

// writeJSON writes v to path, truncating whatever is there.
//
// That is right for the report, which every run replaces, and wrong for
// the backup, which is why the backup goes through writeBackupJSON
// instead.
//
// The usual `defer f.Close()` is wrong here.  This function writes the
// pre-apply backup, which is the only undo path for a bad --apply run;
// runApply treats a nil return as "the backup is safe" and proceeds to
// the UPDATEs.  A deferred Close discards its error, so a failure that
// only surfaces at close time -- a full disk, an NFS write-back error --
// would let the writes go ahead against a truncated or absent backup.
// Sync then Close, both checked.
func writeJSON(path string, v any) error {
	f, err := os.Create(path)
	if err != nil {
		return fmt.Errorf("create %s: %w", path, err)
	}
	return encodeSyncClose(path, f, v)
}

// syncCloser is the part of *os.File that writeJSON's durability promise
// rests on.  It is an interface so a test can supply a Sync or a Close
// that fails on demand: making a real close(2) fail is not portable, and
// the swallowed-close-error defect this guards against lives in exactly
// that branch.
type syncCloser interface {
	io.Writer
	Sync() error
	Close() error
}

// encodeSyncClose owns everything after the file exists, so that the
// "not nil until the bytes are down" half of the contract is testable
// independently of the filesystem.
func encodeSyncClose(path string, f syncCloser, v any) (err error) {
	defer func() {
		cerr := f.Close()
		if err == nil && cerr != nil {
			err = fmt.Errorf("close %s: %w", path, cerr)
		}
	}()

	enc := json.NewEncoder(f)
	enc.SetIndent("", "  ")
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return fmt.Errorf("encode JSON to %s: %w", path, err)
	}
	if err := f.Sync(); err != nil {
		return fmt.Errorf("sync %s: %w", path, err)
	}
	return nil
}
