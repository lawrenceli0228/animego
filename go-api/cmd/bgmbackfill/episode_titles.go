// episode_titles.go — the one-off pass that fills anime_episode_titles from
// dandanplay, and the audit trail it has to produce before it is allowed to.
//
// # Why this lives in a CLI and not in a worker
//
// The gap it closes is a backlog, not a stream.  A finished show's episode
// titles do not change, so they need filling once; what needs re-asking is the
// airing slice, and that is small enough to be its own periodic sweep with one
// timestamp behind it.  Building a permanent five-state queue worker to drain
// a one-time backlog would have added a job kind, a migration, a cooldown
// vocabulary and a kill switch, each with its own failure surface, to do work
// that a command run twice does better -- because a command can be read before
// it writes, and a worker cannot.
//
// That is the second reason: --report is the safety mechanism, not a
// convenience.  Deciding that a binding is wrong is a judgement made from two
// disagreeing external sources, and the consequence of getting it wrong is
// deleting correct titles from a public, indexed page.  So the default mode
// writes nothing and produces a classification of every row; --apply is a
// separate, deliberate second invocation against a report a human has read.
//
// # Who decides identity, and why it is not dandanplay
//
// Both this pass and the classify flow next door need to know whether the
// bgm_id on a row really belongs to that anilist entry.  Two independent
// sources can answer:
//
//	bgm_id_map    the vendored AniList->Bangumi map.  It is what
//	              BangumiV1Worker binds from in the first place, so where it
//	              has an entry it is not a second opinion -- it is the
//	              provenance of the binding under test.
//	dandanplay    ships an anilist.co cross-link in the same response as the
//	              episodes, so it costs nothing extra to consult.
//
// The map wins wherever it speaks, and dandanplay is consulted only where it
// is silent.  That is the same order runHeal and classifyAll already use, and
// the reason is measurable rather than aesthetic: dandanplay's cross-links are
// not always consistent with the map, so promoting them to arbiter would let a
// third-party disagreement retract bindings the authoritative map confirms.
// Where the map has nothing, dandanplay is the only independent signal there
// is, and that is exactly the population where mis-bindings concentrate.
//
// # What this pass will NOT decide
//
// A map-confirmed binding can still be a scope mismatch: a three-episode ONA
// may legitimately map to the subject of the full series, and then the
// subject's episode list is not this entry's episode list.  Neither authority
// answers that -- the map says which subject, not which episodes -- and the
// signal that would (comparing the upstream main-episode count against
// anime_cache.episodes) is deliberately not acted on here.  It is RECORDED in
// the report, per row, so the decision can be made from data rather than from
// a threshold picked in advance.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lawrenceli0228/animego/go-api/internal/dandanplay"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/episodetitles"
)

// Classification of one row.  Every row lands in exactly one, and the counts
// are the summary a human reads before deciding whether to run --apply.
const (
	// epClassWritten — the binding was accepted and usable titles were found.
	// In report mode this means "would have been written".
	epClassWritten = "WRITTEN"
	// epClassNoTitles — the binding was accepted and upstream had nothing
	// usable.  Still where a 4xx lands: the client collapses every non-2xx
	// below 500 into an empty result, so "this subject has no episodes" and
	// "our credentials stopped working" remain the same value here.  A run
	// whose NO_TITLES share is far above the historical norm is the symptom
	// of the latter; see the closing summary.  The one refusal that no longer
	// hides here is a spent quota -- see epClassQuotaSpent.
	epClassNoTitles = "NO_TITLES"
	// epClassQuotaSpent — dandanplay refused because the function group's
	// daily quota is gone.  It used to arrive as NO_TITLES, because upstream
	// reports it as HTTP 200 with success:false in the body and the client
	// read the empty payload as an empty subject.  It is a class of its own
	// rather than a flavour of FETCH_FAIL because it is the only outcome that
	// says something about the RUN instead of about the row: every remaining
	// row will get the same answer, so the run is over.
	epClassQuotaSpent = "QUOTA_SPENT"
	// epClassMapConflict — bgm_id_map names a DIFFERENT subject for this
	// entry.  The authoritative map contradicts the stored binding, so
	// nothing is written and no upstream request is spent.
	epClassMapConflict = "MAP_CONFLICT"
	// epClassRebind — the map is silent and dandanplay says this subject
	// belongs to a different anilist entry.  Reported, never acted on: it is
	// input for a re-binding decision, not a licence to write.
	epClassRebind = "DDP_REBIND"
	// epClassUndecided — the map is silent and dandanplay published no
	// cross-link.  Nothing vouches for the binding, so nothing is written.
	// Absence of evidence, kept distinct from evidence of absence.
	epClassUndecided = "UNDECIDED"
	// epClassFetchFail — the request itself failed.
	epClassFetchFail = "FETCH_FAIL"
	// epClassScopeMismatch — the binding is accepted, but the episode list
	// reaches past twice this entry's own length, so the subject covers
	// something larger than the row it would be written onto.  Refused rather
	// than truncated: if the list belongs to a whole series, its episode 1 is
	// the series' first episode, not this entry's, so the head is no more
	// trustworthy than the tail.
	epClassScopeMismatch = "SCOPE_MISMATCH"
	// epClassSkipped — --limit was exhausted before this row was reached.
	epClassSkipped = "SKIPPED"
)

