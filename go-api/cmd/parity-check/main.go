// Package main is the post-migration field-parity check.
//
// Compares 10 UI-critical fields between the legacy Mongo source
// (animego_prod_copy.animecaches) and the freshly-populated Postgres
// dev DB across a random $sample of anime_cache documents.  Strict
// equality with NULL/absent tolerance — see SEMANTICS in the spec.
//
// Acceptance threshold: each field must match >= 99.9%.  Below that,
// the binary prints FAIL and exits non-zero.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/url"
	"os"
	"sort"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/lawrenceli0228/animego/go-api/internal/migrate"
)

const (
	defaultMongoURI = "mongodb://localhost:27017/animego_prod_copy"
	defaultPGURI    = "postgres://animego:devpassword@localhost:5432/animego?sslmode=disable"
	defaultSample   = 1000
	floatEpsilon    = 0.005 // numeric(4,2) precision
	passThreshold   = 99.9
)

// fieldNames in display order — also the iteration order for report rendering.
var fieldNames = []string{
	"titleChinese",
	"characters[0].nameCn",
	"coverImageColor",
	"posterAccent",
	"startDate",
	"averageScore",
	"bangumiScore",
	"episodeTitles[first].nameCn",
	"studios[*] contains",
	"genres[*] contains",
}

type fieldStat struct {
	Compared int `json:"compared"`
	Match    int `json:"match"`
	Mismatch int `json:"mismatch"`
}

type mismatch struct {
	AnilistID int    `json:"anilist_id"`
	Field     string `json:"field"`
	Mongo     string `json:"mongo"`
	PG        string `json:"pg"`
}

type report struct {
	SampleSize    int                  `json:"sample_size"`
	TotalCompared int                  `json:"total_compared"`
	TotalMatch    int                  `json:"total_match"`
	MatchPct      float64              `json:"match_pct"`
	ByField       map[string]fieldStat `json:"by_field"`
	Mismatches    []mismatch           `json:"mismatches"`
}

