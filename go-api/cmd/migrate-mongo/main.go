// Package main is the one-shot MongoDB -> PostgreSQL migration CLI.
//
// This binary reads from the legacy AnimeGo MongoDB dump and writes the
// transformed rows into the new Postgres schema defined in
// go-api/migrations/.  It is run exactly once per migration window
// (P1.D); the live HTTP server in cmd/server never imports this binary.
//
// P1.B scope (this file): CLI flags, env summary, connections,
// orchestration handoff.  Per-collection transforms land in P1.C under
// internal/migrate/transforms/.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"os/signal"
	"runtime/debug"
	"strings"
	"syscall"

	"github.com/lawrenceli0228/animego/go-api/internal/migrate"

	// Blank import: pulls every per-collection transform package so its
	// init() Registers itself with the migrate registry before Run().
	// Without this, migrate.Registered() returns empty and the orchestrator
	// refuses to start.
	_ "github.com/lawrenceli0228/animego/go-api/internal/migrate/transforms"
)

const (
	defaultMongoURI = "mongodb://localhost:27017/animego"
	defaultPGURI    = "postgres://animego:devpassword@localhost:5432/animego?sslmode=disable"
	defaultFailLog  = "./migrate-failures.jsonl"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))
	slog.SetDefault(logger)

	var (
		mongoURI    = flag.String("mongo-uri", defaultMongoURI, "MongoDB connection URI (database name is read from the path)")
		pgURI       = flag.String("pg-uri", envOr("DATABASE_URL", defaultPGURI), "PostgreSQL connection URI")
		dryRun      = flag.Bool("dry-run", false, "read + transform + count, but do NOT write Postgres")
		commit      = flag.Bool("commit", false, "write to Postgres (mutually exclusive with --dry-run)")
		collections = flag.String("collections", "all", `CSV of collection names to run, or "all"`)
		batchSize   = flag.Int("batch-size", 1000, "rows per bulk INSERT")
		failLog     = flag.String("log-failed", defaultFailLog, "per-row failure log path (JSONL)")
		concurrency = flag.Int("concurrency", 4, "parallel Mongo reader goroutines (writes serialized per collection)")
		showVersion = flag.Bool("version", false, "print build info and exit")
	)
	flag.Usage = func() {
		fmt.Fprintf(flag.CommandLine.Output(), "usage: %s [flags]\n\nMongoDB -> PostgreSQL one-shot migration tool.\n\nFlags:\n", os.Args[0])
		flag.PrintDefaults()
	}
	flag.Parse()

	if *showVersion {
		fmt.Println(buildVersion())
		return
	}

	if err := validateFlags(*dryRun, *commit, *batchSize, *concurrency, *failLog); err != nil {
		slog.Error("invalid flags", "err", err)
		os.Exit(2)
	}

	mongoDB, err := extractMongoDB(*mongoURI)
	if err != nil {
		slog.Error("parse mongo uri", "err", err)
		os.Exit(2)
	}

	collList := parseCollections(*collections)
	logEnvSummary(logger, *mongoURI, *pgURI, *dryRun, *commit, collList, *concurrency, *batchSize, *failLog, mongoDB)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	mc, err := migrate.ConnectMongo(ctx, *mongoURI)
	if err != nil {
		slog.Error("mongo connect failed", "err", err)
		os.Exit(1)
	}
	defer func() {
		if err := mc.Disconnect(context.Background()); err != nil {
			slog.Warn("mongo disconnect", "err", err)
		}
	}()

	pg, err := migrate.ConnectPG(ctx, *pgURI)
	if err != nil {
		slog.Error("postgres connect failed", "err", err)
		os.Exit(1)
	}
	defer pg.Close()

	cfg := migrate.Config{
		MongoDatabase: mongoDB,
		DryRun:        *dryRun,
		Commit:        *commit,
		Collections:   collList,
		BatchSize:     *batchSize,
		LogFailedPath: *failLog,
		Concurrency:   *concurrency,
	}
	orch, err := migrate.NewOrchestrator(cfg, logger, mc, pg)
	if err != nil {
		slog.Error("orchestrator init failed", "err", err)
		os.Exit(1)
	}
	defer func() {
		if err := orch.Close(); err != nil {
			slog.Warn("orchestrator close", "err", err)
		}
	}()

	if err := orch.Run(ctx); err != nil {
		if errors.Is(err, migrate.ErrNoTransformsSelected) {
			slog.Error("nothing to do — --collections filter selected no registered transforms")
			os.Exit(2)
		}
		slog.Error("migration failed", "err", err)
		os.Exit(1)
	}
	slog.Info("migration complete", "dry_run", *dryRun, "commit", *commit)
}

