package hant

// The report: what the ladder would do, why it declined what it declined,
// and the queue of things a human has to decide.
//
// Kept apart from main.go because it is the half of this tool an operator
// actually reads.  --apply is four statements; the report is what makes
// running them a decision rather than a leap.

import (
	"fmt"
	"io"
	"sort"
	"time"
)

// ─── report ──────────────────────────────────────────────────────────────────

// SimplifiedRejection is one dataset title dropped by the Simplified
// rule.  The whole list goes into the report, not a sample: it is the
// work queue for promoting these titles by hand to source='manual', and a
// sampled queue is not a queue.
type SimplifiedRejection struct {
	AnilistID int32  `json:"anilist_id"`
	Title     string `json:"title"`
	BadChars  string `json:"bad_chars"`
	Rescued   string `json:"rescued_by_synonym,omitempty"`
	Applied   string `json:"applied_source,omitempty"`
}

type ColumnReport struct {
	StoredSources   map[string]int `json:"stored_sources"`
	ProposedSources map[string]int `json:"proposed_sources"`
	WouldChange     int            `json:"would_change"`
	ManualUntouched int            `json:"manual_untouched"`
	Stale           map[string]int `json:"stale"`
}

type GateReport struct {
	AnilistRecordsMatched int            `json:"anilist_records_matched"`
	TitleAccepted         int            `json:"anilist_title_accepted"`
	TitleRejected         map[string]int `json:"anilist_title_rejected_by_rule"`
	RescuedBySynonym      map[string]int `json:"anilist_rescued_by_synonym"`
	NoUsableCandidate     int            `json:"anilist_no_usable_candidate"`
	CgroupHitsVia         map[string]int `json:"cgroup_hits_via"`
	CgroupKeysUsable      int            `json:"cgroup_keys_usable"`
	CgroupKeysDropped     []string       `json:"cgroup_keys_dropped_ambiguous"`
}

type Report struct {
	GeneratedAt time.Time `json:"generated_at"`
	TotalRows   int       `json:"total_rows"`
	RestaleOnly bool      `json:"restale_only"`

	Title       ColumnReport `json:"title_hant"`
	Description ColumnReport `json:"description_hant"`
	Gate        GateReport   `json:"gate"`

	// SimplifiedRejectionChars counts the rejections by offending
	// character, most frequent first.  It exists because the raw list
	// hides its own shape: over the vendored file the top six characters
	// are 秘 群 痴 峰 温 栖, and every one of those is a *Traditional*
	// orthographic variant rather than Simplified text — 群 and 峰 are the
	// Hong Kong standard forms, and OpenCC's STCharacters normalises them
	// toward the Taiwan Ministry of Education's 羣 and 峯.  The rule is
	// still the right one to ship (it keeps "source='anilist' means a
	// human wrote exactly this string" true), but an operator working the
	// promotion queue should be able to see in one line that half of it
	// is one orthographic disagreement repeated, not half-Simplified
	// titles.
	SimplifiedRejectionChars []CharCount `json:"simplified_rejection_chars"`

	SimplifiedRejections []SimplifiedRejection `json:"simplified_rejections"`
}

// CharCount is one row of the offending-character histogram.
type CharCount struct {
	Chars string `json:"chars"`
	Count int    `json:"count"`
}

func newColumnReport() ColumnReport {
	return ColumnReport{
		StoredSources:   map[string]int{},
		ProposedSources: map[string]int{},
		Stale:           map[string]int{},
	}
}