// epTitleRow is one line of the JSON report.
//
// UpstreamMain and CatalogueEpisodes sit next to each other on purpose.  Their
// ratio is the scope-mismatch signal this pass declines to act on, and having
// both in the artifact means the question can later be answered from a real
// distribution instead of a guessed threshold.
type epTitleRow struct {
	AnilistID         int32  `json:"anilist_id"`
	BgmID             int32  `json:"bgm_id"`
	Class             string `json:"class"`
	Title             string `json:"title,omitempty"`
	MapBgmID          *int32 `json:"map_bgm_id,omitempty"`
	DdpAnilistID      int32  `json:"ddp_anilist_id,omitempty"`
	UpstreamMain      int    `json:"upstream_main_episodes"`
	CatalogueEpisodes *int32 `json:"catalogue_episodes,omitempty"`
	TitlesUsable      int    `json:"titles_usable"`
	TitlesChinese     int    `json:"titles_chinese"`
	Written           int    `json:"written,omitempty"`
	Retracted         int    `json:"retracted,omitempty"`
	Err               string `json:"err,omitempty"`

	// AskedUpstream reports whether this row actually reached the network.
	//
	// It is false for a row decided before the fetch (a map conflict, a
	// skipped row) and, less obviously, for a row whose subject a previous row
	// in the same pass already fetched: the client caches an episode response
	// for 24h in-process, so the second claimant of a shared subject is served
	// from memory.  8.2% of one production candidate set were such rows,
	// because 541 subjects are held by more than one anime (TODOS.md).
	//
	// The distinction matters to exactly one consumer, the empty-streak
	// breaker, whose question is whether UPSTREAM is still answering.  A row
	// that consulted no upstream is evidence about neither answer.
	AskedUpstream bool `json:"asked_upstream,omitempty"`

	// MaxEpisode is the highest episode number the refused list carried, set
	// only on a scope mismatch.  Next to CatalogueEpisodes it is the whole
	// case for the refusal in one line of the artifact.
	MaxEpisode int32 `json:"max_episode,omitempty"`
}

// epTitleReport is the whole artifact.
type epTitleReport struct {
	Mode          string         `json:"mode"`
	Total         int            `json:"total"`
	Counts        map[string]int `json:"counts"`
	DdpAPICalls   int            `json:"ddp_api_calls"`
	TitlesWritten int            `json:"titles_written"`
	TitlesCN      int            `json:"titles_chinese"`
	Retracted     int            `json:"retracted"`
	// Aborted is set when the empty-streak breaker stopped the pass.  A run
	// that ended this way is INCOMPLETE, and the field exists so a reader of
	// the artifact cannot mistake it for one that finished.
	Aborted     bool         `json:"aborted,omitempty"`
	AbortReason string       `json:"abort_reason,omitempty"`
	Rows        []epTitleRow `json:"rows"`
}

