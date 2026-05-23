// Package danmaku owns the /api/danmaku/* HTTP handlers — read-only
// bullet-screen retrieval ported from
// server/controllers/danmaku.controller.js.
//
// One endpoint backs this surface (Phase 2.5.1):
//
//	GET /api/danmaku/:anilistId/:episode  — GetDanmaku  (public)
//
// Writes are handled out-of-band through socket.io (P2.8) and are not
// part of this package.
//
// Envelope shape is special:  the response has `liveEndsAt` as a SIBLING
// of `data` at the top level, not nested inside.  httpx.Data wraps a
// payload in `{"data":…}` and doesn't allow siblings, so this package
// owns a custom envelope writer (writeDanmakuJSON) that mirrors the
// httpx.writeJSON byte-output rules (HTML escaping off, no trailing
// newline).
package danmaku

// handlers.go — Handlers struct + constructor + GetDanmaku + custom
// envelope writer.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/sync/errgroup"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/httpx"
)

// queryTimeout bounds every DB round-trip in this package.  Matches
// the 5s budget used by internal/admin / internal/auth / internal/social
// / internal/comments so a stalled Postgres surfaces consistently
// across surfaces.
const queryTimeout = 5 * time.Second

// msgInvalidParams is emitted for path-parameter validation failures.
// Matches the Express controller's VALIDATION_ERROR message byte-for-byte
// (server/controllers/danmaku.controller.js:10).  Express used the
// code VALIDATION_ERROR; we mirror the message but route via
// CodeBadRequest because the spec asks for it — "Invalid params" is the
// canonical FE i18n key.
const msgInvalidParams = "Invalid params"

// DanmakuDB is the sqlc subset the danmaku handler consumes.  Defined
// at the use-site per "accept interfaces, return structs" so tests can
// substitute a fake without dragging the full dbgen.Querier surface
// into the test setup.
//
// Two methods cover the one endpoint:  ListDanmakuRecent for the
// chronological bullet-screen list, GetEpisodeWindow for the optional
// liveEndsAt timestamp.
type DanmakuDB interface {
	ListDanmakuRecent(ctx context.Context, anilistID int32, episode int32) ([]dbgen.ListDanmakuRecentRow, error)
	GetEpisodeWindow(ctx context.Context, anilistID int32, episode int32) (dbgen.EpisodeWindow, error)
}

// Handlers carries the deps shared by every danmaku handler.  Construct
// once at startup via NewHandlers and register each method on the chi
// router (no auth needed — danmaku reads are public).
//
// Pool is exposed for parity with sibling Handlers types (admin,
// social, comments); the current GetDanmaku impl only goes through the
// Queries interface and does not consume Pool directly.
type Handlers struct {
	Pool    *pgxpool.Pool
	Queries DanmakuDB
}

// NewHandlers constructs a Handlers bundle.  pool must be non-nil and
// queries must implement DanmakuDB.  Both are required at boot — a nil
// dependency would crash on the first request, so we fail fast with a
// panic here to flag misconfiguration during startup smoke tests rather
// than at request time.
func NewHandlers(pool *pgxpool.Pool, queries DanmakuDB) *Handlers {
	if pool == nil {
		panic("danmaku.NewHandlers: nil Pool")
	}
	if queries == nil {
		panic("danmaku.NewHandlers: nil DanmakuDB")
	}
	return &Handlers{
		Pool:    pool,
		Queries: queries,
	}
}

// danmakuItem is the per-row response shape for one bullet-screen
// message.  Field names match the Express `.select('username content
// createdAt')` projection plus the implicit `id` (Mongo emitted `_id`,
// but our schema uses bigint generated identity — and the spec asks
// for `id` lower-case).
//
// CreatedAt is *time.Time so the JSON marshaller emits RFC3339 strings;
// the conversion from pgtype.Timestamptz happens in mapDanmakuRows so
// the response payload is type-stable.
type danmakuItem struct {
	ID        int64     `json:"id"`
	Username  string    `json:"username"`
	Content   string    `json:"content"`
	CreatedAt time.Time `json:"createdAt"`
}

// danmakuResponse is the top-level envelope for GET /api/danmaku/:…
//
// Express shape: `{ data: [...], liveEndsAt: … }` — note that
// liveEndsAt is a SIBLING of data, not nested inside.  We can't use
// httpx.Data (which wraps in `{"data":…}` only) so this struct + the
// writeDanmakuJSON helper handle it inline.
//
// LiveEndsAt is *time.Time with no omitempty so absent windows emit
// JSON `null`, matching Express's `win?.liveEndsAt ?? null`.
type danmakuResponse struct {
	Data       []danmakuItem `json:"data"`
	LiveEndsAt *time.Time    `json:"liveEndsAt"`
}

