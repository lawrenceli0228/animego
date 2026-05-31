// cmd/bgmbackfill — one-time re-validation of every existing bgm-bound
// anime row.  Cross-checks each binding against (a) the authoritative
// id-map and (b) dandanplay (an independent Chinese source).
//
// Usage:
//
//	bgmbackfill [--report] [--apply] [--limit N] [--skip-ddp] [--out FILE]
//
// --report (default): READ-ONLY.  Classify all rows, print a summary table
//
//	to stdout, and write a JSON report to --out (default report.json).
//
// --apply: Classify, back up REBIND+QUARANTINE rows to backup-<ts>.json,
//
//	then call BackfillResetRows on those anilist_ids in 500-row batches.
//	HEAL rows are reported but NOT auto-applied.
//
// --limit N: cap the number of live dandanplay API calls this run (0=all).
// --skip-ddp: id-map-only pass — no dandanplay calls, fast.
// --out FILE: report JSON path (default report.json).
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/lawrenceli0228/animego/go-api/internal/config"
	"github.com/lawrenceli0228/animego/go-api/internal/dandanplay"
	"github.com/lawrenceli0228/animego/go-api/internal/db"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// ─── report types ────────────────────────────────────────────────────────────

// sampleRow is one entry in the per-class sample list.
type sampleRow struct {
	AnilistID int32   `json:"anilist_id"`
	BgmID     *int32  `json:"bgm_id"`
	OurNative *string `json:"our_native,omitempty"`
	OurCN     *string `json:"our_cn,omitempty"`
	DdpTitle  *string `json:"ddp_title,omitempty"`
	IdMapBgm  *int32  `json:"id_map_bgm,omitempty"`
}

// classSummary is the per-class section in the JSON report.
type classSummary struct {
	Count   int         `json:"count"`
	Pct     float64     `json:"pct"`
	Samples []sampleRow `json:"samples"`
}

// report is the top-level JSON report written to --out.
type report struct {
	GeneratedAt time.Time               `json:"generated_at"`
	TotalRows   int                     `json:"total_rows"`
	Classes     map[string]classSummary `json:"classes"`
}

// ─── backup type ─────────────────────────────────────────────────────────────

// backupRow carries the full row data for the backup JSON in --apply mode.
type backupRow struct {
	AnilistID      int32    `json:"anilist_id"`
	BgmID          *int32   `json:"bgm_id"`
	TitleNative    *string  `json:"title_native,omitempty"`
	TitleRomaji    *string  `json:"title_romaji,omitempty"`
	TitleEnglish   *string  `json:"title_english,omitempty"`
	TitleChinese   *string  `json:"title_chinese,omitempty"`
	SeasonYear     *int32   `json:"season_year,omitempty"`
	Episodes       *int32   `json:"episodes,omitempty"`
	BangumiScore   *float64 `json:"bangumi_score,omitempty"`
	BgmMatchSource *string  `json:"bgm_match_source,omitempty"`
	Class          string   `json:"class"`
}

// ─── classification result ────────────────────────────────────────────────────

type classified struct {
	row      dbgen.ListBgmBoundForBackfillRow
	class    string
	ddpTitle *string
	idMapBgm *int32
}

// ─── main ─────────────────────────────────────────────────────────────────────

