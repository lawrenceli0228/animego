package admin

// list_enrichment.go — SQL building + execution for
// /api/admin/enrichment.  Separated from read.go so the WHERE-clause
// + ORDER BY composition can be unit-tested without touching the
// HTTP layer.
//
// Why not sqlc:  the filter + q + sort + order matrix produces
// (5 filters × ~7 sort fields × 2 directions × q-on/off) ~140
// distinct query variants.  Express composes them dynamically via
// Mongoose; we mirror that with a bytes.Buffer + parameter slice.
// A column-name allow-list guards the only string interpolation
// point (ORDER BY column).

import (
	"bytes"
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/sync/errgroup"
)

// enrichmentListParams carries the parsed query-string inputs of
// ListEnrichment.  Page is already normalised to ≥1 by parsePage;
// the rest are passed through verbatim and parsed inside the SQL
// builder so the builder owns the entire input-to-SQL transform.
type enrichmentListParams struct {
	Page      int
	Filter    string
	Query     string
	SortField string
	SortOrder string
}

// enrichmentSortColumns is the allow-list of PG columns the API
// accepts as ?sort=.  Keys are the Express public name; values are
// the actual PG column.  Anything outside this map falls back to the
// default sort (cached_at DESC).
//
// The cachedAt → cached_at alias preserves Express's camelCase API
// surface.  All other names match between Express and Postgres after
// the implicit camelCase ↔ snake_case mapping that the Mongoose
// schema uses for the same fields.
var enrichmentSortColumns = map[string]string{
	"cachedAt":        "cached_at",
	"cached_at":       "cached_at",
	"title_chinese":   "title_chinese",
	"titleChinese":    "title_chinese",
	"title_romaji":    "title_romaji",
	"titleRomaji":     "title_romaji",
	"bangumi_version": "bangumi_version",
	"bangumiVersion":  "bangumi_version",
	"bangumi_score":   "bangumi_score",
	"bangumiScore":    "bangumi_score",
	"anilist_id":      "anilist_id",
	"anilistId":       "anilist_id",
}

// buildEnrichmentListSQL composes the page-fetch SQL + parameter
// slice for the given inputs.  Returns the SQL text, the param
// slice, and the corresponding COUNT(*) SQL (which shares the WHERE
// clause but skips ORDER BY / LIMIT / OFFSET).
//
// The exported helper is testable directly — list_enrichment_test.go
// drives it through every filter / q / sort / order branch without
// needing a live DB.
func buildEnrichmentListSQL(p enrichmentListParams) (listSQL string, countSQL string, args []any) {
	const projection = `anilist_id, title_romaji, title_chinese, bgm_id, bangumi_version, bangumi_score, admin_flag`
	const tableName = `anime_cache`

	args = make([]any, 0, 4)
	var where bytes.Buffer
	nextParam := 1
	addParam := func(v any) string {
		args = append(args, v)
		idx := nextParam
		nextParam++
		return "$" + strconv.Itoa(idx)
	}

	conditions := make([]string, 0, 3)

	// Filter clause (mutually exclusive across the four named values).
	switch p.Filter {
	case "needs-review":
		conditions = append(conditions, "admin_flag = "+addParam("needs-review"))
	case "manually-corrected":
		conditions = append(conditions, "admin_flag = "+addParam("manually-corrected"))
	case "unenriched":
		conditions = append(conditions, "bangumi_version = "+addParam(int32(0)))
	case "no-cn":
		conditions = append(conditions, "bgm_id IS NOT NULL AND title_chinese IS NULL")
	}

	// Search clause.  Trim only the trailing whitespace pair Express's
	// `(req.query.q || '').trim()` would strip — keep matching Express
	// even when the caller passes e.g. "  123  ".
	if q := strings.TrimSpace(p.Query); q != "" {
		if isStrictInteger(q) {
			n, _ := strconv.Atoi(q) // safe — isStrictInteger guarantees
			conditions = append(conditions, "anilist_id = "+addParam(int32(n)))
		} else {
			pattern := "%" + escapeLikePattern(q) + "%"
			placeholder := addParam(pattern)
			conditions = append(conditions,
				"(title_romaji ILIKE "+placeholder+
					" OR title_chinese ILIKE "+placeholder+
					" OR title_native ILIKE "+placeholder+")",
			)
		}
	}

	if len(conditions) > 0 {
		where.WriteString(" WHERE ")
		where.WriteString(strings.Join(conditions, " AND "))
	}

	sortCol, ok := enrichmentSortColumns[p.SortField]
	if !ok {
		sortCol = "cached_at"
	}
	direction := "DESC"
	if p.SortOrder == "asc" {
		direction = "ASC"
	}

	skip := (p.Page - 1) * pageSize

	// Use fmt.Sprintf only for the static parts + ORDER BY (allow-listed).
	// User values are NEVER injected as text — they all flow through
	// addParam → numbered placeholders.
	listSQL = fmt.Sprintf(
		"SELECT %s FROM %s%s ORDER BY %s %s LIMIT %d OFFSET %d",
		projection, tableName, where.String(), sortCol, direction, pageSize, skip,
	)
	countSQL = "SELECT count(*)::bigint FROM " + tableName + where.String()

	return listSQL, countSQL, args
}