// runEpisodeTitleHeal classifies every bgm-bound row and, in apply mode,
// writes the titles the classification accepted.
//
// apply=false performs every read and every decision and writes nothing, so
// the two modes cannot drift: the report is produced by the same code path
// that does the writing, not by a parallel description of it.
func runEpisodeTitleHeal(
	ctx context.Context,
	pool *pgxpool.Pool,
	q *dbgen.Queries,
	ddp *dandanplay.Client,
	limitDDP int,
	apply bool,
	resume bool,
	startAfterID int,
	maxEmptyStreak int,
	outPath string,
) error {
	all, err := listEpisodeTitleCandidates(ctx, q, resume)
	if err != nil {
		return err
	}
	rows := dropCandidatesUpTo(all, int32(startAfterID))
	slog.Info("episode-title heal: candidates",
		"count", len(rows), "before_start_after", len(all),
		"startAfterID", startAfterID, "apply", apply, "resume", resume,
		"maxEmptyStreak", maxEmptyStreak)

	emptyStreak := 0
	// Subjects this pass has already asked upstream about.  A repeat is served
	// from the client's 24h in-process cache, which is shorter than no pass
	// has ever been -- so within one run a repeated bgm_id is a cache hit by
	// construction, and this set identifies them exactly.
	fetched := make(map[int32]bool, len(rows))
	rep := epTitleReport{
		Mode:   map[bool]string{true: "apply", false: "report"}[apply],
		Total:  len(rows),
		Counts: map[string]int{},
		Rows:   make([]epTitleRow, 0, len(rows)),
	}

	for i, row := range rows {
		if i > 0 && i%200 == 0 {
			slog.Info("episode-title heal: progress",
				"processed", i, "total", len(rows),
				"written", rep.TitlesWritten, "ddp_api_calls", rep.DdpAPICalls)
		}
		if row.BgmID == nil {
			continue // the query's own predicate guarantees this; belt and braces
		}
		out := healOneRow(ctx, pool, q, ddp, row, limitDDP, apply, &rep, fetched)
		rep.Counts[out.Class]++
		rep.Rows = append(rep.Rows, out)

		// Empty-streak breaker.  The client reports a 4xx and a subject with no
		// episodes identically, so an upstream that has stopped answering looks
		// exactly like a long run of anime it has nothing for -- and a real
		// catalogue does not produce hundreds of those back to back after a
		// healthy start.  Measured on the run this exists for: the first ~40%
		// wrote ~1,100 anime per tenth, then every remaining tenth was ~1,250
		// NO_TITLES and 0-8 writes.  Stopping at the first few hundred turns
		// 7,600 wasted requests into a few hundred, and leaves the unreached
		// rows unstamped so --resume picks them up.
		//
		// Only rows that reached the network move this counter, in EITHER
		// direction.  The first version keyed on the class alone and could not
		// fire: a second production run watched upstream go quiet at ~4,700
		// requests and then walked 350 more rows without aborting, because
		// 8.2% of its candidates shared a subject with an earlier row and came
		// back from the client's in-process cache.  Those cached rows resolved
		// to UNDECIDED or DDP_REBIND -- neither of which is NO_TITLES -- and
		// reset the streak roughly every twelve rows, so it never reached the
		// threshold.  A row that consulted no upstream cannot testify about
		// upstream, which is why it is now neutral rather than exonerating.
		// A spent quota is a fact about the run, so it does not go through the
		// streak heuristic at all -- it stops the run on its first occurrence.
		// The heuristic exists to INFER that upstream has stopped answering
		// from a pattern of empty results; when upstream says so outright
		// there is nothing left to infer, and inferring anyway would take
		// another `maxEmptyStreak` rows to reach the same conclusion.  Note
		// the streak could never reach it here in any case: a quota refusal is
		// now an error, not an empty result, and nextEmptyStreak RESETS on
		// anything that is not NO_TITLES.
		if out.Class == epClassQuotaSpent {
			rep.Aborted = true
			rep.AbortReason = fmt.Sprintf(
				"dandanplay refused at row %d of %d: the function group's quota is spent "+
					"(%s). Every remaining row would get the same answer. The daily budget "+
					"resets on dandanplay's own boundary; re-run with --resume then -- rows "+
					"that were never read are not stamped, so none of them were lost.",
				i+1, len(rows), out.Err)
			slog.Error("episode-title heal: aborted", "reason", rep.AbortReason,
				"processed", i+1, "total", len(rows), "written", rep.Counts[epClassWritten])
			break
		}

		emptyStreak = nextEmptyStreak(emptyStreak, out.AskedUpstream, out.Class)
		if shouldAbortOnEmptyStreak(emptyStreak, maxEmptyStreak, rep.Counts[epClassWritten]) {
			rep.Aborted = true
			rep.AbortReason = fmt.Sprintf(
				"%d consecutive rows returned no titles after %d successful writes; "+
					"upstream has most likely stopped answering (the client still cannot tell "+
					"a 4xx from an empty subject; a spent quota aborts separately). "+
					"Re-run with --resume once it recovers.",
				emptyStreak, rep.Counts[epClassWritten])
			slog.Error("episode-title heal: aborted", "reason", rep.AbortReason,
				"processed", i+1, "total", len(rows))
			break
		}
	}

	printEpisodeTitleSummary(&rep)

	if err := writeJSON(outPath, rep); err != nil {
		return fmt.Errorf("write report %s: %w", outPath, err)
	}
	slog.Info("episode-title report written", "path", outPath)
	return nil
}