// GetDanmaku implements GET /api/danmaku/:anilistId/:episode.
//
// Public endpoint — no auth required.  Mirrors Express's getDanmaku
// handler: returns the most recent 500 danmaku rows in chronological
// (oldest → newest) order, plus the live-window expiry timestamp.
//
// Flow:
//  1. Parse + validate :anilistId / :episode path params (400
//     BAD_REQUEST `Invalid params` on failure).
//  2. errgroup parallel:
//     - ListDanmakuRecent (DESC, reverse to ASC in handler)
//     - GetEpisodeWindow (pgx.ErrNoRows → nil pointer, NOT an error)
//  3. Return `{ data: [...], liveEndsAt: <ISO8601 | null> }`.
//
// The DB query returns DESC so the LIMIT 500 selects the *latest* 500;
// we reverse the slice in memory so the player sees chronological send
// order.  Reversing a 500-element slice is cheap (<10µs in benchmarks).
func (h *Handlers) GetDanmaku(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()

	anilistID, episode, ok := parseEpisodePath(w, r)
	if !ok {
		return
	}

	var (
		rows   []dbgen.ListDanmakuRecentRow
		window dbgen.EpisodeWindow
		hasWin bool
	)
	g, gctx := errgroup.WithContext(ctx)
	g.Go(func() error {
		got, err := h.Queries.ListDanmakuRecent(gctx, anilistID, episode)
		if err != nil {
			return err
		}
		rows = got
		return nil
	})
	g.Go(func() error {
		got, err := h.Queries.GetEpisodeWindow(gctx, anilistID, episode)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				// No window for this episode — liveEndsAt stays nil
				// (emits JSON null), which is the steady-state for
				// already-aired episodes.
				return nil
			}
			return err
		}
		window = got
		hasWin = true
		return nil
	})
	if err := g.Wait(); err != nil {
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "danmaku query failed"))
		return
	}

	body := danmakuResponse{
		Data:       mapDanmakuRows(rows),
		LiveEndsAt: liveEndsAtPtr(hasWin, window),
	}
	writeDanmakuJSON(w, http.StatusOK, body)
}

// mapDanmakuRows converts the sqlc rows into the API response shape
// and reverses the slice from DESC (DB ORDER BY) to ASC (chronological,
// what the player expects for bullet-screen replay).
//
// nil / empty rows in → empty slice out so the JSON envelope always
// contains `"data":[]` rather than `"data":null`.  Express returned
// `[]` for empty cases, so we match.
func mapDanmakuRows(rows []dbgen.ListDanmakuRecentRow) []danmakuItem {
	out := make([]danmakuItem, 0, len(rows))
	if len(rows) == 0 {
		return out
	}
	// Reverse iteration: rows[0] is newest (ORDER BY DESC), but the
	// player wants oldest → newest so the bullet overlay replays in
	// send order.  Append in reverse so the output slice is ASC.
	for i := len(rows) - 1; i >= 0; i-- {
		row := rows[i]
		out = append(out, danmakuItem{
			ID:        row.ID,
			Username:  row.Username,
			Content:   row.Content,
			CreatedAt: row.CreatedAt.Time,
		})
	}
	return out
}

// liveEndsAtPtr returns a *time.Time for the response envelope.
// hasWin=false (no window row in DB) → nil → JSON null.
// hasWin=true but pgtype invalid → nil (defensive — shouldn't happen
// because the column is NOT NULL).
func liveEndsAtPtr(hasWin bool, window dbgen.EpisodeWindow) *time.Time {
	if !hasWin || !window.LiveEndsAt.Valid {
		return nil
	}
	t := window.LiveEndsAt.Time
	return &t
}

// parseEpisodePath extracts :anilistId / :episode from the chi route
// and validates them as positive int32 values.  Writes a 400 envelope
// on parse failure and returns ok=false so the caller can early-return
// without writing additional output.
//
// Both fields must be >= 1.  Express only checked isNaN (so 0 and
// negatives would pass through and produce empty results); we tighten
// to >= 1 because the FK constraint on anilist_id → anime_cache(anilist_id)
// treats those values as non-existent rows and the friendly 400 is
// preferable to surfacing them as runtime DB errors.
func parseEpisodePath(w http.ResponseWriter, r *http.Request) (int32, int32, bool) {
	anilistRaw := chi.URLParam(r, "anilistId")
	episodeRaw := chi.URLParam(r, "episode")

	anilistID, err := strconv.ParseInt(anilistRaw, 10, 32)
	if err != nil || anilistID < 1 {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, msgInvalidParams))
		return 0, 0, false
	}
	episode, err := strconv.ParseInt(episodeRaw, 10, 32)
	if err != nil || episode < 1 {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, msgInvalidParams))
		return 0, 0, false
	}
	return int32(anilistID), int32(episode), true
}

// writeDanmakuJSON serialises the custom envelope directly — we can't
// reuse httpx.Data (which wraps in `{"data":…}` only) because Express
// emits liveEndsAt as a sibling of data at the top level.  Writing a
// custom marshaller here keeps the field ordering visible at the call
// site (data → liveEndsAt, matching Express byte-for-byte).
//
// Behaviour mirrors httpx.writeJSON (internal/httpx/envelope.go):
// HTML escaping off, trailing newline trimmed, Content-Type set.
func writeDanmakuJSON(w http.ResponseWriter, status int, body danmakuResponse) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(body); err != nil {
		slog.Warn("danmaku envelope marshal failed", "err", err)
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":{"code":"SERVER_ERROR","message":"internal error"}}`))
		return
	}
	out := bytes.TrimRight(buf.Bytes(), "\n")

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if _, err := w.Write(out); err != nil {
		slog.Warn("danmaku envelope write failed", "err", err)
	}
}
