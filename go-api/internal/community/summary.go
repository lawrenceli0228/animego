package community

import (
	"context"
	"errors"
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"golang.org/x/sync/errgroup"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/httpx"
)

const (
	// summaryPageSize is the first page of each list the tab opens with.
	summaryPageSize = 10
	// defaultWatchers / maxWatchers bound the 谁在追 card.
	defaultWatchers = 12
	maxWatchers     = 50
	// summaryParallelism caps how many pool connections one summary holds
	// at once; it reads about ten things.
	summaryParallelism = 4
)

// Summary implements GET /api/anime/{anilistId}/community: the first page of
// every list on the tab in one response.  It is what the page server-renders
// (anonymously, so it can be cached for everyone) and what the page re-reads
// with the reader's session once it has loaded, which adds their private
// review, their votes and likes, and `viewer`.
func (h *Handlers) Summary(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()
	anilistID, ok := h.animeFromPath(ctx, w, r)
	if !ok {
		return
	}
	viewer := viewerID(r)

	var out summaryDTO
	g, gctx := errgroup.WithContext(ctx)
	g.SetLimit(summaryParallelism)
	g.Go(func() error {
		page, err := h.reviewPage(gctx, anilistID, viewer, 1, summaryPageSize)
		out.Reviews = page
		return err
	})
	g.Go(func() error {
		page, err := h.threadPage(gctx, anilistID, viewer, 1, summaryPageSize)
		out.Threads = page
		return err
	})
	g.Go(func() error {
		page, err := h.activityPage(gctx, anilistID, viewer, 1, summaryPageSize)
		out.Activity = page
		return err
	})
	g.Go(func() error {
		watchers, err := h.watchers(gctx, anilistID, viewer, defaultWatchers)
		out.Watchers = watchers
		return err
	})
	if viewer != nil {
		g.Go(func() error {
			v, err := h.viewerState(gctx, anilistID, *viewer)
			out.Viewer = v
			return err
		})
	}
	if err := g.Wait(); err != nil {
		failServer(w, err, "community summary failed")
		return
	}
	httpx.Data(w, http.StatusOK, out)
}

// viewerState is the signed-in reader's own status for the anime and their
// live review, if any.
func (h *Handlers) viewerState(ctx context.Context, anilistID int32, userID uuid.UUID) (*viewerDTO, error) {
	state := &viewerDTO{}
	status, err := h.db.GetViewerSubscriptionStatus(ctx, userID, anilistID)
	switch {
	case err == nil:
		state.Status = &status
	case !errors.Is(err, pgx.ErrNoRows):
		return nil, err
	}
	rows, err := h.db.QueryAnimeReviews(ctx, dbgen.QueryAnimeReviewsParams{
		ViewerID:  &userID,
		AnilistID: anilistID,
		AuthorID:  &userID,
		PageLimit: 1,
	})
	if err != nil {
		return nil, err
	}
	if len(rows) > 0 {
		id := rows[0].ID
		state.ReviewID = &id
	}
	return state, nil
}

// ListWatchers implements GET /watchers: the 谁在追 card — everyone with the
// anime on their list, any status, most recent change first, with counts
// per status.  ?limit= up to 50.
func (h *Handlers) ListWatchers(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()
	anilistID, ok := h.animeFromPath(ctx, w, r)
	if !ok {
		return
	}
	limit := positiveInt(r.URL.Query().Get("limit"), defaultWatchers)
	if limit > maxWatchers {
		limit = maxWatchers
	}
	watchers, err := h.watchers(ctx, anilistID, viewerID(r), int32(limit))
	if err != nil {
		failServer(w, err, "list watchers failed")
		return
	}
	httpx.Data(w, http.StatusOK, watchers)
}

func (h *Handlers) watchers(ctx context.Context, anilistID int32, viewer *uuid.UUID, limit int32) (watchersDTO, error) {
	rows, err := h.db.ListAnimeFollowers(ctx, anilistID, viewer, limit)
	if err != nil {
		return watchersDTO{}, err
	}
	counts, err := h.db.CountAnimeFollowers(ctx, anilistID, viewer)
	if err != nil {
		return watchersDTO{}, err
	}
	return toWatchers(rows, counts), nil
}