func main() {
	// Suppress the migrate package's logger if it leaks; this binary writes
	// human-readable output to stdout and nothing else.
	slog.SetDefault(slog.New(slog.NewTextHandler(io.Discard, nil)))

	var (
		mongoURI = flag.String("mongo-uri", defaultMongoURI, "MongoDB connection URI")
		pgURI    = flag.String("pg-uri", envOr("DATABASE_URL", defaultPGURI), "PostgreSQL connection URI")
		sample   = flag.Int("sample", defaultSample, "number of anime_cache documents to sample")
		jsonOut  = flag.String("json", "", "optional path to write JSON report")
	)
	flag.Parse()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	mc, err := migrate.ConnectMongo(ctx, *mongoURI)
	if err != nil {
		fmt.Fprintf(os.Stderr, "mongo connect: %v\n", err)
		os.Exit(1)
	}
	defer func() { _ = mc.Disconnect(context.Background()) }()

	mongoDB, err := extractMongoDB(*mongoURI)
	if err != nil {
		fmt.Fprintf(os.Stderr, "parse mongo uri: %v\n", err)
		os.Exit(2)
	}

	pg, err := migrate.ConnectPG(ctx, *pgURI)
	if err != nil {
		fmt.Fprintf(os.Stderr, "postgres connect: %v\n", err)
		os.Exit(1)
	}
	defer pg.Close()

	db := mc.Database(mongoDB)
	totalDocs, _ := db.Collection("animecaches").CountDocuments(ctx, bson.M{})

	startedAt := time.Now().UTC()
	fmt.Println("=== animego field-parity report ===")
	fmt.Printf("Mongo: %s\n", maskURI(*mongoURI))
	fmt.Printf("PG:    %s\n", maskURI(*pgURI))
	fmt.Printf("Sample: %d of %d anime_cache documents\n", *sample, totalDocs)
	fmt.Printf("Started: %s\n\n", startedAt.Format(time.RFC3339))

	stats := make(map[string]*fieldStat, len(fieldNames))
	for _, f := range fieldNames {
		stats[f] = &fieldStat{}
	}
	var mismatches []mismatch

	cursor, err := db.Collection("animecaches").Aggregate(ctx, bson.A{
		bson.M{"$sample": bson.M{"size": int64(*sample)}},
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "mongo aggregate: %v\n", err)
		os.Exit(1)
	}
	defer func() { _ = cursor.Close(ctx) }()

	for cursor.Next(ctx) {
		var doc bson.M
		if err := cursor.Decode(&doc); err != nil {
			continue
		}
		anilistID, ok := getInt(doc, "anilistId")
		if !ok {
			continue
		}
		mismatches = compareDoc(ctx, pg, doc, anilistID, stats, mismatches)
	}
	if err := cursor.Err(); err != nil {
		fmt.Fprintf(os.Stderr, "cursor: %v\n", err)
		os.Exit(1)
	}

	// Render table.
	fmt.Printf("%-30s %-10s %-10s %-10s %-10s\n", "Field", "Compared", "Match", "Mismatch", "Match %")
	totalCompared, totalMatch := 0, 0
	allPass := true
	for _, f := range fieldNames {
		st := stats[f]
		pct := pct(st.Match, st.Compared)
		if pct < passThreshold && st.Compared > 0 {
			allPass = false
		}
		fmt.Printf("%-30s %-10d %-10d %-10d %.2f%%\n", f, st.Compared, st.Match, st.Mismatch, pct)
		totalCompared += st.Compared
		totalMatch += st.Match
	}
	totalPct := pct(totalMatch, totalCompared)
	fmt.Println()
	fmt.Printf("%-30s %-10d %-10d %-10d %.2f%%\n", "TOTAL", totalCompared, totalMatch, totalCompared-totalMatch, totalPct)

	// First 20 mismatches.
	fmt.Println()
	fmt.Println("=== first 20 mismatches ===")
	limit := len(mismatches)
	if limit > 20 {
		limit = 20
	}
	for i := 0; i < limit; i++ {
		mm := mismatches[i]
		fmt.Printf("  anilist=%d  field=%s  mongo=%q  pg=%q\n", mm.AnilistID, mm.Field, mm.Mongo, mm.PG)
	}
	fmt.Println()

	if allPass {
		fmt.Printf("PASS  (acceptance threshold: >=%.1f%% per field)\n", passThreshold)
	} else {
		fmt.Printf("FAIL  (acceptance threshold: >=%.1f%% per field)\n", passThreshold)
	}

	// JSON report if requested.
	if *jsonOut != "" {
		byField := make(map[string]fieldStat, len(fieldNames))
		for _, f := range fieldNames {
			byField[f] = *stats[f]
		}
		rep := report{
			SampleSize:    *sample,
			TotalCompared: totalCompared,
			TotalMatch:    totalMatch,
			MatchPct:      round2(totalPct),
			ByField:       byField,
			Mismatches:    mismatches,
		}
		b, err := json.MarshalIndent(rep, "", "  ")
		if err != nil {
			fmt.Fprintf(os.Stderr, "json marshal: %v\n", err)
			os.Exit(1)
		}
		if err := os.WriteFile(*jsonOut, b, 0o644); err != nil {
			fmt.Fprintf(os.Stderr, "json write: %v\n", err)
			os.Exit(1)
		}
	}

	if !allPass {
		os.Exit(1)
	}
}

