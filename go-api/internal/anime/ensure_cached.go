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

// EnsureCachedDB is the sqlc subset EnsureCached uses.  Two methods:
//
//   - GetAnimeMainByID: existence probe (cheap PK lookup).
//   - UpsertAnimeCache: write the row sourced from anilist.
type EnsureCachedDB interface {
	GetAnimeMainByID(ctx context.Context, anilistID int32) (dbgen.GetAnimeMainByIDRow, error)
	UpsertAnimeCache(ctx context.Context, arg dbgen.UpsertAnimeCacheParams) error
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
//
// Returns:
//   - nil when the row already existed OR we successfully fetched + upserted.
//   - ErrAnilistNotFound when AniList has no media for that id.
//   - Wrapped error for other failures (network, parse, DB write).
//
// The row is only ever upserted via the lightweight main-row projection
// (no children).  If callers need children populated (relations,
// characters, staff), they should fall through to DetailService — this
// helper is intentionally minimal because subscription create only
// needs the FK target row to exist.
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

	params := NormalizeMainRow(resp.Media)
	if err := db.UpsertAnimeCache(ctx, params); err != nil {
		return fmt.Errorf("ensure_cached: upsert anime_cache (%d): %w", anilistID, err)
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