func BuildReport(r *Resolver, results []RowResult, restaleOnly bool) Report {
	rep := Report{
		GeneratedAt: time.Now().UTC(),
		TotalRows:   len(results),
		RestaleOnly: restaleOnly,
		Title:       newColumnReport(),
		Description: newColumnReport(),
		Gate: GateReport{
			TitleRejected:     map[string]int{},
			RescuedBySynonym:  map[string]int{},
			CgroupHitsVia:     map[string]int{},
			CgroupKeysUsable:  len(r.cgroup.byKey),
			CgroupKeysDropped: r.cgroup.Dropped,
		},
	}

	seenSimplified := make(map[int32]struct{})

	for _, res := range results {
		tally(&rep.Title, res.Row.TitleHantSource, res.Title, res.TitleManual, res.TitleChanged, res.TitleStale)
		tally(&rep.Description, res.Row.DescHantSource, res.Desc, res.DescManual, res.DescChanged, res.DescStale)

		if res.Title.Via != "" {
			rep.Gate.CgroupHitsVia[res.Title.Via]++
		}
		if !res.Title.PickAttempted {
			continue
		}
		rep.Gate.AnilistRecordsMatched++
		pick := res.Title.Pick
		if pick.TitleReason == ReasonNone {
			rep.Gate.TitleAccepted++
		} else {
			rep.Gate.TitleRejected[string(pick.TitleReason)]++
			if pick.FromSynonym {
				rep.Gate.RescuedBySynonym[string(pick.TitleReason)]++
			} else {
				rep.Gate.NoUsableCandidate++
			}
		}

		if pick.TitleReason != ReasonSimplified {
			continue
		}
		if _, dup := seenSimplified[res.Row.AnilistID]; dup {
			continue
		}
		seenSimplified[res.Row.AnilistID] = struct{}{}
		rec := r.anilist.byID[res.Row.AnilistID]
		rep.SimplifiedRejections = append(rep.SimplifiedRejections, SimplifiedRejection{
			AnilistID: res.Row.AnilistID,
			Title:     rec.Title,
			BadChars:  string(pick.TitleSimplified),
			Rescued:   pick.Value,
			Applied:   res.Title.Source,
		})
	}

	sort.Slice(rep.SimplifiedRejections, func(i, j int) bool {
		return rep.SimplifiedRejections[i].AnilistID < rep.SimplifiedRejections[j].AnilistID
	})

	byChars := map[string]int{}
	for _, r := range rep.SimplifiedRejections {
		byChars[r.BadChars]++
	}
	for chars, n := range byChars {
		rep.SimplifiedRejectionChars = append(rep.SimplifiedRejectionChars, CharCount{Chars: chars, Count: n})
	}
	sort.Slice(rep.SimplifiedRejectionChars, func(i, j int) bool {
		a, b := rep.SimplifiedRejectionChars[i], rep.SimplifiedRejectionChars[j]
		if a.Count != b.Count {
			return a.Count > b.Count
		}
		return a.Chars < b.Chars
	})
	return rep
}

func tally(c *ColumnReport, storedSource *string, d Decision, manual, changed bool, stale StaleKind) {
	if storedSource == nil {
		c.StoredSources["none"]++
	} else {
		c.StoredSources[*storedSource]++
	}
	if stale != StaleNone {
		c.Stale[string(stale)]++
	}
	if manual {
		c.ManualUntouched++
		c.ProposedSources[SrcManual]++
		return
	}
	if d.Source == "" {
		c.ProposedSources["none"]++
	} else {
		c.ProposedSources[d.Source]++
	}
	if changed {
		c.WouldChange++
	}
}

// sourceOrder is the print order for the tier tables — the precedence
// ladder itself, so a reader sees the trunk and the tail in the order the
// Resolver tried them.
var sourceOrder = []string{SrcManual, SrcWikipedia, SrcAnilist, SrcOpenCC, "none"}