// compareDoc runs all 10 field comparisons for one sampled document.
// Appends any mismatches to mm and returns the updated slice.
func compareDoc(ctx context.Context, pg *pgxpool.Pool, doc bson.M, anilistID int, stats map[string]*fieldStat, mm []mismatch) []mismatch {
	// Field 1: titleChinese
	mm = cmpStr(mm, stats, anilistID, "titleChinese",
		mongoStr(doc, "titleChinese"),
		pgScalarStr(ctx, pg, "SELECT title_chinese FROM anime_cache WHERE anilist_id=$1", anilistID),
	)

	// Field 2: characters[0].nameCn
	var charCnMongo *string
	if chars, ok := getArray(doc, "characters"); ok && len(chars) > 0 {
		if sub, ok := toSubdoc(chars[0]); ok {
			charCnMongo = mongoStr(sub, "nameCn")
		}
	}
	mm = cmpStr(mm, stats, anilistID, "characters[0].nameCn",
		charCnMongo,
		pgScalarStr(ctx, pg, "SELECT name_cn FROM anime_characters WHERE anime_id=$1 AND display_order=0", anilistID),
	)

	// Field 3: coverImageColor
	mm = cmpStr(mm, stats, anilistID, "coverImageColor",
		mongoStr(doc, "coverImageColor"),
		pgScalarStr(ctx, pg, "SELECT cover_image_color FROM anime_cache WHERE anilist_id=$1", anilistID),
	)

	// Field 4: posterAccent
	mm = cmpStr(mm, stats, anilistID, "posterAccent",
		mongoStr(doc, "posterAccent"),
		pgScalarStr(ctx, pg, "SELECT poster_accent FROM anime_cache WHERE anilist_id=$1", anilistID),
	)

	// Field 5: startDate (composed → Y/M/D ints)
	var mongoDate *time.Time
	if sd, ok := getSubdoc(doc, "startDate"); ok {
		y, _ := getInt(sd, "year")
		m, _ := getInt(sd, "month")
		d, _ := getInt(sd, "day")
		if y > 0 && m > 0 && d > 0 {
			t := time.Date(y, time.Month(m), d, 0, 0, 0, 0, time.UTC)
			mongoDate = &t
		}
	}
	pgDate := pgScalarDate(ctx, pg, "SELECT start_date FROM anime_cache WHERE anilist_id=$1", anilistID)
	mm = cmpDate(mm, stats, anilistID, "startDate", mongoDate, pgDate)

	// Field 6: averageScore
	mm = cmpFloat(mm, stats, anilistID, "averageScore",
		mongoFloat(doc, "averageScore"),
		pgScalarFloat(ctx, pg, "SELECT average_score FROM anime_cache WHERE anilist_id=$1", anilistID),
	)

	// Field 7: bangumiScore
	mm = cmpFloat(mm, stats, anilistID, "bangumiScore",
		mongoFloat(doc, "bangumiScore"),
		pgScalarFloat(ctx, pg, "SELECT bangumi_score FROM anime_cache WHERE anilist_id=$1", anilistID),
	)

	// Field 8: episodeTitles[first].nameCn (dedup last-wins per the transform)
	var epCnMongo *string
	if eps, ok := getArray(doc, "episodeTitles"); ok && len(eps) > 0 {
		seen := make(map[int]int, len(eps))
		titles := make([]bson.M, 0, len(eps))
		for _, e := range eps {
			sub, ok := toSubdoc(e)
			if !ok {
				continue
			}
			epNum, epOK := getInt(sub, "episode")
			if !epOK {
				continue
			}
			if idx, dup := seen[epNum]; dup {
				titles[idx] = sub
			} else {
				seen[epNum] = len(titles)
				titles = append(titles, sub)
			}
		}
		sort.Slice(titles, func(i, j int) bool {
			ai, _ := getInt(titles[i], "episode")
			aj, _ := getInt(titles[j], "episode")
			return ai < aj
		})
		if len(titles) > 0 {
			epCnMongo = mongoStr(titles[0], "nameCn")
		}
	}
	mm = cmpStr(mm, stats, anilistID, "episodeTitles[first].nameCn",
		epCnMongo,
		pgScalarStr(ctx, pg, "SELECT name_cn FROM anime_episode_titles WHERE anime_id=$1 ORDER BY episode ASC LIMIT 1", anilistID),
	)

	// Field 9: studios[*] contains (set semantics)
	mongoStudios := mongoStringArray(doc, "studios")
	mm = cmpContains(mm, stats, anilistID, "studios[*] contains", mongoStudios,
		pgScalarStr(ctx, pg, "SELECT studio FROM anime_studios WHERE anime_id=$1 LIMIT 1", anilistID),
	)

	// Field 10: genres[*] contains (set semantics)
	mongoGenres := mongoStringArray(doc, "genres")
	mm = cmpContains(mm, stats, anilistID, "genres[*] contains", mongoGenres,
		pgScalarStr(ctx, pg, "SELECT genre FROM anime_genres WHERE anime_id=$1 LIMIT 1", anilistID),
	)

	return mm
}

