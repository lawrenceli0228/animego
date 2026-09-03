// audit_binding.go — read-only audit of a binding against the Bangumi subject
// it points at.
//
// # Why this cannot reuse classify()
//
// The existing audit treats bgm_id_map as authoritative, which is the right
// call when the binding came from our own fuzzy matcher and the map is the
// independent auditor.  It is worthless for a binding the map itself produced:
// asked whether the map agrees with a row copied out of the map, it will
// always say yes.  Its one genuinely independent leg reads dandanplay, whose
// 番剧详情 group is metered per day and shares that budget with live /match.
//
// So this audit asks the subject directly.  Bangumi publishes the Japanese
// original name, the air date and the episode count on every subject, and
// anime_cache holds all three from AniList -- an entirely separate ingest.
// Comparing them is a real second opinion: nothing in the chain that produced
// the binding also produced the AniList side of the comparison.
//
// # What each signal is worth
//
// Title similarity is the load-bearing one, because it is the only signal that
// distinguishes two different shows rather than two entries of the same one.
// Year and episode count are corroborating: a franchise's seasons share a
// title stem and differ by year, so the year catching what the title misses is
// exactly the split-season case.
//
// None of the three is decisive alone, which is why this prints a per-row
// verdict for a human rather than deciding anything.  It writes nothing.
package main

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/lawrenceli0228/animego/go-api/internal/bangumi"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// auditTitleFloor is the similarity below which a pair is worth a human's
// eyes.  It matches classifyThreshold rather than inventing a second number:
// the same function scores both, and two thresholds for one measure is how
// they drift apart.
const auditTitleFloor = classifyThreshold

// Verdicts, ordered as the summary prints them.
const (
	auditOK       = "OK"        // title agrees, and nothing else contradicts
	auditYearOff  = "YEAR_OFF"  // title agrees but the years are far apart
	auditEpsOff   = "EPS_OFF"   // title agrees but the episode counts are far apart
	auditWeak     = "WEAK"      // title similarity below the floor
	auditNoNative = "NO_NATIVE" // nothing to compare: no Japanese title on our side
	auditFetchErr = "FETCH_ERR" // the subject could not be read
)

// auditYearSlack is how far apart two air years may be before it is worth
// remarking on.  One year, because a season that starts in December is listed
// by AniList under that year and by Bangumi under the next.
const auditYearSlack = 1

// auditEpsRatio is how far the episode counts may diverge.  It is the same
// ceiling the episode-title scope guard uses and for the same reason: past
// twice the length, the subject is describing something bigger than the entry.
const auditEpsRatio = 2.0

// bindingAuditDB is the read surface this audit needs.
type bindingAuditDB interface {
	ListRecentIdMapBindings(ctx context.Context, since int32) ([]dbgen.ListRecentIdMapBindingsRow, error)
}

// bindingSubjectFetcher is the Bangumi surface this audit needs.
type bindingSubjectFetcher interface {
	Subject(ctx context.Context, id int) (*bangumi.Subject, error)
}

// auditRow is one binding's verdict.
type auditRow struct {
	AnilistID   int32   `json:"anilistId"`
	BgmID       int32   `json:"bgmId"`
	Verdict     string  `json:"verdict"`
	Similarity  float64 `json:"similarity"`
	OurNative   string  `json:"ourNative,omitempty"`
	BgmName     string  `json:"bgmName,omitempty"`
	OurYear     *int32  `json:"ourYear,omitempty"`
	BgmYear     int     `json:"bgmYear,omitempty"`
	OurEpisodes *int32  `json:"ourEpisodes,omitempty"`
	BgmEps      int     `json:"bgmEps,omitempty"`
	Err         string  `json:"err,omitempty"`
}

// auditReport is the artifact.
type auditReport struct {
	Total  int            `json:"total"`
	Counts map[string]int `json:"counts"`
	Rows   []auditRow     `json:"rows"`
}

// runBindingAudit reads every id_map binding written in the last `sinceMin`
// minutes and checks each against its subject.
func runBindingAudit(ctx context.Context, q bindingAuditDB, bgm bindingSubjectFetcher, sinceMin int, outPath string) error {
	rows, err := q.ListRecentIdMapBindings(ctx, int32(sinceMin))
	if err != nil {
		return fmt.Errorf("list recent id_map bindings: %w", err)
	}

	rep := auditReport{Total: len(rows), Counts: map[string]int{}, Rows: make([]auditRow, 0, len(rows))}
	for _, r := range rows {
		rep.Rows = append(rep.Rows, auditOneBinding(ctx, bgm, r))
		rep.Counts[rep.Rows[len(rep.Rows)-1].Verdict]++
	}

	printAuditSummary(&rep)
	if err := writeJSON(outPath, rep); err != nil {
		return fmt.Errorf("write report %s: %w", outPath, err)
	}
	return nil
}

