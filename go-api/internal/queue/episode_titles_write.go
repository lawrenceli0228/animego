// episode_titles_write.go — the single loop that turns normalised episode
// titles into anime_episode_titles rows.
//
// Two workers write this table from the Bangumi side: BangumiV2Worker, as the
// last step of a full enrichment run, and EpisodesBgmWorker, after its identity
// gate accepts a binding.  Until this file they each carried their own copy of
// the same five-line loop — same signature, same best-effort stance, same
// failure counting — and the copies had already started to drift in their log
// wording.  A third writer was about to make it three.
//
// The stance the loop encodes, and the reason it is worth naming once rather
// than three times:
//
//	Individual row failures are counted, not returned.  Both callers reach
//	this point AFTER their authoritative write has already committed — V2 has
//	written the subject and characters, the sweep has written the inferred
//	episode count — and both deliberately treat per-episode names as the
//	optional tail of that work.  Returning an error here would fail a job
//	whose real work succeeded, and river would then re-spend the upstream
//	requests that produced it.  So the caller gets a count and decides what to
//	say about it.
//
// What this helper does NOT own is the precedence between sources.  That rule
// — manual outranks dandanplay outranks Bangumi, and a non-empty value is never
// overwritten with an empty one — lives in the SQL of the upsert itself, so
// that every writer inherits it whether or not it routes through this file.
// Putting it here instead would have made the invariant depend on remembering
// to call the right Go function, which is exactly the kind of guarantee this
// table has already lost once.
package queue

import "context"

// episodeTitleUpserter is the narrow write surface writeEpisodeTitles needs.
//
// Declared here rather than reusing V2Writer or EpisodesBgmWriter because the
// helper genuinely needs one method, and a one-method interface is what lets
// both of those satisfy it without either importing the other's shape.
type episodeTitleUpserter interface {
	UpsertEpisodeTitle(ctx context.Context, animeID int32, episode int32, nameCN *string, name *string) error
}

// writeEpisodeTitles upserts every title in the slice, returning how many
// landed and how many failed.  It never returns an error; see the file comment
// for why that is the contract rather than an oversight.
func writeEpisodeTitles(
	ctx context.Context,
	db episodeTitleUpserter,
	anilistID int32,
	titles []epTitle,
) (written, failures int) {
	for _, t := range titles {
		if err := db.UpsertEpisodeTitle(ctx, anilistID, t.episode, t.nameCN, t.name); err != nil {
			failures++
			continue
		}
		written++
	}
	return written, failures
}