// ----------------- comparison primitives -----------------

func cmpStr(mm []mismatch, stats map[string]*fieldStat, id int, field string, m, p *string) []mismatch {
	st := stats[field]
	st.Compared++
	mAbs, pAbs := m == nil, p == nil
	if mAbs && pAbs {
		st.Match++
		return mm
	}
	if mAbs != pAbs {
		st.Mismatch++
		return append(mm, mismatch{AnilistID: id, Field: field, Mongo: deref(m), PG: deref(p)})
	}
	if *m == *p {
		st.Match++
		return mm
	}
	st.Mismatch++
	return append(mm, mismatch{AnilistID: id, Field: field, Mongo: *m, PG: *p})
}

func cmpFloat(mm []mismatch, stats map[string]*fieldStat, id int, field string, m, p *float64) []mismatch {
	st := stats[field]
	st.Compared++
	mAbs, pAbs := m == nil, p == nil
	if mAbs && pAbs {
		st.Match++
		return mm
	}
	if mAbs != pAbs {
		st.Mismatch++
		return append(mm, mismatch{AnilistID: id, Field: field, Mongo: floatStr(m), PG: floatStr(p)})
	}
	if math.Abs(*m-*p) < floatEpsilon {
		st.Match++
		return mm
	}
	st.Mismatch++
	return append(mm, mismatch{AnilistID: id, Field: field, Mongo: floatStr(m), PG: floatStr(p)})
}

func cmpDate(mm []mismatch, stats map[string]*fieldStat, id int, field string, m, p *time.Time) []mismatch {
	st := stats[field]
	st.Compared++
	mAbs, pAbs := m == nil, p == nil
	if mAbs && pAbs {
		st.Match++
		return mm
	}
	if mAbs != pAbs {
		st.Mismatch++
		return append(mm, mismatch{AnilistID: id, Field: field, Mongo: dateStr(m), PG: dateStr(p)})
	}
	if m.Year() == p.Year() && m.Month() == p.Month() && m.Day() == p.Day() {
		st.Match++
		return mm
	}
	st.Mismatch++
	return append(mm, mismatch{AnilistID: id, Field: field, Mongo: dateStr(m), PG: dateStr(p)})
}

// cmpContains: pg picks any element from the unordered set via LIMIT 1;
// pass when pg's pick is present in the Mongo array (or both absent).
func cmpContains(mm []mismatch, stats map[string]*fieldStat, id int, field string, mongoArr []string, p *string) []mismatch {
	st := stats[field]
	st.Compared++
	mAbs, pAbs := len(mongoArr) == 0, p == nil
	if mAbs && pAbs {
		st.Match++
		return mm
	}
	if mAbs != pAbs {
		st.Mismatch++
		return append(mm, mismatch{AnilistID: id, Field: field, Mongo: fmt.Sprintf("%v", mongoArr), PG: deref(p)})
	}
	for _, v := range mongoArr {
		if v == *p {
			st.Match++
			return mm
		}
	}
	st.Mismatch++
	return append(mm, mismatch{AnilistID: id, Field: field, Mongo: fmt.Sprintf("%v", mongoArr), PG: *p})
}

// ----------------- Mongo extractors -----------------

func mongoStr(m bson.M, key string) *string {
	v, ok := m[key]
	if !ok || v == nil {
		return nil
	}
	s, ok := v.(string)
	if !ok || s == "" {
		return nil
	}
	return &s
}

