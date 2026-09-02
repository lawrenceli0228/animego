// Package episodetitles holds the write sequence that turns a dandanplay
// episode list into anime_episode_titles rows.
//
// It exists as its own package for one reason: two callers need the identical
// sequence and they cannot import each other.  cmd/bgmbackfill drains the
// backlog once, from a shell, under a human's eye; internal/queue re-asks the
// airing slice on a timer.  A CLI cannot import internal/queue without pulling
// river into a one-shot binary, and internal/queue has no business importing a
// command.  So the sequence lives below both.
//
// The alternative was to let each keep its own copy, and that is precisely the
// state internal/queue/episode_titles_write.go was created to end: two workers
// with the same five-line loop that had already drifted in their logging.
// Writing the second copy on the same day the first was removed would have
// been a strange thing to do.
//
// The dependencies are deliberately thin — pgx, the generated queries, and the
// dandanplay types.  Nothing here knows about river, HTTP, or flags, so both
// callers pay only for what they use.
package episodetitles

import (
	"context"
	"fmt"
	"strconv"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lawrenceli0228/animego/go-api/internal/dandanplay"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// Source is the provenance label every row written through this package
// carries.  Migration 0029 defines the vocabulary and the precedence order;
// this is the only place the dandanplay path names its own position in it.
const Source = "ddp"

// Title is one normalised episode ready to be written.  Exactly one of NameCn
// and Name is non-empty — see dandanplay.NormalizeDandanEpisodeTitle, which
// decides which.
type Title struct {
	Episode int32
	NameCn  string
	Name    string
}

// Usable keeps the entries that are both a main episode and carry something
// storable.
//
// Main-episode detection is strconv.Atoi on rawEpisodeNumber, NOT
// dandanplay.BuildEpisodeMap.  That function exists to match a local file to a
// danmaku track: it deliberately maps O1/S2 specials ONTO ordinary episode
// numbers, and falls back to the entire list when no pure-numeric entry
// exists.  Both behaviours are correct there and wrong here, where a special
// must not be written into an ordinary episode's slot.  A failed Atoi IS the
// filter, and it rejects fractional numbering ("1.5") for the same reason: the
// destination keys on an integer episode and a half-episode has no slot.
//
// An entry whose title normalises to nothing on both sides is dropped rather
// than written.  A row of two NULLs renders exactly like no row at all, so it
// helps no reader, while making "how many titles do we hold for this anime"
// unanswerable by counting rows — a question this table has already lost the
// ability to answer for roughly a third of its contents.
func Usable(eps []dandanplay.DandanEpisode) []Title {
	out := make([]Title, 0, len(eps))
	for _, e := range eps {
		n, err := strconv.Atoi(e.RawEpisodeNumber)
		if err != nil || n <= 0 {
			continue
		}
		cn, name := dandanplay.NormalizeDandanEpisodeTitle(e.Title)
		if cn == "" && name == "" {
			continue
		}
		out = append(out, Title{Episode: int32(n), NameCn: cn, Name: name})
	}
	return out
}

// CountMain counts main entries whether or not they carried a usable title.
//
// Kept separate from Usable because the two answer different questions and a
// caller wants both: Usable says what can be written, CountMain says how long
// upstream thinks the season is.  Compared against anime_cache.episodes the
// latter is the scope-mismatch signal — a three-episode ONA bound to a
// full-series subject reports hundreds here — which nothing in this package
// acts on, and which callers are expected to record so the question can later
// be decided from a distribution rather than a guessed threshold.
func CountMain(eps []dandanplay.DandanEpisode) int {
	n := 0
	for _, e := range eps {
		if v, err := strconv.Atoi(e.RawEpisodeNumber); err == nil && v > 0 {
			n++
		}
	}
	return n
}

// Apply writes one anime's titles as a single transaction.
//
// The four statements are one unit and a partial application is worse than not
// having run at all:
//
//	upsert     states what this source now holds
//	clear      withdraws what it used to hold and no longer does
//	delete     removes the rows the withdrawal emptied
//	touch      records the attempt so the sweep moves on
//
// Titles without the withdrawal leave a stale tail in place under fresh rows;
// a withdrawal without the stamp re-does the whole anime on the next pass.
//
// A zero-row upsert aborts the whole anime rather than continuing.  Zero rows
// can only mean the query's bgm_id predicate did not match, i.e. the binding
// changed between the fetch and this transaction — so every remaining title in
// the slice describes a subject this row no longer holds, and writing the tail
// of that list is the exact failure the predicate exists to prevent.
func Apply(
	ctx context.Context,
	pool *pgxpool.Pool,
	q *dbgen.Queries,
	anilistID, bgmID int32,
	titles []Title,
) (written, retracted int, err error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return 0, 0, fmt.Errorf("episodetitles: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	qtx := q.WithTx(tx)

	kept := make([]int32, 0, len(titles))
	for _, t := range titles {
		n, err := qtx.UpsertEpisodeTitleSourced(ctx, dbgen.UpsertEpisodeTitleSourcedParams{
			Episode: t.Episode,
			NameCn:  t.NameCn,
			Name:    t.Name,
			Source:  Source,
			AnimeID: anilistID,
			BgmID:   bgmID,
		})
		if err != nil {
			return 0, 0, fmt.Errorf("episodetitles: upsert ep %d: %w", t.Episode, err)
		}
		if n == 0 {
			return 0, 0, fmt.Errorf(
				"episodetitles: binding moved during write (anilist=%d bgm=%d)", anilistID, bgmID)
		}
		written++
		kept = append(kept, t.Episode)
	}

	cleared, err := qtx.ClearEpisodeTitlesBySourceOutside(ctx, Source, anilistID, kept)
	if err != nil {
		return 0, 0, fmt.Errorf("episodetitles: clear outside: %w", err)
	}
	if len(cleared) > 0 {
		if _, err := qtx.DeleteEmptyEpisodeTitles(ctx, anilistID, cleared); err != nil {
			return 0, 0, fmt.Errorf("episodetitles: delete emptied: %w", err)
		}
	}
	retracted = len(cleared)

	if _, err := qtx.TouchEpisodeTitlesAt(ctx, anilistID, bgmID); err != nil {
		return 0, 0, fmt.Errorf("episodetitles: touch: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return 0, 0, fmt.Errorf("episodetitles: commit: %w", err)
	}
	return written, retracted, nil
}
