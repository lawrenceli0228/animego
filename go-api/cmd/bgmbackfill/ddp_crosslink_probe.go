// ddp_crosslink_probe.go — read-only measurement of what dandanplay's
// cross-links could bind, for the rows the vendored id map is silent about.
//
// # What it is for
//
// The id-map bind sweep owns every unbound row the map answers for.  What is
// left is ~4,400 rows the map has never heard of, and for those dandanplay is
// the only source we already have credentials to.  Two designs were on the
// table for reaching them: capture the cross-link opportunistically when a user
// happens to /match one of them, or sweep them all with a search.
//
// Both rest on exactly the same evidence -- dandanplay publishes, on one
// curated entry, a link to an AniList id and a link to a Bangumi subject -- so
// the choice is not about correctness.  It is about reach against cost, and
// neither number was known: the capture reaches only the fraction of rows users
// actually play, and the sweep's cost is a shared request budget that has been
// hit before.  This probe measures the hit rate and the per-row request cost so
// the choice is made on numbers.
//
// # Why it walks candidates rather than trusting the first hit
//
// The search leg is recall, not precision.  A keyword yields whatever
// dandanplay's index returns, in an order nothing guarantees, and for a
// franchise that means every season.  Precision comes from one exact test at
// the end: the entry's AniList cross-link must EQUAL the row we started from.
// That is the same loose-recall / strict-precision split findSiteAnime already
// uses, and it is what makes a fuzzy search safe to build a binding on.
//
// The probe reports WHICH candidate position answered, because that number is
// the per-row request cost of the sweep this measures.
package main