// PrintSummary renders the report an operator reads before deciding
// whether to run --apply.
//
// It takes the writer so the rendering is assertable, and it takes the
// --restale banner from the report rather than from a second parameter:
// the flag is already recorded in rep.RestaleOnly and passing it twice
// only creates a way for the printed banner to disagree with the JSON
// written beside it.
func PrintSummary(w io.Writer, rep Report) {
	fmt.Fprintf(w, "\nRows scanned: %d\n", rep.TotalRows)
	if rep.RestaleOnly {
		fmt.Fprintf(w, "Mode: --restale (only rows with a stale source hash are writable)\n")
	}

	printColumn(w, "title_hant", rep.TotalRows, rep.Title)
	printColumn(w, "description_hant", rep.TotalRows, rep.Description)

	fmt.Fprintf(w, "\nQUALITY GATE (anilist-chinese, over the %d non-manual rows with a dataset record)\n", rep.Gate.AnilistRecordsMatched)
	fmt.Fprintf(w, "  %-28s %8d\n", "title accepted", rep.Gate.TitleAccepted)
	for _, rule := range []RejectReason{ReasonKana, ReasonNoHan, ReasonSimplified, ReasonEmpty} {
		n := rep.Gate.TitleRejected[string(rule)]
		if n == 0 {
			continue
		}
		fmt.Fprintf(w, "  %-28s %8d  (%d rescued by synonym)\n",
			"title rejected: "+string(rule), n, rep.Gate.RescuedBySynonym[string(rule)])
	}
	fmt.Fprintf(w, "  %-28s %8d\n", "no usable candidate", rep.Gate.NoUsableCandidate)

	fmt.Fprintf(w, "\nCGROUP OVERLAY\n")
	fmt.Fprintf(w, "  %-28s %8d\n", "usable keys", rep.Gate.CgroupKeysUsable)
	fmt.Fprintf(w, "  %-28s %8d\n", "keys dropped (ambiguous)", len(rep.Gate.CgroupKeysDropped))
	for _, via := range []string{"title_native", "title_chinese"} {
		fmt.Fprintf(w, "  %-28s %8d\n", "hits via "+via, rep.Gate.CgroupHitsVia[via])
	}

	fmt.Fprintf(w, "\nSimplified-rejected dataset titles (promote by hand as source='manual'): %d\n",
		len(rep.SimplifiedRejections))
	for i, cc := range rep.SimplifiedRejectionChars {
		if i >= maxRejectionChars {
			fmt.Fprintf(w, "  %-28s %8d more\n", "...", len(rep.SimplifiedRejectionChars)-i)
			break
		}
		fmt.Fprintf(w, "  %-28s %8d\n", cc.Chars, cc.Count)
	}
	fmt.Fprintln(w)
}

// maxRejectionChars caps the offending-character histogram on screen.  The
// full list is in the JSON; the terminal gets the head plus a count of what
// it is not showing, because a histogram that scrolls off is not read.
const maxRejectionChars = 8

func printColumn(w io.Writer, name string, total int, c ColumnReport) {
	fmt.Fprintf(w, "\n%s\n", name)
	fmt.Fprintf(w, "  %-12s %8s %8s   %8s %8s\n", "SOURCE", "STORED", "PCT", "PROPOSED", "PCT")
	fmt.Fprintf(w, "  %-12s %8s %8s   %8s %8s\n", "───────────", "────────", "───────", "────────", "───────")
	for _, src := range sourceOrder {
		stored, proposed := c.StoredSources[src], c.ProposedSources[src]
		if stored == 0 && proposed == 0 {
			continue
		}
		fmt.Fprintf(w, "  %-12s %8d %7.1f%%   %8d %7.1f%%\n", src, stored, pct(stored, total), proposed, pct(proposed, total))
	}
	fmt.Fprintf(w, "  %-12s %8s %8s   %8d\n", "would change", "", "", c.WouldChange)
	if len(c.Stale) > 0 {
		for _, k := range []StaleKind{StaleHash, StaleMissingHash, StaleGone} {
			if n := c.Stale[string(k)]; n > 0 {
				fmt.Fprintf(w, "  %-12s %8s %8s   %8d  (%s)\n", "stale", "", "", n, k)
			}
		}
	}
}

// pct is n as a percentage of total, and 0 when there is no total.
//
// The guard is not defensive tidiness.  Every percentage in the summary is
// over rep.TotalRows, which is zero on a run that matched no rows -- an
// empty table, or a --limit that a wrapper resolved to 0 -- and float
// division by zero in Go does not panic, it yields NaN for 0/0 and ±Inf
// otherwise.  Both render happily through %7.1f, so the failure mode is a
// summary reading "NaN%" in the column an operator is checking before
// typing --apply.
func pct(n, total int) float64 {
	if total == 0 {
		return 0
	}
	return float64(n) / float64(total) * 100
}