// listEpisodeTitleCandidates picks the row set for this pass.
//
// resume=false is the full universe, which is what a first run wants.
// resume=true drops rows a previous pass already wrote, using the stamp the
// writer sets inside the same transaction as the titles -- see the query's own
// comment for why an unstamped row is the safe direction to be wrong in.
//
// The two queries return different generated row types for the same columns,
// so both are flattened here into the shape healOneRow actually reads.  A
// conversion is cheaper than teaching the rest of the file about two types,
// and it keeps the resume decision in one place instead of at every field.
func listEpisodeTitleCandidates(ctx context.Context, q *dbgen.Queries, resume bool) ([]epTitleCandidate, error) {
	if resume {
		rows, err := q.ListBgmBoundNeedingEpisodeTitles(ctx)
		if err != nil {
			return nil, fmt.Errorf("ListBgmBoundNeedingEpisodeTitles: %w", err)
		}
		out := make([]epTitleCandidate, 0, len(rows))
		for _, r := range rows {
			out = append(out, epTitleCandidate{
				AnilistID: r.AnilistID, BgmID: r.BgmID, Episodes: r.Episodes,
				TitleChinese: r.TitleChinese, TitleRomaji: r.TitleRomaji,
			})
		}
		return out, nil
	}
	rows, err := q.ListBgmBoundForBackfill(ctx)
	if err != nil {
		return nil, fmt.Errorf("ListBgmBoundForBackfill: %w", err)
	}
	out := make([]epTitleCandidate, 0, len(rows))
	for _, r := range rows {
		out = append(out, epTitleCandidate{
			AnilistID: r.AnilistID, BgmID: r.BgmID, Episodes: r.Episodes,
			TitleChinese: r.TitleChinese, TitleRomaji: r.TitleRomaji,
		})
	}
	return out, nil
}

// dropCandidatesUpTo removes every candidate at or below startAfterID, so a
// resumed round can begin where the previous one's budget actually ran out.
//
// It exists because --resume answers a narrower question than its name
// suggests: `episode_titles_at` is stamped only inside the transaction that
// WRITES titles, so a row upstream had nothing for, or that no source vouched
// for, is never stamped and stays a candidate forever.  That is the right
// default -- re-asking about an empty subject costs one request, while
// skipping a row that was never written loses it silently -- but the cost is
// not constant.  Measured on 2026-09-05: of 5,436 candidates, 2,730 sat ahead
// of the point the previous round stopped at, and every one of them had
// already been classified NO_TITLES / UNDECIDED / DDP_REBIND / SCOPE_MISMATCH
// the day before.  None of those verdicts changes overnight -- the first 200
// rows of the re-walk produced one write -- yet re-asking them would have
// spent 68% of a 4,000-request budget that the online danmaku path shares.
//
// So this is a budget instrument, not a correctness one: the rows it skips are
// still candidates, still unstamped, and a run without the flag still reaches
// them.  Zero (the default) is the whole set, which is why the comparison is
// <= and not <.
func dropCandidatesUpTo(rows []epTitleCandidate, startAfterID int32) []epTitleCandidate {
	if startAfterID <= 0 {
		return rows
	}
	out := make([]epTitleCandidate, 0, len(rows))
	for _, r := range rows {
		if r.AnilistID <= startAfterID {
			continue
		}
		out = append(out, r)
	}
	return out
}

// epTitleCandidate is the subset of a bgm-bound row this pass reads.
type epTitleCandidate struct {
	AnilistID    int32
	BgmID        *int32
	Episodes     *int32
	TitleChinese *string
	TitleRomaji  *string
}