func main() {
	applyMode := flag.Bool("apply", false, "mutate prod: reset REBIND+QUARANTINE rows")
	reportMode := flag.Bool("report", false, "read-only report (default when neither flag is set)")
	limitFlag := flag.Int("limit", 0, "cap dandanplay API calls this run (0=all)")
	skipDDP := flag.Bool("skip-ddp", false, "id-map-only pass, skip dandanplay calls")
	outFile := flag.String("out", "report.json", "path for the JSON report")
	healMode := flag.Bool("heal", false, "WRITES: fill title_chinese from dandanplay for map-confirmed rows missing CN")
	flag.Parse()

	// Default to report mode when no explicit mode is set.
	if !*applyMode && !*reportMode && !*healMode {
		*reportMode = true
	}

	if *applyMode {
		fmt.Fprintln(os.Stderr, "WARNING: --apply will mutate production rows (BackfillResetRows). Proceeding...")
	}
	if *healMode {
		fmt.Fprintln(os.Stderr, "WARNING: --heal will WRITE title_chinese to production rows. Proceeding...")
	}

	ctx := context.Background()

	// ── DB pool ──────────────────────────────────────────────────────────
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

	// ── dandanplay client ─────────────────────────────────────────────────
	var ddpClient *dandanplay.Client
	if !*skipDDP {
		ddpClient, err = dandanplay.NewClient(
			dandanplay.WithCredentials(
				os.Getenv("DANDANPLAY_APP_ID"),
				os.Getenv("DANDANPLAY_APP_SECRET"),
			),
		)
		if err != nil {
			slog.Error("dandanplay client init failed", "err", err)
			os.Exit(1)
		}
		defer ddpClient.Close()
	}

	// ── heal mode: fill CN from dandanplay for map-confirmed rows ─────────
	// Distinct from the classify flow — it targets a different row set
	// (ListIdMapRowsMissingCn) and writes title_chinese, so it returns early.
	if *healMode {
		if *skipDDP || ddpClient == nil {
			slog.Error("--heal needs dandanplay; do not combine with --skip-ddp")
			os.Exit(1)
		}
		if err := runHeal(ctx, q, ddpClient, *limitFlag); err != nil {
			slog.Error("heal failed", "err", err)
			os.Exit(1)
		}
		return
	}

	// ── fetch all bgm-bound rows ──────────────────────────────────────────
	slog.Info("fetching bgm-bound rows from DB")
	rows, err := q.ListBgmBoundForBackfill(ctx)
	if err != nil {
		slog.Error("ListBgmBoundForBackfill failed", "err", err)
		os.Exit(1)
	}
	total := len(rows)
	slog.Info("rows fetched", "total", total)

	// ── classify all rows ─────────────────────────────────────────────────
	results, err := classifyAll(ctx, q, ddpClient, rows, *skipDDP, *limitFlag)
	if err != nil {
		slog.Error("classification failed", "err", err)
		os.Exit(1)
	}

	// ── build counts ─────────────────────────────────────────────────────
	counts := map[string]int{
		ClassAGREE:      0,
		ClassREBIND:     0,
		ClassQUARANTINE: 0,
		ClassHEAL:       0,
	}
	for _, r := range results {
		counts[r.class]++
	}

	// ── print summary table ───────────────────────────────────────────────
	printSummary(total, counts)

	// ── write JSON report ─────────────────────────────────────────────────
	rep := buildReport(total, results, counts)
	if err := writeJSON(*outFile, rep); err != nil {
		slog.Error("write report failed", "err", err, "path", *outFile)
		os.Exit(1)
	}
	slog.Info("report written", "path", *outFile)

	// ── apply mode: backup + reset ────────────────────────────────────────
	if *applyMode {
		if err := runApply(ctx, q, results); err != nil {
			slog.Error("apply failed", "err", err)
			os.Exit(1)
		}
	}
}

// ─── classifyAll ──────────────────────────────────────────────────────────────

