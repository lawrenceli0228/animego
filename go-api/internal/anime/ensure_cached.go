// Package anime — ensure_cached.go exposes EnsureCached, the helper
// /api/subscriptions POST handlers call before INSERTing a subscription.
//
// Express's POST /api/subscriptions called `anilistService.getAnimeDetail`
// to side-effect the anime_cache row before the Mongoose findOneAndUpdate.
// Postgres has a FK from subscriptions.anilist_id to anime_cache, so the
// equivalent is: ensure the row exists before INSERTing, else the FK
// blows up.  EnsureCached centralises that "lookup → fetch → upsert"
// flow so handlers stay readable.

package anime

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"github.com/jackc/pgx/v5"

	"github.com/lawrenceli0228/animego/go-api/internal/anilist"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// AniListDetailFetcher is the tiny interface EnsureCached needs from the
// anilist client.  Declared at use-site so tests can substitute a fake
// without standing up an HTTP server.  *anilist.Client satisfies it
// out of the box.
type AniListDetailFetcher interface {
	Detail(ctx context.Context, v anilist.DetailVars) (*anilist.AnimeDetailResponse, error)
}

// EnsureCachedDB is the sqlc subset EnsureCached uses: GetAnimeMainByID,
// the existence probe (cheap PK lookup), and the detail refresh's writer,
// because a fill stores the same document the refresh does.
// *dbgen.Queries satisfies it.
type EnsureCachedDB interface {
	GetAnimeMainByID(ctx context.Context, anilistID int32) (dbgen.GetAnimeMainByIDRow, error)
	DetailWriter
}

// ErrAnilistNotFound is returned when AniList responds with no Media
// matching the requested id (or the upstream call returns a NOT_FOUND
// shape).  Handlers map this → 404 "Anime not found".
//
// Other errors (network, 5xx, parse) bubble up wrapped — they
// represent infrastructure problems, not user-side "this id doesn't
// exist".
var ErrAnilistNotFound = errors.New("anilist: media not found")

// EnsureCached guarantees an anime_cache row exists for anilistID.
//
// Flow:
//  1. Probe via GetAnimeMainByID; on hit return nil (cache already has it).
//  2. On miss (pgx.ErrNoRows), call anilist.Detail({ID: anilistID}).
//  3. Normalize the Media response via NormalizeMainRow.
//  4. Upsert via UpsertAnimeCache.
//  5. Store the child tables from the same document (writeDetailChildren).
//
// Returns:
//   - nil when the row already existed OR we successfully fetched + upserted.
//   - ErrAnilistNotFound when AniList has no media for that id.
//   - Wrapped error for other failures (network, parse, main-row write).
//
// Step 5 is not optional, although the subscription only needs the row
// to exist.  The document is AnimeDetailQuery's, so the row is stamped
// detail-fetched (and fresh), and the detail page re-fetches a stamped
// fresh row only after the 24h TTL: a fill that stored the main row
// alone left a title with no characters, staff, genres or relations for
// a day.  A failure in step 5 is logged rather than returned -- the
// subscription can go ahead -- and leaves the same partial state a
// failed detail refresh does.
func EnsureCached(ctx context.Context, db EnsureCachedDB, ac AniListDetailFetcher, anilistID int32) error {
	if _, err := db.GetAnimeMainByID(ctx, anilistID); err == nil {
		// Already cached.
		return nil
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("ensure_cached: probe anime_cache (%d): %w", anilistID, err)
	}

	// Cache miss → fetch from AniList.
	resp, err := ac.Detail(ctx, anilist.DetailVars{ID: int(anilistID)})
	if err != nil {
		return fmt.Errorf("ensure_cached: anilist Detail (%d): %w", anilistID, err)
	}
	if resp == nil || resp.Media.ID == 0 {
		return ErrAnilistNotFound
	}

	// ac.Detail runs AnimeDetailQuery, which selects trailer and every
	// child table.
	params := NormalizeMainRow(resp.Media, anilist.DetailDocument)
	if err := db.UpsertAnimeCache(ctx, params); err != nil {
		return fmt.Errorf("ensure_cached: upsert anime_cache (%d): %w", anilistID, err)
	}
	if err := writeDetailChildren(ctx, db, anilistID, resp.Media); err != nil {
		slog.WarnContext(ctx, "anime.ensure_cached: child tables not stored",
			"anilist_id", anilistID, "err", err)
	}

	slog.InfoContext(ctx, "anime.ensure_cached: filled cache miss",
		"anilist_id", anilistID,
		"title_romaji", derefStr(params.TitleRomaji),
	)
	return nil
}

// derefStr returns the pointed string, or "" when nil.  Tiny log helper
// — sibling normalize.go declares its own generic `deref` with a
// different signature, hence the distinct name.
func derefStr(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