// healOneRow runs the whole decision for a single anime.  It mutates only the
// running totals on rep; the per-row result is returned.
func healOneRow(
	ctx context.Context,
	pool *pgxpool.Pool,
	q *dbgen.Queries,
	ddp *dandanplay.Client,
	row epTitleCandidate,
	limitDDP int,
	apply bool,
	rep *epTitleReport,
	fetched map[int32]bool,
) epTitleRow {
	bgmID := *row.BgmID
	out := epTitleRow{
		AnilistID:         row.AnilistID,
		BgmID:             bgmID,
		CatalogueEpisodes: row.Episodes,
		Title:             firstNonNil(row.TitleChinese, row.TitleRomaji),
	}

	// 1. The authoritative map, first and for free.  A contradiction here ends
	//    the row before an upstream request is spent on it.
	mapBgm, mapErr := q.LookupBgmIdMap(ctx, row.AnilistID)
	mapSpeaks := mapErr == nil
	if mapErr != nil && mapErr != pgx.ErrNoRows {
		out.Class = epClassFetchFail
		out.Err = fmt.Sprintf("LookupBgmIdMap: %v", mapErr)
		return out
	}
	if mapSpeaks {
		out.MapBgmID = &mapBgm
		if mapBgm != bgmID {
			out.Class = epClassMapConflict
			return out
		}
	}

	// 2. Upstream.  --limit caps live calls so a run can be sized to whatever
	//    share of the shared request budget is acceptable right now.
	if limitDDP > 0 && rep.DdpAPICalls >= limitDDP {
		out.Class = epClassSkipped
		return out
	}
	// A subject this pass has already fetched comes back from the client's
	// 24h in-process cache.  Counting it as an API call inflated the request
	// total a run reports, and -- the reason this is tracked at all -- letting
	// it reset the empty-streak breaker meant a cached answer could vouch for
	// an upstream that had stopped answering.
	out.AskedUpstream = !fetched[bgmID]
	if out.AskedUpstream {
		fetched[bgmID] = true
		rep.DdpAPICalls++
	}
	data, err := ddp.FetchEpisodesByBgmID(ctx, bgmID)
	if err != nil {
		// Checked before the generic failure because the caller has to abort
		// on it, not count it.  A spent group refuses every subsequent row
		// identically, so continuing spends ~800ms per row to learn the same
		// thing thousands of times.
		out.Class = classifyFetchError(err)
		out.Err = err.Error()
		return out
	}
	if data == nil {
		out.Class = epClassNoTitles
		return out
	}
	out.DdpAnilistID = data.AniListID

	// 3. Where the map was silent, dandanplay's cross-link is the only
	//    independent voucher for the binding.
	if !mapSpeaks {
		switch {
		case data.AniListID == 0:
			out.Class = epClassUndecided
			return out
		case data.AniListID != row.AnilistID:
			out.Class = epClassRebind
			return out
		}
	}

	// 4. Main episodes only.  NOT via BuildEpisodeMap: that function maps
	//    O1/S2 specials ONTO ordinary episode numbers and falls back to the
	//    whole list when no pure-numeric entry exists, which is right for
	//    matching a file to a danmaku track and exactly wrong here.
	titles := episodetitles.Usable(data.Episodes)
	out.UpstreamMain = episodetitles.CountMain(data.Episodes)
	out.TitlesUsable = len(titles)
	for _, t := range titles {
		if t.NameCn != "" {
			out.TitlesChinese++
		}
	}
	if len(titles) == 0 {
		out.Class = epClassNoTitles
		return out
	}
	if maxEp, over := episodetitles.ScopeExceeded(titles, row.Episodes); over {
		out.MaxEpisode = maxEp
		out.Class = epClassScopeMismatch
		return out
	}

	out.Class = epClassWritten
	rep.TitlesCN += out.TitlesChinese
	if !apply {
		// Report mode stops here having made every decision.
		return out
	}

	written, retracted, err := episodetitles.Apply(ctx, pool, q, row.AnilistID, bgmID, titles)
	if err != nil {
		out.Class = epClassFetchFail
		out.Err = err.Error()
		return out
	}
	out.Written, out.Retracted = written, retracted
	rep.TitlesWritten += written
	rep.Retracted += retracted
	return out
}

// nextEmptyStreak folds one row into the empty-streak counter.
//
// The rule is one sentence long and the first version got it wrong anyway:
// only a row that reached the network may move this counter, in either
// direction.
//
// What that version did instead was key on the class alone -- NO_TITLES
// increments, anything but SKIPPED resets -- and the result could not fire at
// all.  A production run watched upstream go quiet at ~4,700 requests and then
// walked 350 further rows without aborting, because 8.2% of its candidates
// shared a bgm subject with an earlier row and came back from the client's
// 24h in-process cache.  Those rows resolved to UNDECIDED or DDP_REBIND, which
// the old rule read as proof of life, and reset the streak about every twelfth
// row.  Nothing in the cached response had touched upstream.
//
// So: a row that consulted no upstream is neutral.  It neither accuses nor
// exonerates, which is the only honest thing a row with no evidence can do.
// classifyFetchError decides which class a failed fetch belongs in.
//
// Extracted from healOneRow because it is the whole of the decision and
// healOneRow is not reachable from a test (it takes a concrete
// *dandanplay.Client).  The distinction it draws is the one thing that
// stops the run: QUOTA_SPENT aborts, FETCH_FAIL is counted and walked past.
//
// errors.Is rather than a string match, and the test drives it through the
// real client so the assertion covers the actual wrapping chain -- checkStatus
// wraps the sentinel once and do() wraps that again, and a matcher that only
// worked on the bare sentinel would compile, pass a hand-written test, and
// never fire in production.
func classifyFetchError(err error) string {
	if errors.Is(err, dandanplay.ErrQuotaExceeded) {
		return epClassQuotaSpent
	}
	return epClassFetchFail
}