// classifyAll iterates all rows, fetches id-map + dandanplay data, and
// returns the full classified list.  ddpClient may be nil when skipDDP=true.
// limitDDP caps the number of live dandanplay API calls (0=unlimited).
func classifyAll(
	ctx context.Context,
	q *dbgen.Queries,
	ddpClient *dandanplay.Client,
	rows []dbgen.ListBgmBoundForBackfillRow,
	skipDDP bool,
	limitDDP int,
) ([]classified, error) {
	results := make([]classified, 0, len(rows))
	ddpCallsMade := 0

	for i, row := range rows {
		if i > 0 && i%200 == 0 {
			slog.Info("classification progress",
				"processed", i,
				"total", len(rows),
				"ddp_api_calls", ddpCallsMade,
			)
		}

		// 1. id-map lookup.
		var idMapBgm *int32
		mappedID, err := q.LookupBgmIdMap(ctx, row.AnilistID)
		if err != nil && err != pgx.ErrNoRows {
			return nil, fmt.Errorf("LookupBgmIdMap anilist_id=%d: %w", row.AnilistID, err)
		}
		if err == nil {
			idMapBgm = &mappedID
		}

		// 2. dandanplay title (cache → API → cache write).
		var ddpTitle *string
		if !skipDDP && row.BgmID != nil {
			// Only fetch dandanplay when id-map is absent (the hot path that
			// actually needs the independent signal).  If id-map confirmed or
			// rebound, we can skip the API call entirely.
			if idMapBgm == nil {
				t, apiCalled, err := resolveDdpTitle(ctx, q, ddpClient, *row.BgmID, limitDDP, ddpCallsMade)
				if err != nil {
					// Non-fatal: log and continue with nil title.
					slog.Warn("dandanplay title resolve failed",
						"bgm_id", *row.BgmID,
						"err", err,
					)
				} else {
					ddpTitle = t
					if apiCalled {
						ddpCallsMade++
					}
				}
			}
		}

		// 3. Classify using the pure function.
		dr := dbRow{
			AnilistID:    row.AnilistID,
			BgmID:        row.BgmID,
			TitleNative:  row.TitleNative,
			TitleRomaji:  row.TitleRomaji,
			TitleEnglish: row.TitleEnglish,
			TitleChinese: row.TitleChinese,
		}
		class := classify(dr, idMapBgm, ddpTitle)

		results = append(results, classified{
			row:      row,
			class:    class,
			ddpTitle: ddpTitle,
			idMapBgm: idMapBgm,
		})
	}

	slog.Info("classification complete",
		"total", len(rows),
		"ddp_api_calls", ddpCallsMade,
	)
	return results, nil
}

// resolveDdpTitle returns the dandanplay title for a bgm_id, using the
// DB cache.  Returns (title, apiCalled, err).  title==nil means confirmed
// not found.  apiCalled is true only when a live network request was made.
func resolveDdpTitle(
	ctx context.Context,
	q *dbgen.Queries,
	ddpClient *dandanplay.Client,
	bgmID int32,
	limitDDP, ddpCallsMade int,
) (*string, bool, error) {
	// Check cache first.
	cached, err := q.GetDdpTitle(ctx, bgmID)
	if err != nil && err != pgx.ErrNoRows {
		return nil, false, fmt.Errorf("GetDdpTitle bgm_id=%d: %w", bgmID, err)
	}
	if err == nil {
		// Cache hit: return cached title (may be nil = confirmed miss).
		return cached.AnimeTitle, false, nil
	}

	// Cache miss: call API if within limit.
	if limitDDP > 0 && ddpCallsMade >= limitDDP {
		// Limit reached — treat as no data (AGREE by absence).
		return nil, false, nil
	}

	ep, err := ddpClient.FetchEpisodesByBgmID(ctx, bgmID)
	if err != nil {
		return nil, true, fmt.Errorf("FetchEpisodesByBgmID bgm_id=%d: %w", bgmID, err)
	}

	// ep==nil means dandanplay has no record (4xx / bangumi=null).
	var title *string
	if ep != nil && ep.Title != "" {
		t := ep.Title
		title = &t
	}

	// Write to cache (nil title = confirmed miss).
	if err := q.UpsertDdpTitle(ctx, bgmID, title); err != nil {
		// Cache write failure is non-fatal; log and proceed.
		slog.Warn("UpsertDdpTitle failed", "bgm_id", bgmID, "err", err)
	}

	return title, true, nil
}

// ─── heal ─────────────────────────────────────────────────────────────────────

