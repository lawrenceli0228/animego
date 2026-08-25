// episode_offset.go — GET /api/anime/{anilistId}/episode-offset
//
// How many episodes precede a season in its franchise's continuous
// numbering. Release groups routinely number across seasons: a file holding
// the finale of a 10-episode second season is called 38 when the first
// season ran 28. Nothing in the library knew that, and two things broke on
// it:
//
//   - the grid inferred the shift as "the lowest file I hold is episode 1",
//     which is only true for a user who has the season's opener. A user
//     holding just the finale saw it rendered in slot 1.
//   - the watch push sent the stored 38, which subscriptions/validate.go
//     range-checks against anime_cache.episodes and rejects with 400. That
//     season's progress had therefore never synced, silently.
//
// Both wanted one number, and the database already had everything needed to
// derive it — `anime_relations` has carried PREQUEL edges since 0001, filled
// from the `relations` block the AniList detail query already asks for. See
// GetAbsoluteEpisodeOffset in queries/anime_cache.sql for the walk.
//
// Its own endpoint rather than a field on /search or /{anilistId}: the
// library reads this once per bound series and stores it, so it does not
// belong on either of the two hot paths that would then compute it for every
// row of every result.

package anime

import (
	"context"
	"errors"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/httpx"
)

// episodeOffsetResponse is deliberately two fields rather than a nullable
// number.
//
// "nothing precedes this season" and "we could not work out what precedes
// this season" are different answers, and a single `offset: number | null`
// invites the one line of client code — `offset ?? 0` — that turns the
// second into the first. Renumbering a user's files against an origin
// nobody established is exactly the failure this endpoint exists to stop, so
// the caller has to read `known` before it can reach a number at all.
type episodeOffsetResponse struct {
	Known  bool  `json:"known"`
	Offset int32 `json:"offset"`
}

// EpisodeOffset serves the absolute episode offset for one anime.
//
// Unknown is a 200 with `known:false`, never a 404 or a 500. It is the
// ordinary answer for roughly a quarter of the catalogue — relation rows are
// only written for anime whose detail has been fetched — and a client that
// had to distinguish "unknown" from "request failed" by status code would
// end up retrying a stable answer forever.
func EpisodeOffset(q dbgen.Querier) http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		ctx, cancel := context.WithTimeout(req.Context(), queryTimeout)
		defer cancel()

		raw := chi.URLParam(req, "anilistId")
		id, err := strconv.Atoi(raw)
		if err != nil || id <= 0 {
			httpx.Fail(w, httpx.NewError(
				http.StatusBadRequest,
				httpx.CodeValidationError,
				"无效的番剧 ID",
			))
			return
		}

		row, err := q.GetAbsoluteEpisodeOffset(ctx, int32(id))
		if err != nil {
			// No row means the anchor itself is not cached, so there is no
			// chain to walk. That is an unknown offset, not a failure: the
			// id is perfectly valid and the client's answer is the same one
			// it gets for a chain that runs off the end of the cache.
			if errors.Is(err, pgx.ErrNoRows) {
				httpx.Data(w, http.StatusOK, episodeOffsetResponse{Known: false})
				return
			}
			httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "query failed"))
			return
		}

		// `known` is a *bool because the SQL expression is nullable in
		// principle. A nil here is not "unknown-ish" — it would mean the
		// walk produced a row whose completeness could not be evaluated, so
		// it collapses to the same refusal rather than to a default.
		known := row.Known != nil && *row.Known
		out := episodeOffsetResponse{Known: known}
		if known {
			out.Offset = row.AbsoluteOffset
		}
		httpx.Data(w, http.StatusOK, out)
	}
}

// episodeOffsetItem is one row of the batch answer. `known` carries the same
// meaning it does on the single-id endpoint, and for the same reason.
type episodeOffsetItem struct {
	AnilistID int32 `json:"anilistId"`
	Known     bool  `json:"known"`
	Offset    int32 `json:"offset"`
}

// EpisodeOffsets serves offsets for many anime at once.
//
// It exists because the library's one-shot backfill cannot use the per-id
// endpoint: a 200-series library would make 200 requests against a 1 req/s
// per-IP bucket. `/api/anime/episodes` already solved that for episode
// counts, so this mirrors it — same id parsing, same cap, same cache policy,
// same `{data: [...]}` envelope — rather than inventing a second shape for
// the same problem.
//
// An id that is not in the cache produces NO ITEM rather than an item saying
// unknown. Absent and known:false mean the same thing to the caller, and the
// episode-count sweep already treats a missing row that way.
func EpisodeOffsets(q dbgen.Querier) http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		ctx, cancel := context.WithTimeout(req.Context(), queryTimeout)
		defer cancel()

		ids, err := parseAnilistIDList(req.URL.Query().Get("ids"), maxEpisodeIDs)
		if err != nil {
			httpx.Fail(w, httpx.NewError(
				http.StatusBadRequest,
				httpx.CodeValidationError,
				err.Error(),
			))
			return
		}

		rows, queryErr := q.GetAbsoluteEpisodeOffsets(ctx, ids)
		if queryErr != nil {
			httpx.Fail(w, httpx.WrapError(queryErr, http.StatusInternalServerError, httpx.CodeServerError, "query failed"))
			return
		}

		items := make([]episodeOffsetItem, 0, len(rows))
		for _, r := range rows {
			known := r.Known != nil && *r.Known
			item := episodeOffsetItem{AnilistID: r.AnilistID, Known: known}
			if known {
				item.Offset = r.AbsoluteOffset
			}
			items = append(items, item)
		}

		// The same policy the episode counts use. An offset is a fact about a
		// franchise's shape, which changes even less often than an episode
		// count does.
		w.Header().Set("Cache-Control", episodeCountsCacheControl)
		httpx.Data(w, http.StatusOK, items)
	}
}
