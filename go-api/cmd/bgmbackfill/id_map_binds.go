// id_map_binds.go — read-only preview of the id-map bind sweep.
//
// The sweep itself (internal/queue/bgm_bind_idmap.go) runs inside the server,
// because the enrichment it dispatches has to draw on the process-local
// Bangumi token bucket.  This is the half a human can run first: it prints
// exactly what that sweep would bind and, more usefully, what it would refuse
// and why.
//
// It writes nothing, and there is deliberately no --apply here.  A wrong
// bgm_id does not fail loudly; it puts another show's Chinese title and
// synopsis on a public page, and anime_cache.bgm_id has no unique index to
// stop a second row claiming a subject.  Keeping the only writer behind the
// sweep's single-slot queue is what makes that race unreachable, so this
// command stays a reader.
package main

import (
	"context"
	"fmt"
	"sort"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// idMapBindLister is the read surface this report needs.
type idMapBindLister interface {
	ListIdMapBindCandidates(ctx context.Context) ([]dbgen.ListIdMapBindCandidatesRow, error)
}

// verdict values the query emits.  Restated here so a rename on either side
// fails a test rather than silently emptying a section of the report.
const (
	verdictBindable      = "bindable"
	verdictAlreadyBound  = "subject-already-bound"
	verdictClaimedTwice  = "subject-claimed-twice"
	sampleRowsPerVerdict = 10
)

// runIdMapBindReport prints the verdict breakdown and a sample of each
// refusal.  Samples matter more than the counts: the counts say how much the
// sweep would do, the samples are what let someone judge whether it should.
func runIdMapBindReport(ctx context.Context, q idMapBindLister) error {
	rows, err := q.ListIdMapBindCandidates(ctx)
	if err != nil {
		return fmt.Errorf("list id-map bind candidates: %w", err)
	}

	byVerdict := map[string][]dbgen.ListIdMapBindCandidatesRow{}
	for _, r := range rows {
		byVerdict[r.Verdict] = append(byVerdict[r.Verdict], r)
	}

	fmt.Println()
	fmt.Println("id-map bind candidates (read-only)")
	fmt.Printf("%-24s %8s\n", "VERDICT", "COUNT")
	fmt.Printf("%-24s %8s\n", "──────────────────────", "────────")
	for _, v := range []string{verdictBindable, verdictAlreadyBound, verdictClaimedTwice} {
		fmt.Printf("%-24s %8d\n", v, len(byVerdict[v]))
	}
	fmt.Printf("\n  unbound rows with a map entry: %d\n", len(rows))

	for _, v := range []string{verdictAlreadyBound, verdictClaimedTwice} {
		printVerdictSample(v, byVerdict[v])
	}
	return nil
}

// printVerdictSample shows the first few rows of one refusal class, ordered by
// anilist_id so repeated runs print the same sample.
func printVerdictSample(verdict string, rows []dbgen.ListIdMapBindCandidatesRow) {
	if len(rows) == 0 {
		return
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].AnilistID < rows[j].AnilistID })
	n := len(rows)
	if n > sampleRowsPerVerdict {
		n = sampleRowsPerVerdict
	}
	fmt.Printf("\n  %s (%d rows, showing %d)\n", verdict, len(rows), n)
	for _, r := range rows[:n] {
		fmt.Printf("    anilist=%-8d bgm=%-8d %s\n", r.AnilistID, r.BgmID, bindRowTitle(r))
	}
}

// bindRowTitle picks the most legible label available.  Romaji first because
// it is the one a reader can scan quickly; native is the fallback for rows
// AniList only carries a Japanese title for.
func bindRowTitle(r dbgen.ListIdMapBindCandidatesRow) string {
	title := "(untitled)"
	if r.TitleRomaji != nil && *r.TitleRomaji != "" {
		title = *r.TitleRomaji
	} else if r.TitleNative != nil && *r.TitleNative != "" {
		title = *r.TitleNative
	}
	if r.SeasonYear != nil {
		return fmt.Sprintf("%s (%d)", title, *r.SeasonYear)
	}
	return title
}