// runHeal fills title_chinese from dandanplay for rows whose current bgm_id
// is the authoritative id-map binding but that lack a Chinese name. Safe
// precisely because the binding is map-confirmed — a fuzzy/uncertain bind is
// never healed (its dandanplay title could belong to the wrong subject).
// WRITES title_chinese (guarded on NULL by HealCnTitle).
func runHeal(ctx context.Context, q *dbgen.Queries, ddpClient *dandanplay.Client, limitDDP int) error {
	targets, err := q.ListIdMapRowsMissingCn(ctx)
	if err != nil {
		return fmt.Errorf("ListIdMapRowsMissingCn: %w", err)
	}
	slog.Info("heal candidates (map-confirmed, missing CN)", "count", len(targets))

	var healed, noTitle, errs, ddpCalls int
	for i, t := range targets {
		if i > 0 && i%200 == 0 {
			slog.Info("heal progress", "processed", i, "total", len(targets),
				"healed", healed, "ddp_api_calls", ddpCalls)
		}
		if t.BgmID == nil {
			continue // defensive: the id-map JOIN guarantees a non-null bgm_id
		}
		title, apiCalled, err := resolveDdpTitle(ctx, q, ddpClient, *t.BgmID, limitDDP, ddpCalls)
		if apiCalled {
			ddpCalls++
		}
		if err != nil {
			slog.Warn("heal ddp resolve failed", "anilist_id", t.AnilistID, "bgm_id", *t.BgmID, "err", err)
			errs++
			continue
		}
		if title == nil {
			noTitle++
			continue
		}
		if err := q.HealCnTitle(ctx, t.AnilistID, title); err != nil {
			slog.Warn("HealCnTitle failed", "anilist_id", t.AnilistID, "err", err)
			errs++
			continue
		}
		healed++
	}

	fmt.Printf("\nHeal complete (dandanplay → title_chinese, map-confirmed rows only):\n")
	fmt.Printf("  candidates:       %d\n", len(targets))
	fmt.Printf("  healed:           %d\n", healed)
	fmt.Printf("  no dandanplay CN: %d\n", noTitle)
	fmt.Printf("  errors:           %d\n", errs)
	fmt.Printf("  dandanplay calls: %d\n\n", ddpCalls)
	return nil
}

// ─── summary / report ─────────────────────────────────────────────────────────

func printSummary(total int, counts map[string]int) {
	fmt.Printf("\n%-12s %8s %8s\n", "CLASS", "COUNT", "PCT")
	fmt.Printf("%-12s %8s %8s\n", "─────────────", "────────", "────────")
	for _, class := range []string{ClassAGREE, ClassREBIND, ClassQUARANTINE, ClassHEAL} {
		n := counts[class]
		pct := 0.0
		if total > 0 {
			pct = float64(n) / float64(total) * 100
		}
		fmt.Printf("%-12s %8d %7.1f%%\n", class, n, pct)
	}
	fmt.Printf("%-12s %8d\n\n", "TOTAL", total)
}

const maxSamples = 50

func buildReport(total int, results []classified, counts map[string]int) report {
	samples := map[string][]sampleRow{
		ClassAGREE:      {},
		ClassREBIND:     {},
		ClassQUARANTINE: {},
		ClassHEAL:       {},
	}

	for _, r := range results {
		bucket := samples[r.class]
		if len(bucket) < maxSamples {
			samples[r.class] = append(bucket, sampleRow{
				AnilistID: r.row.AnilistID,
				BgmID:     r.row.BgmID,
				OurNative: r.row.TitleNative,
				OurCN:     r.row.TitleChinese,
				DdpTitle:  r.ddpTitle,
				IdMapBgm:  r.idMapBgm,
			})
		}
	}

	classes := make(map[string]classSummary, 4)
	for _, class := range []string{ClassAGREE, ClassREBIND, ClassQUARANTINE, ClassHEAL} {
		n := counts[class]
		pct := 0.0
		if total > 0 {
			pct = float64(n) / float64(total) * 100
		}
		classes[class] = classSummary{
			Count:   n,
			Pct:     pct,
			Samples: samples[class],
		}
	}

	return report{
		GeneratedAt: time.Now().UTC(),
		TotalRows:   total,
		Classes:     classes,
	}
}