func validateFlags(dryRun, commit bool, batchSize, concurrency int, failLog string) error {
	if dryRun == commit {
		return fmt.Errorf("exactly one of --dry-run or --commit must be set (got dry-run=%v commit=%v)", dryRun, commit)
	}
	if batchSize <= 0 {
		return fmt.Errorf("--batch-size must be > 0 (got %d)", batchSize)
	}
	if concurrency <= 0 {
		return fmt.Errorf("--concurrency must be > 0 (got %d)", concurrency)
	}
	if strings.TrimSpace(failLog) == "" {
		return fmt.Errorf("--log-failed must not be empty")
	}
	return nil
}

// extractMongoDB returns the database name embedded in the Mongo URI's
// path component, e.g. mongodb://host/animego -> "animego".  Defaults
// to "animego" if no path is present so local docker-compose URIs work.
func extractMongoDB(uri string) (string, error) {
	u, err := url.Parse(uri)
	if err != nil {
		return "", fmt.Errorf("parse: %w", err)
	}
	name := strings.TrimPrefix(u.Path, "/")
	if name == "" {
		return "animego", nil
	}
	// Strip any auth-source / options that may be appended.
	if i := strings.IndexAny(name, "/?"); i >= 0 {
		name = name[:i]
	}
	return name, nil
}

func parseCollections(csv string) []string {
	csv = strings.TrimSpace(csv)
	if csv == "" || strings.EqualFold(csv, "all") {
		return []string{"all"}
	}
	parts := strings.Split(csv, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

// logEnvSummary prints the effective configuration with passwords masked.
func logEnvSummary(
	logger *slog.Logger,
	mongoURI, pgURI string,
	dryRun, commit bool,
	collections []string,
	concurrency, batchSize int,
	failLog, mongoDB string,
) {
	logger.Info("migrate-mongo configuration",
		"mongo_uri", maskURIPassword(mongoURI),
		"mongo_db", mongoDB,
		"pg_uri", maskURIPassword(pgURI),
		"dry_run", dryRun,
		"commit", commit,
		"collections", collections,
		"concurrency", concurrency,
		"batch_size", batchSize,
		"log_failed", failLog,
		"version", buildVersion(),
	)
}

// maskURIPassword replaces the password component of a URI with "***"
// so it doesn't leak into logs.  Falls back to the original string if
// parsing fails (the connection step will report a clearer error).
func maskURIPassword(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.User == nil {
		return raw
	}
	if _, hasPwd := u.User.Password(); !hasPwd {
		return raw
	}
	u.User = url.UserPassword(u.User.Username(), "***")
	return u.String()
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// buildVersion returns the commit hash recorded in the binary by
// `go build`, or "(dev)" when build info is unavailable (e.g. `go run`).
func buildVersion() string {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return "(dev)"
	}
	var (
		rev      = "unknown"
		modified = ""
	)
	for _, s := range info.Settings {
		switch s.Key {
		case "vcs.revision":
			if s.Value != "" {
				rev = s.Value
			}
		case "vcs.modified":
			if s.Value == "true" {
				modified = "-dirty"
			}
		}
	}
	return fmt.Sprintf("migrate-mongo %s%s (go %s)", rev, modified, info.GoVersion)
}
