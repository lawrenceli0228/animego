package social

// feed.go — GET /api/feed (auth required).
//
// Replaces server/controllers/profile.controller.js getFeed.  Express:
//   1. Find all follows where followerId = caller (limit 500).
//   2. Find subscriptions where userId IN follows AND lastWatchedAt!=null,
//      sorted by lastWatchedAt DESC, paginated.
//   3. Count subscriptions matching the same filter for hasMore.
//   4. Find AnimeCache for the union of anilist_ids.
//   5. Project to { username, anilistId, title, titleChinese, coverImageUrl,
//      episode, status, lastWatchedAt }.
//
// Postgres collapses (2)+(4) into one JOIN (ListFeedActivities); (3)
// remains a separate count.  Round-trip drops from 4 to 3 (or 1 when
// the caller follows nobody — we short-circuit before issuing the
// activity queries).
//
// Response envelope is intentionally NOT httpx.Page because Express
// emits `{ data, hasMore, nextPage }` — no `total` field.  We use the
// dedicated feedResponse struct + writeFeedJSON helper instead.

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"

	"golang.org/x/sync/errgroup"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/httpx"
	"github.com/lawrenceli0228/animego/go-api/internal/jwtx"
)

// GetFeed implements GET /api/feed?page=1 — chronological feed of
// watching activity from followed users.  Per-page size is 20.
//
// Routing: install with jwtx.RequireAuth.  Defensive ClaimsFrom check
// handles the misconfigured-router case (500 SERVER_ERROR).
func (h *Handlers) GetFeed(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()

	claims, ok := jwtx.ClaimsFrom(r.Context())
	if !ok || claims == nil {
		httpx.Fail(w, httpx.NewError(http.StatusInternalServerError, httpx.CodeServerError, msgMissingAuthClaims))
		return
	}

	page := parsePage(r)

	followees, err := h.Queries.ListFeedFolloweeIDs(ctx, claims.UserID)
	if err != nil {
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "feed followees lookup failed"))
		return
	}

	// Short-circuit:  caller follows nobody → empty feed.  Matches
	// Express's `if (followeeIds.length === 0) return res.json(...)`.
	if len(followees) == 0 {
		writeFeedJSON(w, http.StatusOK, feedResponse{
			Data:     []feedItem{},
			HasMore:  false,
			NextPage: nil,
		})
		return
	}

	offset := int32((page - 1) * listPageSize)

	var (
		rows  []dbgen.ListFeedActivitiesRow
		total int64
	)
	g, gctx := errgroup.WithContext(ctx)
	g.Go(func() error {
		got, err := h.Queries.ListFeedActivities(gctx, followees, listPageSize, offset)
		if err != nil {
			return err
		}
		rows = got
		return nil
	})
	g.Go(func() error {
		got, err := h.Queries.CountFeedActivities(gctx, followees)
		if err != nil {
			return err
		}
		total = got
		return nil
	})
	if err := g.Wait(); err != nil {
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "feed query failed"))
		return
	}

	hasMore := int64((page-1)*listPageSize+listPageSize) < total
	var nextPage *int
	if hasMore {
		nextPage = intPtr(page + 1)
	}

	writeFeedJSON(w, http.StatusOK, feedResponse{
		Data:     mapFeedRows(rows),
		HasMore:  hasMore,
		NextPage: nextPage,
	})
}

// mapFeedRows converts the sqlc rows into the API response shape.
// Express byte-exact projection:
//
//	title:         row.TitleRomaji || "Anime #N"
//	titleChinese:  row.TitleChinese || null
//	coverImageUrl: row.CoverImageUrl || null
//	episode:       row.CurrentEpisode    (renamed from currentEpisode)
//	status:        row.Status            (subscription status)
//
// nil slice in → empty slice out so the JSON envelope always contains
// `"data":[]` rather than `"data":null`.
func mapFeedRows(rows []dbgen.ListFeedActivitiesRow) []feedItem {
	if len(rows) == 0 {
		return []feedItem{}
	}
	out := make([]feedItem, len(rows))
	for i, row := range rows {
		title := fallbackTitle(row.TitleRomaji, row.AnilistID)
		out[i] = feedItem{
			Username:      row.Username,
			AnilistID:     row.AnilistID,
			Title:         title,
			TitleChinese:  row.TitleChinese,
			CoverImageUrl: row.CoverImageUrl,
			Episode:       row.CurrentEpisode,
			Status:        row.Status,
			LastWatchedAt: row.LastWatchedAt,
		}
	}
	return out
}

// fallbackTitle returns the AniList Romaji title when present, or
// `Anime #<id>` when the anime_cache LEFT JOIN produced NULL.  Matches
// Express's `animeMap[s.anilistId]?.titleRomaji || `Anime #${s.anilistId}``.
//
// Empty string is treated the same as nil — Express's `||` falls back
// on falsy values, which include "" alongside null/undefined.
func fallbackTitle(romaji *string, anilistID int32) string {
	if romaji != nil && *romaji != "" {
		return *romaji
	}
	return "Anime #" + strconv.FormatInt(int64(anilistID), 10)
}

// writeFeedJSON serialises the feed envelope directly — we can't reuse
// httpx.Page because the Express shape omits `total`, and writing a
// custom marshaller in feed.go keeps the field ordering visible at the
// call site (data → hasMore → nextPage, matching Express byte-for-byte).
//
// Behaviour mirrors httpx.writeJSON (internal/httpx/envelope.go:writeJSON):
// HTML escaping off, trailing newline trimmed, Content-Type set.
func writeFeedJSON(w http.ResponseWriter, status int, body feedResponse) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(body); err != nil {
		slog.Warn("feed envelope marshal failed", "err", err)
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":{"code":"SERVER_ERROR","message":"internal error"}}`))
		return
	}
	out := bytes.TrimRight(buf.Bytes(), "\n")

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if _, err := w.Write(out); err != nil {
		slog.Warn("feed envelope write failed", "err", err)
	}
}