// ─── apply ────────────────────────────────────────────────────────────────────

const applyBatchSize = 500

func runApply(ctx context.Context, q *dbgen.Queries, results []classified) error {
	// Collect REBIND and QUARANTINE ids.
	var rebindIDs, quarantineIDs []int32
	var backupRows []backupRow

	for _, r := range results {
		if r.class != ClassREBIND && r.class != ClassQUARANTINE {
			continue
		}
		backupRows = append(backupRows, backupRow{
			AnilistID:      r.row.AnilistID,
			BgmID:          r.row.BgmID,
			TitleNative:    r.row.TitleNative,
			TitleRomaji:    r.row.TitleRomaji,
			TitleEnglish:   r.row.TitleEnglish,
			TitleChinese:   r.row.TitleChinese,
			SeasonYear:     r.row.SeasonYear,
			Episodes:       r.row.Episodes,
			BangumiScore:   r.row.BangumiScore,
			BgmMatchSource: r.row.BgmMatchSource,
			Class:          r.class,
		})
		if r.class == ClassREBIND {
			rebindIDs = append(rebindIDs, r.row.AnilistID)
		} else {
			quarantineIDs = append(quarantineIDs, r.row.AnilistID)
		}
	}

	// Count HEAL rows for the operator summary.
	healCount := 0
	for _, r := range results {
		if r.class == ClassHEAL {
			healCount++
		}
	}

	// Write backup before touching anything.
	backupPath := fmt.Sprintf("backup-%s.json", time.Now().UTC().Format("20060102T150405Z"))
	if err := writeJSON(backupPath, backupRows); err != nil {
		return fmt.Errorf("write backup: %w", err)
	}
	slog.Info("backup written", "path", backupPath, "rows", len(backupRows))

	// Reset REBIND rows.
	rebindReset, err := resetBatch(ctx, q, rebindIDs)
	if err != nil {
		return fmt.Errorf("reset REBIND rows: %w", err)
	}

	// Reset QUARANTINE rows.
	quarantineReset, err := resetBatch(ctx, q, quarantineIDs)
	if err != nil {
		return fmt.Errorf("reset QUARANTINE rows: %w", err)
	}

	fmt.Printf("\nApply complete:\n")
	fmt.Printf("  %-12s  %d rows reset\n", ClassREBIND, rebindReset)
	fmt.Printf("  %-12s  %d rows reset\n", ClassQUARANTINE, quarantineReset)
	fmt.Printf("  %-12s  %d rows found — NOT auto-applied (follow-up required)\n", ClassHEAL, healCount)
	fmt.Printf("  Backup:  %s\n\n", backupPath)

	return nil
}

// resetBatch calls BackfillResetRows in applyBatchSize chunks.
// Returns the total number of ids submitted.
func resetBatch(ctx context.Context, q *dbgen.Queries, ids []int32) (int, error) {
	for start := 0; start < len(ids); start += applyBatchSize {
		end := start + applyBatchSize
		if end > len(ids) {
			end = len(ids)
		}
		batch := ids[start:end]
		if err := q.BackfillResetRows(ctx, batch); err != nil {
			return start, fmt.Errorf("BackfillResetRows batch [%d:%d]: %w", start, end, err)
		}
		slog.Info("batch reset", "start", start, "end", end)
	}
	return len(ids), nil
}

// ─── helpers ──────────────────────────────────────────────────────────────────

func writeJSON(path string, v any) error {
	f, err := os.Create(path)
	if err != nil {
		return fmt.Errorf("create %s: %w", path, err)
	}
	defer f.Close()
	enc := json.NewEncoder(f)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		return fmt.Errorf("encode JSON to %s: %w", path, err)
	}
	return nil
}