import (
	"context"
	"fmt"
	"log/slog"
	"math"
	"sort"

	"github.com/lawrenceli0228/animego/go-api/internal/dandanplay"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// crosslinkMaxCandidates caps how deep into a search result the probe looks.
// Every extra position is one more request per row across the whole
// catalogue, so the cap is deliberately shallow; the position histogram in
// the report says whether it is costing hits.
const crosslinkMaxCandidates = 3

// Probe outcome classes.  Ordered here the way the summary prints them:
// the one that would produce a binding first, then the refusals, then the
// failures.
const (
	xlinkBindable      = "BINDABLE"         // crosslink names our row, subject free
	xlinkSubjectTaken  = "SUBJECT_TAKEN"    // crosslink names our row, subject held
	xlinkNoBgmLink     = "NO_BGM_LINK"      // entry matches, but no bgm URL on it
	xlinkAnilistMiss   = "ANILIST_MISMATCH" // every candidate points somewhere else
	xlinkNoAnilistLink = "NO_ANILIST_LINK"  // no candidate published an AniList link
	xlinkNoSearchHit   = "NO_SEARCH_HIT"    // search returned nothing
	xlinkNoKeyword     = "NO_KEYWORD"       // the row has no title to search with
	xlinkFetchFail     = "FETCH_FAIL"       // network / upstream error
)

// crosslinkProbeDB is the read surface the probe needs.
type crosslinkProbeDB interface {
	ListUnboundMapSilentForCrosslink(ctx context.Context) ([]dbgen.ListUnboundMapSilentForCrosslinkRow, error)
	CountAnimeHoldingBgmID(ctx context.Context, bgmID *int32) (int64, error)
}

// crosslinkProbeClient is the dandanplay surface the probe needs.
type crosslinkProbeClient interface {
	SearchAnime(ctx context.Context, keyword string) ([]dandanplay.DandanAnime, error)
	FetchEpisodesByDandanAnimeID(ctx context.Context, animeID int64) (*dandanplay.EpisodeData, error)
}

// crosslinkRow is one row's outcome.
type crosslinkRow struct {
	AnilistID int32  `json:"anilistId"`
	Title     string `json:"title"`
	Class     string `json:"class"`
	BgmID     int32  `json:"bgmId,omitempty"`
	// Position is the 1-based index of the candidate that answered, or 0 when
	// none did.  Averaged over the bindable rows it IS the sweep's per-row
	// request cost, which is the number the design decision turns on.
	Position int `json:"position,omitempty"`
}

// crosslinkReport is the JSON artefact.
type crosslinkReport struct {
	Total  int `json:"total"`
	Probed int `json:"probed"`
	// Stride is the spacing of the systematic sample: 1 means the run walked
	// the candidate set in order, N>1 means it took every Nth row.  Recorded
	// because it decides whether the extrapolation below is a measurement or
	// a guess about the head of the catalogue.
	Stride      int            `json:"stride"`
	Counts      map[string]int `json:"counts"`
	APICalls    int            `json:"ddpApiCalls"`
	PositionHit map[int]int    `json:"positionHit"`
	Rows        []crosslinkRow `json:"rows"`
}

// crosslinkSample takes `want` rows spread evenly across the whole ordered
// candidate set, and reports the stride it used.
//
// WHY THIS EXISTS.  The candidate query orders by anilist_id, deliberately, so
// that a run which stops partway and a run which resumes walk the same
// sequence.  That is right for a sweep and wrong for a measurement: capping a
// measurement by request budget then means it only ever sees the head of the
// catalogue, and the number it produces gets multiplied by 4,400.
//
// The bias is not hypothetical here.  On this exact table, in this exact
// ordering, over this exact population -- unbound rows -- the id-map pass
// measured 34.3% map-confirmed in the head against 69-78% in the middle
// bands.  Roughly double.  A head sample would have understated that answer
// by half.
//
// anilist_id is broadly chronological, and the thing being measured
// (dandanplay's coverage and whether it publishes an AniList cross-link) has
// every reason to vary with a title's age, so the head is exactly the wrong
// slice to generalise from.
//
// A systematic every-Nth sample rather than a random one: the ordering has no
// periodicity for a stride to alias against, it costs no extra query, and it
// is reproducible -- the same `want` against the same catalogue probes the
// same rows, so two runs can be compared instead of merely averaged.
func crosslinkSample[T any](rows []T, want int) ([]T, int) {
	if want <= 0 || want >= len(rows) {
		return rows, 1
	}
	// Indices are computed proportionally (i*len/want) rather than by stepping
	// a fixed stride, and the difference is not cosmetic.  Stepping by
	// len/want truncates -- 4463/300 is 14, and 300 steps of 14 stop at 4186,
	// leaving the last 277 rows of the catalogue unreachable no matter how
	// large the sample.  That is the same tail-versus-head bias this function
	// exists to remove, just at the other end, and it grows as `want` shrinks.
	// Proportional indexing lands the final pick within one stride of the last
	// row for any pair of sizes.
	out := make([]T, 0, want)
	for i := 0; i < want; i++ {
		out = append(out, rows[i*len(rows)/want])
	}
	// Reported as the nominal spacing, which is what a reader of the summary
	// wants ("every 14th row"); the actual gaps vary by one where the division
	// is inexact.
	stride := len(rows) / want
	if stride < 1 {
		stride = 1
	}
	return out, stride
}

// runCrosslinkProbe walks the candidate set and reports.  Writes nothing.
//
// `sample` > 0 spreads the run across the whole population instead of walking
// the head; see crosslinkSample.  `limit` stays a hard ceiling on upstream
// calls either way, because the budget it protects is shared with live
// danmaku.
func runCrosslinkProbe(ctx context.Context, q crosslinkProbeDB, ddp crosslinkProbeClient, limit, sample int, outPath string) error {
	all, err := q.ListUnboundMapSilentForCrosslink(ctx)
	if err != nil {
		return fmt.Errorf("list crosslink candidates: %w", err)
	}
	rows, stride := crosslinkSample(all, sample)
	slog.Info("ddp crosslink probe: candidates",
		"count", len(all), "sampled", len(rows), "stride", stride, "limit", limit)

	rep := crosslinkReport{
		// Total stays the whole population, not the sample: it is the
		// multiplier the extrapolation uses.
		Total:       len(all),
		Stride:      stride,
		Counts:      map[string]int{},
		PositionHit: map[int]int{},
		Rows:        make([]crosslinkRow, 0, len(rows)),
	}

	for i, row := range rows {
		if limit > 0 && rep.APICalls >= limit {
			break
		}
		if i > 0 && i%50 == 0 {
			slog.Info("ddp crosslink probe: progress",
				"probed", rep.Probed, "bindable", rep.Counts[xlinkBindable],
				"ddp_api_calls", rep.APICalls)
		}
		out := probeOneCrosslink(ctx, q, ddp, row, &rep)
		rep.Probed++
		rep.Counts[out.Class]++
		if out.Position > 0 {
			rep.PositionHit[out.Position]++
		}
		rep.Rows = append(rep.Rows, out)
	}

	printCrosslinkSummary(&rep)
	if err := writeJSON(outPath, rep); err != nil {
		return fmt.Errorf("write report %s: %w", outPath, err)
	}
	slog.Info("ddp crosslink report written", "path", outPath)
	return nil
}

// probeOneCrosslink resolves a single row.
func probeOneCrosslink(ctx context.Context, q crosslinkProbeDB, ddp crosslinkProbeClient,
	row dbgen.ListUnboundMapSilentForCrosslinkRow, rep *crosslinkReport) crosslinkRow {

	out := crosslinkRow{AnilistID: row.AnilistID, Title: crosslinkKeyword(row)}
	if out.Title == "" {
		out.Class = xlinkNoKeyword
		return out
	}

	rep.APICalls++
	hits, err := ddp.SearchAnime(ctx, out.Title)
	if err != nil {
		out.Class = xlinkFetchFail
		return out
	}
	if len(hits) == 0 {
		out.Class = xlinkNoSearchHit
		return out
	}

	// sawAnilistLink separates "dandanplay publishes no AniList link for any of
	// these entries" from "it does, and every one of them names a different
	// show".  The first is a gap in their data and says nothing about our row;
	// the second is a real disagreement and is worth counting on its own.
	sawAnilistLink := false
	n := len(hits)
	if n > crosslinkMaxCandidates {
		n = crosslinkMaxCandidates
	}
	for i := 0; i < n; i++ {
		rep.APICalls++
		data, err := ddp.FetchEpisodesByDandanAnimeID(ctx, hits[i].DandanAnimeID)
		if err != nil {
			out.Class = xlinkFetchFail
			return out
		}
		if data == nil {
			continue
		}
		if data.AniListID != 0 {
			sawAnilistLink = true
		}
		if data.AniListID != row.AnilistID {
			continue
		}

		// Exact identity: dandanplay's own entry names the row we started
		// from.  Everything after this is about the subject, not the match.
		out.Position = i + 1
		if data.BgmID == 0 {
			out.Class = xlinkNoBgmLink
			return out
		}
		out.BgmID = data.BgmID
		held, err := q.CountAnimeHoldingBgmID(ctx, &data.BgmID)
		if err != nil {
			out.Class = xlinkFetchFail
			return out
		}
		if held > 0 {
			out.Class = xlinkSubjectTaken
			return out
		}
		out.Class = xlinkBindable
		return out
	}

	if sawAnilistLink {
		out.Class = xlinkAnilistMiss
	} else {
		out.Class = xlinkNoAnilistLink
	}
	return out
}

// crosslinkKeyword picks the search string, in the order V1 already uses:
// native first because dandanplay's index is Japanese-titled, romaji as the
// fallback.  Chinese is deliberately not used -- dandanplay's Chinese titles
// are its own, and searching one against its index is not the same test.
func crosslinkKeyword(row dbgen.ListUnboundMapSilentForCrosslinkRow) string {
	for _, t := range []*string{row.TitleNative, row.TitleRomaji, row.TitleEnglish} {
		if t != nil && *t != "" {
			return *t
		}
	}
	return ""
}

// printCrosslinkSummary writes the human-readable half.
func printCrosslinkSummary(rep *crosslinkReport) {
	fmt.Println()
	fmt.Println("dandanplay crosslink probe (read-only)")
	fmt.Printf("%-18s %8s %8s\n", "CLASS", "COUNT", "PCT")
	fmt.Printf("%-18s %8s %8s\n", "────────────────", "────────", "────────")
	for _, c := range []string{
		xlinkBindable, xlinkSubjectTaken, xlinkNoBgmLink, xlinkAnilistMiss,
		xlinkNoAnilistLink, xlinkNoSearchHit, xlinkNoKeyword, xlinkFetchFail,
	} {
		n := rep.Counts[c]
		pct := 0.0
		if rep.Probed > 0 {
			pct = 100 * float64(n) / float64(rep.Probed)
		}
		fmt.Printf("%-18s %8d %7.1f%%\n", c, n, pct)
	}

	fmt.Printf("\n  candidates in scope: %d\n", rep.Total)
	fmt.Printf("  rows probed:         %d\n", rep.Probed)
	fmt.Printf("  dandanplay calls:    %d\n", rep.APICalls)
	if rep.Probed > 0 {
		fmt.Printf("  calls per row:       %.2f\n", float64(rep.APICalls)/float64(rep.Probed))
	}

	// The position histogram is the cost lever: if every hit is at position 1
	// the candidate cap can come down to 1 and the sweep costs two requests a
	// row, and if hits are spread the cap is buying real coverage.
	if len(rep.PositionHit) > 0 {
		keys := make([]int, 0, len(rep.PositionHit))
		for k := range rep.PositionHit {
			keys = append(keys, k)
		}
		sort.Ints(keys)
		fmt.Println("\n  identity found at candidate position:")
		for _, k := range keys {
			fmt.Printf("    #%d  %d\n", k, rep.PositionHit[k])
		}
	}

	// Extrapolation is the whole point of a probe, so it is printed rather
	// than left for someone to do by hand -- and it is printed with a note
	// saying which of the two things it is, because a stride-1 run over a
	// budget cap has only seen the head of the catalogue and the id-map pass
	// has already shown the head of this population is not representative.
	if rep.Probed > 0 && rep.Total > rep.Probed {
		rate := float64(rep.Counts[xlinkBindable]) / float64(rep.Probed)
		fmt.Printf("\n  at this rate a full pass over %d rows would bind ~%.0f\n",
			rep.Total, rate*float64(rep.Total))
		fmt.Printf("  and cost ~%.0f requests\n",
			float64(rep.APICalls)/float64(rep.Probed)*float64(rep.Total))
		if rep.Stride > 1 {
			// Wald interval.  Printed because the decision this feeds is a
			// threshold comparison, and a point estimate with no width invites
			// reading 12% and 18% as different answers when the sample cannot
			// tell them apart.
			se := math.Sqrt(rate * (1 - rate) / float64(rep.Probed))
			fmt.Printf("  n=%d, every %d-th row across the whole set; 95%% CI on the bind rate: %.1f%%-%.1f%%\n",
				rep.Probed, rep.Stride, 100*(rate-1.96*se), 100*(rate+1.96*se))
		} else {
			fmt.Printf("  n=%d, head of the anilist_id order -- the id-map pass found its head\n", rep.Probed)
			fmt.Println("  unrepresentative, so treat this as a range, or re-run with -probe-sample")
		}
	}
}
