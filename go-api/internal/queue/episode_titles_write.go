// episode_titles_write.go — the single loop that turns normalised episode
// titles into anime_episode_titles rows.
//
// Two workers write this table from the Bangumi side: BangumiV2Worker, as the
// last step of a full enrichment run, and EpisodesBgmWorker, after its identity
// gate accepts a binding.  Before this file they each carried their own copy of
// the same five-line loop — same signature, same best-effort stance, same
// failure counting — and the copies had already started to drift in their log
// wording.
//
// # Why this writes through the SOURCED upsert
//
// Migration 0029 gave the table per-field provenance, and a second writer
// (dandanplay, via cmd/bgmbackfill and the airing sweep) now labels its rows
// 'ddp'.  For one release this loop still used the pre-0029 statement, which
// sets `name` and `name_cn` and does not touch the source columns at all.  That
// is not a cosmetic gap: overwriting a 'ddp' row with a Bangumi value leaves
// the VALUE from one source wearing the LABEL of another, and the next writer
// then scores its precedence against a claim that is not true.
//
// It is also not hypothetical — it happened.  A production run left 2,010 rows
// in exactly that shape, 1,966 of them holding a 'ddp' label over two NULL
// values, written by the hourly episodes_bgm sweep passing over rows the
// dandanplay backfill had just filled.  Migration 0030 repairs those rows;
// this file is what stops them being made again.
//
// 0029's own comment names the invariant and why the schema cannot hold it: a
// CHECK sees the row after the write, not the transition, so it cannot tell a
// value that was replaced alongside its source from one that was replaced
// without it.  The only place that pairing can be guaranteed is the statement
// doing the writing, which means every writer has to use the same one.
//
// # The binding pin arrives with it
//
// UpsertEpisodeTitleSourced resolves anime_id through anime_cache with
// `bgm_id = @bgm_id`, so a write whose binding moved between the fetch and the
// upsert affects zero rows instead of filing one subject's episode names under
// another.  Both callers already hold the id they fetched with, and both
// already re-read it once before getting here; this closes the remainder of
// that window.  A zero-row result is counted as a failure — it is one, just a
// silent kind — and the caller logs it with the rest.
//
// # Why failures are counted and not returned
//
// Both callers reach this point AFTER their authoritative write has already
// committed: V2 has written the subject and characters, the sweep has written
// the inferred episode count.  Both deliberately treat per-episode names as the
// optional tail of that work.  Returning an error here would fail a job whose
// real work succeeded, and river would then re-spend the upstream requests that
// produced it.  So the caller gets a count and decides what to say about it.
package queue

import (
	"context"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// episodeTitleSourceBangumi is the provenance label both callers write under.
//
// A constant rather than a parameter on purpose: every caller of this function
// reads from Bangumi's /subject/{id}/ep, and a source argument would invite a
// future writer to pass its own label through a loop whose normalisation and
// numbering are Bangumi-shaped.  A dandanplay writer already exists and
// deliberately does not route through here — see internal/episodetitles.
const episodeTitleSourceBangumi = "bangumi"

// episodeTitleUpserter is the narrow write surface writeEpisodeTitles needs.
//
// Declared here rather than reusing V2Writer or EpisodesBgmWriter because the
// helper genuinely needs one method, and a one-method interface is what lets
// both of those satisfy it without either importing the other's shape.
type episodeTitleUpserter interface {
	UpsertEpisodeTitleSourced(ctx context.Context, arg dbgen.UpsertEpisodeTitleSourcedParams) (int64, error)
}

// writeEpisodeTitles upserts every title in the slice under the 'bangumi'
// source, returning how many landed and how many failed.  It never returns an
// error; see the file comment for why that is the contract rather than an
// oversight.
//
// bgmID is the binding the titles were fetched under.  It is not decoration:
// the query refuses to write when anime_cache no longer holds it.
func writeEpisodeTitles(
	ctx context.Context,
	db episodeTitleUpserter,
	anilistID, bgmID int32,
	titles []epTitle,
) (written, failures int) {
	for _, t := range titles {
		n, err := db.UpsertEpisodeTitleSourced(ctx, dbgen.UpsertEpisodeTitleSourcedParams{
			Episode: t.episode,
			NameCn:  derefOrEmpty(t.nameCN),
			Name:    derefOrEmpty(t.name),
			Source:  episodeTitleSourceBangumi,
			AnimeID: anilistID,
			BgmID:   bgmID,
		})
		// n == 0 means the binding moved underneath this write, or the row
		// carried nothing storable.  Neither is an error the job should fail
		// on, and both are worth the caller's failure count: a run whose
		// writes silently affect no rows looks identical to a run that did
		// nothing, which is the one thing this counter exists to distinguish.
		if err != nil || n == 0 {
			failures++
			continue
		}
		written++
	}
	return written, failures
}

// derefOrEmpty flattens the nil-able strings normalizeEpisodeTitles produces
// into the plain strings the sourced upsert takes.
//
// The query does its own trimming and its own emptiness test — btrim over an
// explicit character set, then NULLIF — so passing "" is exactly equivalent to
// passing NULL and the distinction does not need to survive this boundary.
func derefOrEmpty(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