// auditOneBinding scores one row.
func auditOneBinding(ctx context.Context, bgm bindingSubjectFetcher, r dbgen.ListRecentIdMapBindingsRow) auditRow {
	out := auditRow{AnilistID: r.AnilistID, OurYear: r.SeasonYear, OurEpisodes: r.Episodes}
	if r.BgmID != nil {
		out.BgmID = *r.BgmID
	}
	if r.TitleNative != nil {
		out.OurNative = *r.TitleNative
	}

	subj, err := bgm.Subject(ctx, int(out.BgmID))
	if err != nil || subj == nil {
		out.Verdict = auditFetchErr
		if err != nil {
			out.Err = err.Error()
		}
		return out
	}
	out.BgmName, out.BgmEps = subj.Name, subj.Eps
	out.BgmYear = yearFromBgmDate(subj.Date)

	// Bangumi's `name` is the original title, which for anime is Japanese.
	// title_native is AniList's field for the same thing, so this compares
	// like with like; romaji would compare a transliteration to an original.
	if out.OurNative == "" {
		out.Verdict = auditNoNative
		return out
	}
	out.Similarity = bangumi.TitleSimilarity(out.OurNative, out.BgmName)
	if out.Similarity < auditTitleFloor {
		out.Verdict = auditWeak
		return out
	}

	// The title agreed.  The remaining two only ever downgrade, and they exist
	// for the case the title cannot see: two seasons of one franchise share a
	// stem and are told apart by when they aired and how long they ran.
	if out.OurYear != nil && out.BgmYear != 0 && absInt(int(*out.OurYear)-out.BgmYear) > auditYearSlack {
		out.Verdict = auditYearOff
		return out
	}
	if out.OurEpisodes != nil && *out.OurEpisodes > 0 && out.BgmEps > 0 &&
		float64(out.BgmEps) > auditEpsRatio*float64(*out.OurEpisodes) {
		out.Verdict = auditEpsOff
		return out
	}
	out.Verdict = auditOK
	return out
}

// yearFromBgmDate reads the year out of Bangumi's "YYYY-MM-DD".  Returns 0
// when the subject has no date, which a surprising number of OVA entries do
// not -- and 0 is then skipped rather than compared, since an absent date
// cannot disagree with anything.
func yearFromBgmDate(date string) int {
	if len(date) < 4 {
		return 0
	}
	y, err := strconv.Atoi(date[:4])
	if err != nil {
		return 0
	}
	return y
}

func absInt(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

// printAuditSummary prints the counts and then every row that is not a clean
// OK, because the whole point of the run is to read those individually.
func printAuditSummary(rep *auditReport) {
	fmt.Println()
	fmt.Println("id_map binding audit (read-only, checked against the Bangumi subject)")
	fmt.Printf("%-12s %8s %8s\n", "VERDICT", "COUNT", "PCT")
	fmt.Printf("%-12s %8s %8s\n", "──────────", "────────", "────────")
	for _, v := range []string{auditOK, auditYearOff, auditEpsOff, auditWeak, auditNoNative, auditFetchErr} {
		n := rep.Counts[v]
		pct := 0.0
		if rep.Total > 0 {
			pct = 100 * float64(n) / float64(rep.Total)
		}
		fmt.Printf("%-12s %8d %7.1f%%\n", v, n, pct)
	}
	fmt.Printf("\n  bindings checked: %d\n", rep.Total)

	flagged := make([]auditRow, 0)
	for _, r := range rep.Rows {
		if r.Verdict != auditOK {
			flagged = append(flagged, r)
		}
	}
	if len(flagged) == 0 {
		fmt.Println("\n  every binding agreed with its subject on all three signals.")
		return
	}
	sort.Slice(flagged, func(i, j int) bool { return flagged[i].Similarity < flagged[j].Similarity })
	fmt.Printf("\n  %d needing a human, weakest first:\n", len(flagged))
	for _, r := range flagged {
		fmt.Printf("    [%-9s sim=%.2f] anilist=%-8d bgm=%-8d\n", r.Verdict, r.Similarity, r.AnilistID, r.BgmID)
		fmt.Printf("        ours: %s (%s, %s eps)\n", orDash(r.OurNative), yearStr(r.OurYear), epsStr(r.OurEpisodes))
		fmt.Printf("        bgm : %s (%s, %d eps)\n", orDash(r.BgmName), yearStrInt(r.BgmYear), r.BgmEps)
		if r.Err != "" {
			fmt.Printf("        err : %s\n", r.Err)
		}
	}
}

func orDash(s string) string {
	if strings.TrimSpace(s) == "" {
		return "—"
	}
	return s
}

func yearStr(y *int32) string {
	if y == nil {
		return "—"
	}
	return strconv.Itoa(int(*y))
}

func yearStrInt(y int) string {
	if y == 0 {
		return "—"
	}
	return strconv.Itoa(y)
}

func epsStr(e *int32) string {
	if e == nil {
		return "—"
	}
	return strconv.Itoa(int(*e))
}