func mongoFloat(m bson.M, key string) *float64 {
	v, ok := m[key]
	if !ok || v == nil {
		return nil
	}
	switch n := v.(type) {
	case float64:
		return &n
	case int:
		f := float64(n)
		return &f
	case int32:
		f := float64(n)
		return &f
	case int64:
		f := float64(n)
		return &f
	}
	return nil
}

func mongoStringArray(m bson.M, key string) []string {
	arr, ok := getArray(m, key)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(arr))
	for _, v := range arr {
		if s, ok := v.(string); ok && s != "" {
			out = append(out, s)
		}
	}
	return out
}

// ----------------- PG extractors -----------------

func pgScalarStr(ctx context.Context, pg *pgxpool.Pool, sql string, args ...any) *string {
	var s *string
	err := pg.QueryRow(ctx, sql, args...).Scan(&s)
	if err != nil {
		return nil // no row OR NULL — both map to absent
	}
	if s != nil && *s == "" {
		return nil
	}
	return s
}

func pgScalarFloat(ctx context.Context, pg *pgxpool.Pool, sql string, args ...any) *float64 {
	var f *float64
	if err := pg.QueryRow(ctx, sql, args...).Scan(&f); err != nil {
		return nil
	}
	return f
}

func pgScalarDate(ctx context.Context, pg *pgxpool.Pool, sql string, args ...any) *time.Time {
	var t *time.Time
	if err := pg.QueryRow(ctx, sql, args...).Scan(&t); err != nil {
		return nil
	}
	return t
}

// ----------------- bson helpers (subset of transforms/util.go) -----------------

func getInt(m bson.M, key string) (int, bool) {
	v, ok := m[key]
	if !ok || v == nil {
		return 0, false
	}
	switch n := v.(type) {
	case int:
		return n, true
	case int32:
		return int(n), true
	case int64:
		return int(n), true
	case float64:
		return int(n), true
	}
	return 0, false
}

func getArray(m bson.M, key string) (bson.A, bool) {
	v, ok := m[key]
	if !ok || v == nil {
		return nil, false
	}
	switch a := v.(type) {
	case bson.A:
		return a, true
	case []any:
		return bson.A(a), true
	}
	return nil, false
}

func getSubdoc(m bson.M, key string) (bson.M, bool) {
	v, ok := m[key]
	if !ok || v == nil {
		return nil, false
	}
	switch s := v.(type) {
	case bson.M:
		return s, true
	case bson.D:
		out := make(bson.M, len(s))
		for _, e := range s {
			out[e.Key] = e.Value
		}
		return out, true
	case map[string]any:
		return bson.M(s), true
	}
	return nil, false
}

func toSubdoc(v any) (bson.M, bool) {
	switch s := v.(type) {
	case bson.M:
		return s, true
	case bson.D:
		out := make(bson.M, len(s))
		for _, e := range s {
			out[e.Key] = e.Value
		}
		return out, true
	case map[string]any:
		return bson.M(s), true
	}
	return nil, false
}

// ----------------- misc -----------------

func deref(s *string) string {
	if s == nil {
		return "<absent>"
	}
	return *s
}

func floatStr(f *float64) string {
	if f == nil {
		return "<absent>"
	}
	return fmt.Sprintf("%.4f", *f)
}

func dateStr(t *time.Time) string {
	if t == nil {
		return "<absent>"
	}
	return t.Format("2006-01-02")
}

func pct(num, denom int) float64 {
	if denom == 0 {
		return 100.0
	}
	return float64(num) / float64(denom) * 100.0
}

func round2(f float64) float64 {
	return math.Round(f*100) / 100
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func extractMongoDB(uri string) (string, error) {
	u, err := url.Parse(uri)
	if err != nil {
		return "", err
	}
	name := u.Path
	if len(name) > 0 && name[0] == '/' {
		name = name[1:]
	}
	if name == "" {
		return "animego", nil
	}
	return name, nil
}

func maskURI(raw string) string {
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

// Compile-time guard so a future refactor that drops mongo.Database surface still fails fast here.
var _ = (*mongo.Client)(nil)