// isStrictInteger reports whether s represents a non-empty,
// optionally-signed base-10 integer that round-trips through
// strconv.Atoi → strconv.Itoa unchanged.  Mirrors Express's
// `!isNaN(num) && String(num) === q` test which rejects e.g.
// "01" (leading zero), "1.0" (non-integer), and " 1" (whitespace).
func isStrictInteger(s string) bool {
	n, err := strconv.Atoi(s)
	if err != nil {
		return false
	}
	return strconv.Itoa(n) == s
}

// escapeLikePattern escapes characters that have special meaning in
// SQL LIKE patterns:  percent, underscore, and the escape character
// itself.  Postgres uses backslash as the default LIKE escape.
//
// Express does `q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')` to escape
// regex metacharacters before constructing the Mongo regex.  The
// Postgres replacement is different (LIKE has only %, _, \) so we
// translate accordingly — the goal is identical: a search term
// containing wildcards matches them literally.
func escapeLikePattern(s string) string {
	if s == "" {
		return s
	}
	// Manual loop is ~2x faster than strings.NewReplacer for short
	// strings and avoids the regex setup cost a regexp.MustCompile
	// would incur per call.
	var b strings.Builder
	b.Grow(len(s) + 8)
	for _, r := range s {
		if r == '%' || r == '_' || r == '\\' {
			b.WriteByte('\\')
		}
		b.WriteRune(r)
	}
	return b.String()
}

// runEnrichmentList executes the page-fetch + COUNT in parallel and
// returns the materialised slice + total.  Separated from the
// handler so tests can exercise the full SQL path against a real PG
// without going through HTTP.
func runEnrichmentList(ctx context.Context, pool *pgxpool.Pool, p enrichmentListParams) ([]enrichmentItem, int64, error) {
	listSQL, countSQL, args := buildEnrichmentListSQL(p)

	var (
		items []enrichmentItem
		total int64
	)
	g, gctx := errgroup.WithContext(ctx)
	g.Go(func() error {
		rows, err := pool.Query(gctx, listSQL, args...)
		if err != nil {
			return fmt.Errorf("enrichment list query: %w", err)
		}
		defer rows.Close()
		for rows.Next() {
			var it enrichmentItem
			if err := rows.Scan(
				&it.AnilistID,
				&it.TitleRomaji,
				&it.TitleChinese,
				&it.BgmID,
				&it.BangumiVersion,
				&it.BangumiScore,
				&it.AdminFlag,
			); err != nil {
				return fmt.Errorf("enrichment list scan: %w", err)
			}
			items = append(items, it)
		}
		return rows.Err()
	})
	g.Go(func() error {
		if err := pool.QueryRow(gctx, countSQL, args...).Scan(&total); err != nil {
			return fmt.Errorf("enrichment list count: %w", err)
		}
		return nil
	})
	if err := g.Wait(); err != nil {
		return nil, 0, err
	}
	if items == nil {
		items = []enrichmentItem{}
	}
	return items, total, nil
}