func nextEmptyStreak(streak int, askedUpstream bool, class string) int {
	if !askedUpstream {
		return streak
	}
	if class == epClassNoTitles {
		return streak + 1
	}
	return 0
}

// shouldAbortOnEmptyStreak decides whether a run of empty results means the
// upstream stopped answering rather than that the catalogue has a quiet patch.
//
// Two conditions, and the second is the one that keeps this from firing on a
// legitimately barren stretch:
//
//   - the streak has reached the threshold, and
//   - the pass has ALREADY written something.
//
// Without the second, a run that begins against a dead upstream would abort
// before proving there was ever anything to get, and the operator would be
// told "upstream stopped answering" about an upstream that never started.  A
// run that has written nothing at all is a different diagnosis -- credentials,
// network, the wrong database -- and deserves to be read as one.
//
// maxStreak == 0 disables the breaker, which is what a deliberate pass over a
// known-barren slice wants.
func shouldAbortOnEmptyStreak(streak, maxStreak, written int) bool {
	if maxStreak <= 0 {
		return false
	}
	return streak >= maxStreak && written > 0
}

// printEpisodeTitleSummary prints the table a human reads before --apply.
//
// The NO_TITLES share is called out separately because it is the one number
// that distinguishes a healthy run from a broken one without naming the
// failure: the client cannot tell a 4xx from an empty subject, so expired
// credentials arrive as a run where nearly everything is NO_TITLES rather than
// as an error.  A number on screen is a weaker guarantee than a typed outcome
// would be, and it is what is available until the client learns to
// distinguish them.
func printEpisodeTitleSummary(rep *epTitleReport) {
	fmt.Printf("\nEpisode-title heal (%s mode)\n", rep.Mode)
	fmt.Printf("%-14s %8s %8s\n", "CLASS", "COUNT", "PCT")
	fmt.Printf("%-14s %8s %8s\n", "──────────────", "────────", "────────")
	for _, c := range []string{
		epClassWritten, epClassNoTitles, epClassQuotaSpent, epClassScopeMismatch, epClassMapConflict,
		epClassRebind, epClassUndecided, epClassFetchFail, epClassSkipped,
	} {
		n := rep.Counts[c]
		pct := 0.0
		if rep.Total > 0 {
			pct = float64(n) / float64(rep.Total) * 100
		}
		fmt.Printf("%-14s %8d %7.1f%%\n", c, n, pct)
	}
	fmt.Printf("\n  dandanplay calls: %d\n", rep.DdpAPICalls)
	fmt.Printf("  titles usable:    %d (chinese: %d)\n", totalUsable(rep), rep.TitlesCN)
	if rep.Mode == "apply" {
		fmt.Printf("  titles written:   %d\n", rep.TitlesWritten)
		fmt.Printf("  rows retracted:   %d\n", rep.Retracted)
	}
	decided := rep.Total - rep.Counts[epClassSkipped]
	if decided > 0 {
		share := float64(rep.Counts[epClassNoTitles]) / float64(decided) * 100
		fmt.Printf("\n  NO_TITLES share:  %.1f%% of decided rows\n", share)
		if share > 50 {
			fmt.Printf("  ^ unusually high. The client reports a 4xx and an empty subject\n")
			fmt.Printf("    identically, so check DANDANPLAY_APP_ID/SECRET before trusting this.\n")
		}
	}
	if rep.Aborted {
		fmt.Printf("\n  ABORTED — this report is INCOMPLETE\n  %s\n", rep.AbortReason)
	}
	fmt.Println()
}

func totalUsable(rep *epTitleReport) int {
	n := 0
	for _, r := range rep.Rows {
		n += r.TitlesUsable
	}
	return n
}

func firstNonNil(vals ...*string) string {
	for _, v := range vals {
		if v != nil && *v != "" {
			return *v
		}
	}
	return ""
}
