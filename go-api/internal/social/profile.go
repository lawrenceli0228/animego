package social

// profile.go — GET /api/users/:username (optional auth).
//
// Replaces server/controllers/profile.controller.js getProfile.  The
// Express handler ran four queries via Promise.all:
//   - Subscription.find(...).limit(200)        // watching list
//   - Follow.countDocuments(followeeId)        // followerCount
//   - Follow.countDocuments(followerId)        // followingCount
//   - Follow.exists({follower, followee}) | null   // isFollowing
// then a second AnimeCache.find($in: anilistIds) to attach metadata.
//
// Postgres collapses the watch-list + anime metadata into a single
// JOIN (ListProfileWatching), and the two follower counts into one
// correlated-subqueries row (GetProfileCounts).  Net round-trip drops
// from 5 to 3 (or 2 when caller is anon — FollowExists is skipped).
//
// isFollowing semantics:
//   - anon caller (no JWT)        →  JSON null
//   - auth'd caller, not following →  JSON false
//   - auth'd caller, following     →  JSON true
//
// Encoded via *bool with NO omitempty — nil marshals to `null`, &true
// to `true`, &false to `false`.

import (
	"context"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"golang.org/x/sync/errgroup"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/httpx"
	"github.com/lawrenceli0228/animego/go-api/internal/jwtx"
)

// GetProfile implements GET /api/users/:username — public profile +
// watching list, with `isFollowing` filled in when the caller is
// authenticated.  Anon callers see isFollowing=null.
//
// Routing: install with jwtx.OptionalAuth so claims are attached when
// a valid token is present, but missing/invalid tokens still reach
// this handler (with no claims) instead of being 401'd upstream.
func (h *Handlers) GetProfile(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()

	username := chi.URLParam(r, "username")
	user, err := h.Queries.GetUserIDByUsername(ctx, username)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Fail(w, httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, msgUserNotFound))
			return
		}
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "profile lookup failed"))
		return
	}

	// requesterID is the *uuid.UUID of the authenticated caller, or
	// nil when the caller is anon.  Drives whether the FollowExists
	// goroutine fires and whether IsFollowing in the response is
	// `null` vs true/false.
	var requesterID *uuid.UUID
	if claims, ok := jwtx.ClaimsFrom(r.Context()); ok && claims != nil {
		id := claims.UserID
		requesterID = &id
	}

	var (
		counts        dbgen.GetProfileCountsRow
		watchingRows  []dbgen.ListProfileWatchingRow
		isFollowingDB bool
	)
	g, gctx := errgroup.WithContext(ctx)
	g.Go(func() error {
		row, err := h.Queries.GetProfileCounts(gctx, user.ID)
		if err != nil {
			return err
		}
		counts = row
		return nil
	})
	g.Go(func() error {
		rows, err := h.Queries.ListProfileWatching(gctx, user.ID)
		if err != nil {
			return err
		}
		watchingRows = rows
		return nil
	})
	if requesterID != nil {
		// Capture by value — once requesterID is non-nil it doesn't
		// change for the duration of the request.
		rid := *requesterID
		g.Go(func() error {
			got, err := h.Queries.FollowExists(gctx, rid, user.ID)
			if err != nil {
				return err
			}
			isFollowingDB = got
			return nil
		})
	}
	if err := g.Wait(); err != nil {
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "profile query failed"))
		return
	}

	// IsFollowing pointer logic:  anon → nil, auth → &(query result).
	var isFollowing *bool
	if requesterID != nil {
		v := isFollowingDB
		isFollowing = &v
	}

	httpx.Data(w, http.StatusOK, profileResponse{
		Username:       user.Username,
		CreatedAt:      user.CreatedAt,
		FollowerCount:  counts.FollowerCount,
		FollowingCount: counts.FollowingCount,
		IsFollowing:    isFollowing,
		Watching:       mapWatching(watchingRows),
	})
}

// mapWatching converts the sqlc rows into the API response shape.
// Field renames:
//
//	row.Status      →  watchingItem.SubscriptionStatus  (avoid collision with anime.status)
//	row.AnimeStatus →  watchingItem.Status              (anime's own status field)
//
// Other fields pass through verbatim.  nil slice in maps to an empty
// slice out so the JSON envelope always contains `"watching":[]`
// rather than `"watching":null`.
func mapWatching(rows []dbgen.ListProfileWatchingRow) []watchingItem {
	if len(rows) == 0 {
		return []watchingItem{}
	}
	out := make([]watchingItem, len(rows))
	for i, row := range rows {
		out[i] = watchingItem{
			AnilistID:          row.AnilistID,
			TitleRomaji:        row.TitleRomaji,
			TitleEnglish:       row.TitleEnglish,
			TitleNative:        row.TitleNative,
			TitleChinese:       row.TitleChinese,
			CoverImageUrl:      row.CoverImageUrl,
			CoverImageColor:    row.CoverImageColor,
			PosterAccent:       row.PosterAccent,
			Episodes:           row.Episodes,
			Season:             row.Season,
			SeasonYear:         row.SeasonYear,
			Format:             row.Format,
			Status:             row.AnimeStatus,
			SubscriptionStatus: row.Status,
			CurrentEpisode:     row.CurrentEpisode,
			LastWatchedAt:      row.LastWatchedAt,
		}
	}
	return out
}
