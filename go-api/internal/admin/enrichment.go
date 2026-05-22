// Package admin — enrichment.go implements the seven /api/admin/enrichment*
// write endpoints. Mirrors server/controllers/admin.controller.js:
//
//	PATCH /api/admin/enrichment/:anilistId          updateEnrichment
//	POST  /api/admin/enrichment/re-enrich            reEnrich (?version=0|1|2)
//	POST  /api/admin/enrichment/heal-cn              healCnTitles
//	POST  /api/admin/enrichment/heal-cn/pause        pauseHeal
//	POST  /api/admin/enrichment/heal-cn/resume       resumeHeal
//	POST  /api/admin/enrichment/:anilistId/reset     resetEnrichment
//	POST  /api/admin/enrichment/:anilistId/flag      flagEnrichment
//
// Three resource shapes drive the type design:
//
//  1. Single-row mutators (updateEnrichment, flag, reset) take an
//     anilist_id path param + a small JSON body and return the projection
//     fields Express ships back.
//  2. Batch enqueue endpoints (re-enrich, heal-cn) read a filtered slice
//     from anime_cache, dispatch to the river queue, and return
//     `{ enqueued: N, version?: N }`.
//  3. Queue control (pause, resume) is a thin wrapper around the
//     queue.PauseV3 / queue.ResumeV3 surface introduced in P2.3.1.
//
// The reset path runs INSIDE a pgx transaction so the column blank-out +
// child-table DELETE never leave the row half-cleared on failure.
//
// Chinese error messages are byte-exact with Express; constants below
// guard against silent translation drift.

package admin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/httpx"
	"github.com/lawrenceli0228/animego/go-api/internal/queue"
)

// enrichmentQueryTimeout bounds every enrichment-write DB round-trip.
// Five seconds matches the user-CRUD and read budgets so stalls in any
// admin surface share the same observable failure mode.
const enrichmentQueryTimeout = 5 * time.Second

// Chinese user-facing messages — copied verbatim from
// server/controllers/admin.controller.js so the shadow-traffic diff
// at cutover sees identical bytes.
const (
	msgInvalidAnilistID   = "无效的 anilistId"
	msgAnimeNotFound      = "番剧不存在"
	msgNoFieldsToUpdate   = "没有可更新的字段"
	msgInvalidFlagValue   = "无效的 flag 值"
	msgInvalidVersion     = "版本必须为 0、1 或 2"
	msgInvalidRequestJSON = "请求体格式错误"
)

// allowedFlagValues mirrors the Express allow-list:
//
//	const allowed = ['needs-review', 'manually-corrected', null];
//
// Stored as a set keyed on the string form (treating "" as the null
// case the JSON request body uses).
var allowedFlagValues = map[string]struct{}{
	"needs-review":        {},
	"manually-corrected":  {},
}

// EnrichmentDB is the sqlc subset the enrichment handlers consume.
// Declared at use-site per "accept interfaces, return structs" so tests
// can stub the entire surface without dragging the full Querier in.
type EnrichmentDB interface {
	UpdateAnimeEnrichmentSelective(
		ctx context.Context,
		titleChinese *string,
		bgmID *int32,
		bangumiScore *float64,
		anilistID int32,
	) (dbgen.UpdateAnimeEnrichmentSelectiveRow, error)
	FlagAnimeEnrichment(ctx context.Context, anilistID int32, adminFlag *string) (dbgen.FlagAnimeEnrichmentRow, error)
	GetAnimeCacheRowForReset(ctx context.Context, anilistID int32) (dbgen.GetAnimeCacheRowForResetRow, error)
	ListAnimeForReEnrichByVersion(ctx context.Context, bangumiVersion int32) ([]dbgen.ListAnimeForReEnrichByVersionRow, error)
	ListEnrichedV2WithBgm(ctx context.Context) ([]dbgen.ListEnrichedV2WithBgmRow, error)
	ListEnrichedV2WithoutBgm(ctx context.Context) ([]int32, error)
	PromoteAnimeToV3(ctx context.Context, dollar_1 []int32) error
	ListHealCnCandidates(ctx context.Context) ([]dbgen.ListHealCnCandidatesRow, error)
}

// txQuerier is the subset of the sqlc-generated Querier that supports
// being bound to a transaction via dbgen.New(tx).  The reset handler
// needs ResetAnimeEnrichment + DeleteAnimeCharactersForReset +
// DeleteAnimeEpisodeTitlesForReset to all run on the same transaction
// — the implementation type returned by dbgen.New(tx) is *dbgen.Queries.
type txQuerier interface {
	ResetAnimeEnrichment(ctx context.Context, anilistID int32) error
	DeleteAnimeCharactersForReset(ctx context.Context, animeID int32) error
	DeleteAnimeEpisodeTitlesForReset(ctx context.Context, animeID int32) error
}

// EnrichmentHandlers carries the deps for every /api/admin/enrichment*
// handler.  Construct once at startup and mount each method on the chi
// router behind the RequireAuth + RequireAdmin chain.
//
// Pool — required by Reset (transaction over the three reset queries)
//        and by transactional re-enrich (v=2 promote-to-v3 + enqueue
//        atomicity is desirable but Express did not have it; we match
//        Express here).
// DB — the sqlc surface for the non-transactional reads + writes.
// NewTxQuerier — pluggable factory that lets tests substitute a fake
//        transactional querier without standing up Postgres.  Production
//        wires this as `func(tx pgx.Tx) txQuerier { return dbgen.New(tx) }`.
// Enq — queue dispatcher for V1 / V2 / V3 batches.
// QueueCtrl — admin pause/resume surface from internal/queue.
type EnrichmentHandlers struct {
	Pool         *pgxpool.Pool
	DB           EnrichmentDB
	NewTxQuerier func(tx pgx.Tx) txQuerier
	Enq          queue.Enqueuer
	QueueCtrl    queue.QueueController
}

// NewEnrichmentHandlers wires the deps with sensible defaults.  When
// NewTxQuerier is nil it defaults to dbgen.New(tx) — production callers
// almost always pass nil here and let the default win.
func NewEnrichmentHandlers(
	pool *pgxpool.Pool,
	db EnrichmentDB,
	enq queue.Enqueuer,
	queueCtrl queue.QueueController,
) *EnrichmentHandlers {
	return &EnrichmentHandlers{
		Pool: pool,
		DB:   db,
		Enq:  enq,
		// Allow tests to override; nil means "use sqlc default".
		NewTxQuerier: defaultNewTxQuerier,
		QueueCtrl:    queueCtrl,
	}
}

// defaultNewTxQuerier binds the sqlc Queries struct to a transaction.
// Extracted as a package-level var so tests can swap it without going
// through the public constructor.
func defaultNewTxQuerier(tx pgx.Tx) txQuerier {
	return dbgen.New(tx)
}

// ============================================================================
// PATCH /api/admin/enrichment/:anilistId — updateEnrichment
// ============================================================================

// updateEnrichmentBody mirrors the Express allow-list of editable fields:
//
//	const allowed = ['titleChinese', 'bgmId', 'bangumiScore'];
//	for (const key of allowed) if (req.body[key] !== undefined) updates[key] = req.body[key]
//
// Using *T means we can distinguish "absent" (no change) from
// "present with null" (explicit null set).  Express's `!== undefined`
// check accepts explicit null; the partial-update SQL handles nil
// pointers via COALESCE.
type updateEnrichmentBody struct {
	TitleChinese *string  `json:"titleChinese"`
	BgmID        *int32   `json:"bgmId"`
	BangumiScore *float64 `json:"bangumiScore"`
}

// UpdateEnrichment handles PATCH /api/admin/enrichment/:anilistId.
//
// Express behaviour preserved:
//   - invalid anilistId path param → 400 BAD_REQUEST `无效的 anilistId`
//   - empty body (no recognised fields) → 400 BAD_REQUEST `没有可更新的字段`
//   - missing row → 404 NOT_FOUND `番剧不存在`
//   - successful update → 200 with the projection row (anilistId,
//     titleRomaji, titleChinese, bgmId, bangumiScore, adminFlag).
//   - admin_flag is unconditionally set to 'manually-corrected' as a
//     side effect.
func (h *EnrichmentHandlers) UpdateEnrichment(w http.ResponseWriter, r *http.Request) {
	anilistID, ok := parseAnilistID(chi.URLParam(r, "anilistId"))
	if !ok {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, msgInvalidAnilistID))
		return
	}

	var body updateEnrichmentBody
	if err := decodeJSONBody(r, &body); err != nil {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, msgInvalidRequestJSON))
		return
	}

	if body.TitleChinese == nil && body.BgmID == nil && body.BangumiScore == nil {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, msgNoFieldsToUpdate))
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), enrichmentQueryTimeout)
	defer cancel()

	row, err := h.DB.UpdateAnimeEnrichmentSelective(ctx, body.TitleChinese, body.BgmID, body.BangumiScore, anilistID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Fail(w, httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, msgAnimeNotFound))
			return
		}
		slog.WarnContext(ctx, "admin: UpdateAnimeEnrichmentSelective failed",
			"anilist_id", anilistID, "err", err)
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "internal error"))
		return
	}

	httpx.Data(w, http.StatusOK, toEnrichmentDTO(row.AnilistID, row.TitleRomaji, row.TitleChinese, row.BgmID, row.BangumiScore, row.AdminFlag))
}

// ============================================================================
// POST /api/admin/enrichment/:anilistId/flag — flagEnrichment
// ============================================================================

// flagBody mirrors Express:  body.flag may be 'needs-review',
// 'manually-corrected', or null.  Using *string lets us distinguish
// "field absent" (decoded as nil) from "explicit null".  Both map to
// "clear the flag".
type flagBody struct {
	Flag *string `json:"flag"`
}

// FlagEnrichment handles POST /api/admin/enrichment/:anilistId/flag.
// Express behaviour preserved verbatim — see admin.controller.js:147.
func (h *EnrichmentHandlers) FlagEnrichment(w http.ResponseWriter, r *http.Request) {
	anilistID, ok := parseAnilistID(chi.URLParam(r, "anilistId"))
	if !ok {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, msgInvalidAnilistID))
		return
	}

	var body flagBody
	if err := decodeJSONBody(r, &body); err != nil {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, msgInvalidRequestJSON))
		return
	}

	// Validate the flag value before touching DB.
	if body.Flag != nil {
		if _, ok := allowedFlagValues[*body.Flag]; !ok {
			httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, msgInvalidFlagValue))
			return
		}
	}

	ctx, cancel := context.WithTimeout(r.Context(), enrichmentQueryTimeout)
	defer cancel()

	row, err := h.DB.FlagAnimeEnrichment(ctx, anilistID, body.Flag)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Fail(w, httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, msgAnimeNotFound))
			return
		}
		slog.WarnContext(ctx, "admin: FlagAnimeEnrichment failed",
			"anilist_id", anilistID, "err", err)
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "internal error"))
		return
	}

	httpx.Data(w, http.StatusOK, map[string]any{
		"anilistId": row.AnilistID,
		"adminFlag": row.AdminFlag,
	})
}

// ============================================================================
// POST /api/admin/enrichment/:anilistId/reset — resetEnrichment
// ============================================================================

// resetResponse mirrors Express:  res.json({ data: { anilistId, reset: true } }).
type resetResponse struct {
	AnilistID int32 `json:"anilistId"`
	Reset     bool  `json:"reset"`
}

// ResetEnrichment handles POST /api/admin/enrichment/:anilistId/reset.
//
// Two-step flow:
//  1. Pre-read the row (need title_native / title_romaji for the re-enqueue).
//  2. Inside a transaction: blank the enrichment columns + DELETE child
//     character / episode title rows.
//  3. After commit: dispatch a V1 job with `priority` semantics (in
//     Express, priority was just an in-memory flag — Go's queue uses
//     EnqueueV1Many which has no priority surface, so the priority is
//     observed only via the order-of-arrival in the queue table).
func (h *EnrichmentHandlers) ResetEnrichment(w http.ResponseWriter, r *http.Request) {
	anilistID, ok := parseAnilistID(chi.URLParam(r, "anilistId"))
	if !ok {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, msgInvalidAnilistID))
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), enrichmentQueryTimeout)
	defer cancel()

	// Step 1: confirm the row exists and grab the re-enqueue payload.
	row, err := h.DB.GetAnimeCacheRowForReset(ctx, anilistID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Fail(w, httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, msgAnimeNotFound))
			return
		}
		slog.WarnContext(ctx, "admin: GetAnimeCacheRowForReset failed",
			"anilist_id", anilistID, "err", err)
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "internal error"))
		return
	}

	// Step 2: blank enrichment + child rows in a transaction.
	if err := h.runResetTransaction(ctx, anilistID); err != nil {
		slog.WarnContext(ctx, "admin: reset transaction failed",
			"anilist_id", anilistID, "err", err)
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "internal error"))
		return
	}

	// Step 3: dispatch a V1 re-enqueue.  Failure to enqueue is logged
	// but does not fail the response — the row is already reset and the
	// next periodic orphan-scan will pick it up.
	if err := h.Enq.EnqueueV1Many(ctx, []int32{row.AnilistID}); err != nil {
		slog.WarnContext(ctx, "admin: reset enqueue V1 failed",
			"anilist_id", row.AnilistID, "err", err)
	}

	httpx.Data(w, http.StatusOK, resetResponse{AnilistID: row.AnilistID, Reset: true})
}

// runResetTransaction wraps the three reset operations in a pgx
// transaction.  Rolls back on first failure so the row never sits with
// the parent columns blanked but the child characters table still
// populated (or vice versa).
func (h *EnrichmentHandlers) runResetTransaction(ctx context.Context, anilistID int32) error {
	tx, err := h.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("admin reset: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	factory := h.NewTxQuerier
	if factory == nil {
		factory = defaultNewTxQuerier
	}
	q := factory(tx)

	if err := q.ResetAnimeEnrichment(ctx, anilistID); err != nil {
		return fmt.Errorf("admin reset: ResetAnimeEnrichment: %w", err)
	}
	if err := q.DeleteAnimeCharactersForReset(ctx, anilistID); err != nil {
		return fmt.Errorf("admin reset: DeleteAnimeCharactersForReset: %w", err)
	}
	if err := q.DeleteAnimeEpisodeTitlesForReset(ctx, anilistID); err != nil {
		return fmt.Errorf("admin reset: DeleteAnimeEpisodeTitlesForReset: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("admin reset: commit: %w", err)
	}
	return nil
}

// ============================================================================
// POST /api/admin/enrichment/re-enrich?version=N — reEnrich
// ============================================================================

// reEnrichResponse mirrors Express: { data: { enqueued: N, version: N } }.
type reEnrichResponse struct {
	Enqueued int   `json:"enqueued"`
	Version  int32 `json:"version"`
}

// ReEnrich handles POST /api/admin/enrichment/re-enrich.
//
// Three branches by query param version=0|1|2:
//
//	0  → ListAnimeForReEnrichByVersion(0)  + EnqueueV1Many
//	1  → ListAnimeForReEnrichByVersion(1)  + EnqueueV2Many (BangumiV2Args)
//	2  → ListEnrichedV2WithBgm  + EnqueueV3Many (BangumiV3Args)
//	     ListEnrichedV2WithoutBgm + PromoteAnimeToV3   (can't V3 without bgmId)
//
// Other versions → 400 `版本必须为 0、1 或 2`.
func (h *EnrichmentHandlers) ReEnrich(w http.ResponseWriter, r *http.Request) {
	versionStr := r.URL.Query().Get("version")
	v, err := strconv.Atoi(versionStr)
	if err != nil || (v != 0 && v != 1 && v != 2) {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeBadRequest, msgInvalidVersion))
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), enrichmentQueryTimeout)
	defer cancel()

	switch v {
	case 0:
		rows, err := h.DB.ListAnimeForReEnrichByVersion(ctx, 0)
		if err != nil {
			slog.WarnContext(ctx, "admin: ListAnimeForReEnrichByVersion(0)", "err", err)
			httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "internal error"))
			return
		}
		ids := make([]int32, 0, len(rows))
		for _, row := range rows {
			ids = append(ids, row.AnilistID)
		}
		if len(ids) > 0 {
			if err := h.Enq.EnqueueV1Many(ctx, ids); err != nil {
				slog.WarnContext(ctx, "admin: reEnrich V1 enqueue", "n", len(ids), "err", err)
				httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "internal error"))
				return
			}
		}
		httpx.Data(w, http.StatusOK, reEnrichResponse{Enqueued: len(ids), Version: 0})

	case 1:
		rows, err := h.DB.ListAnimeForReEnrichByVersion(ctx, 1)
		if err != nil {
			slog.WarnContext(ctx, "admin: ListAnimeForReEnrichByVersion(1)", "err", err)
			httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "internal error"))
			return
		}
		jobs := make([]queue.BangumiV2Args, 0, len(rows))
		for _, row := range rows {
			if row.BgmID == nil {
				// v=1 rows without bgmId can't be V2-enriched; skip.
				// Express filtered identically — `enqueuePhase4Enrichment`
				// only operates on rows with bgmId set.
				continue
			}
			jobs = append(jobs, queue.BangumiV2Args{
				AnilistID: int(row.AnilistID),
				BgmID:     int(*row.BgmID),
			})
		}
		if len(jobs) > 0 {
			if err := h.Enq.EnqueueV2Many(ctx, jobs); err != nil {
				slog.WarnContext(ctx, "admin: reEnrich V2 enqueue", "n", len(jobs), "err", err)
				httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "internal error"))
				return
			}
		}
		// Express returns docs.length (rows queried, includes the
		// skipped no-bgmId rows).  Match that — `enqueued` here means
		// "rows considered" for v=1 to stay byte-exact.
		httpx.Data(w, http.StatusOK, reEnrichResponse{Enqueued: len(rows), Version: 1})

	case 2:
		// v=2 splits: rows with bgmId → V3 heal; rows without → direct
		// promote to v3 (can't be healed without a Bangumi subject id).
		withBgm, err := h.DB.ListEnrichedV2WithBgm(ctx)
		if err != nil {
			slog.WarnContext(ctx, "admin: ListEnrichedV2WithBgm", "err", err)
			httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "internal error"))
			return
		}
		noBgm, err := h.DB.ListEnrichedV2WithoutBgm(ctx)
		if err != nil {
			slog.WarnContext(ctx, "admin: ListEnrichedV2WithoutBgm", "err", err)
			httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "internal error"))
			return
		}

		if len(noBgm) > 0 {
			if err := h.DB.PromoteAnimeToV3(ctx, noBgm); err != nil {
				slog.WarnContext(ctx, "admin: PromoteAnimeToV3", "n", len(noBgm), "err", err)
				httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "internal error"))
				return
			}
		}

		if len(withBgm) > 0 {
			jobs := make([]queue.BangumiV3Args, 0, len(withBgm))
			for _, row := range withBgm {
				if row.BgmID == nil {
					// Defensive — SQL filter pinned bgm_id IS NOT NULL,
					// but in case the column constraint relaxes we
					// still skip safely.
					continue
				}
				jobs = append(jobs, queue.BangumiV3Args{
					AnilistID: int(row.AnilistID),
					BgmID:     int(*row.BgmID),
				})
			}
			if len(jobs) > 0 {
				if err := h.Enq.EnqueueV3Many(ctx, jobs); err != nil {
					slog.WarnContext(ctx, "admin: reEnrich V3 enqueue", "n", len(jobs), "err", err)
					httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "internal error"))
					return
				}
			}
		}

		// Total considered = withBgm + noBgm (Express returns docs.length).
		httpx.Data(w, http.StatusOK, reEnrichResponse{
			Enqueued: len(withBgm) + len(noBgm),
			Version:  2,
		})
	}
}

// ============================================================================
// POST /api/admin/enrichment/heal-cn — healCnTitles
// ============================================================================

// healCnResponse mirrors Express: { data: { enqueued: N } }.
type healCnResponse struct {
	Enqueued int `json:"enqueued"`
}

// HealCn handles POST /api/admin/enrichment/heal-cn.  Pulls every
// candidate (bgm_id set, version=2, title_chinese null) and dispatches
// V3 heal jobs.  Empty result returns { enqueued: 0 } without touching
// the queue.
func (h *EnrichmentHandlers) HealCn(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), enrichmentQueryTimeout)
	defer cancel()

	rows, err := h.DB.ListHealCnCandidates(ctx)
	if err != nil {
		slog.WarnContext(ctx, "admin: ListHealCnCandidates", "err", err)
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "internal error"))
		return
	}

	if len(rows) == 0 {
		httpx.Data(w, http.StatusOK, healCnResponse{Enqueued: 0})
		return
	}

	jobs := make([]queue.BangumiV3Args, 0, len(rows))
	for _, row := range rows {
		if row.BgmID == nil {
			continue
		}
		jobs = append(jobs, queue.BangumiV3Args{
			AnilistID: int(row.AnilistID),
			BgmID:     int(*row.BgmID),
		})
	}

	if len(jobs) > 0 {
		if err := h.Enq.EnqueueV3Many(ctx, jobs); err != nil {
			slog.WarnContext(ctx, "admin: HealCn V3 enqueue", "n", len(jobs), "err", err)
			httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "internal error"))
			return
		}
	}

	// Express returns docs.length (matches len(rows)).
	httpx.Data(w, http.StatusOK, healCnResponse{Enqueued: len(rows)})
}

// ============================================================================
// POST /api/admin/enrichment/heal-cn/pause — pauseHeal
// ============================================================================

// pauseResponse / resumeResponse mirror Express:
//
//	{ data: { paused: true } }
//	{ data: { paused: false } }
type pauseResponse struct {
	Paused bool `json:"paused"`
}

// PauseHeal handles POST /api/admin/enrichment/heal-cn/pause.  Thin
// wrapper around queue.PauseV3.  If QueueCtrl is nil (test/boot before
// river is ready) the call still returns 200 paused:true — matches
// Express's in-memory bool flip semantics.
func (h *EnrichmentHandlers) PauseHeal(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), enrichmentQueryTimeout)
	defer cancel()

	if h.QueueCtrl != nil {
		if err := queue.PauseV3(ctx, h.QueueCtrl); err != nil {
			slog.WarnContext(ctx, "admin: PauseV3", "err", err)
			httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "internal error"))
			return
		}
	}

	httpx.Data(w, http.StatusOK, pauseResponse{Paused: true})
}

// ResumeHeal handles POST /api/admin/enrichment/heal-cn/resume.
func (h *EnrichmentHandlers) ResumeHeal(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), enrichmentQueryTimeout)
	defer cancel()

	if h.QueueCtrl != nil {
		if err := queue.ResumeV3(ctx, h.QueueCtrl); err != nil {
			slog.WarnContext(ctx, "admin: ResumeV3", "err", err)
			httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "internal error"))
			return
		}
	}

	httpx.Data(w, http.StatusOK, pauseResponse{Paused: false})
}

// ============================================================================
// helpers
// ============================================================================

// parseAnilistID parses the chi URL parameter and validates it's a
// positive integer.  Express's `parseInt(req.params.anilistId, 10) &&
// anilistId !== 0` filter — both empty string and "0" are rejected.
func parseAnilistID(raw string) (int32, bool) {
	n, err := strconv.ParseInt(raw, 10, 32)
	if err != nil {
		return 0, false
	}
	if n <= 0 {
		return 0, false
	}
	return int32(n), true
}

// decodeJSONBody reads the request body as JSON into dst.  Empty body
// is treated as an empty object — matches Express's permissive JSON
// parser behaviour when Content-Length is 0.  DisallowUnknownFields()
// is on because Express rejected unknown keys at the controller layer
// even though body-parser did not.
func decodeJSONBody(r *http.Request, dst any) error {
	if r.Body == nil {
		return nil
	}
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		// Empty body → dst stays at zero value (allowed for endpoints
		// where every field is optional, e.g. ResetEnrichment).
		if errors.Is(err, io.EOF) {
			return nil
		}
		return err
	}
	return nil
}

// enrichmentDTO is the response shape for UpdateEnrichment.  Field
// order mirrors Express's
//
//	.select('anilistId titleRomaji titleChinese bgmId bangumiScore adminFlag')
type enrichmentDTO struct {
	AnilistID    int32    `json:"anilistId"`
	TitleRomaji  *string  `json:"titleRomaji"`
	TitleChinese *string  `json:"titleChinese"`
	BgmID        *int32   `json:"bgmId"`
	BangumiScore *float64 `json:"bangumiScore"`
	AdminFlag    *string  `json:"adminFlag"`
}

// toEnrichmentDTO is a small helper so the handler body reads at a
// glance.  Centralising the shape conversion keeps the JSON contract in
// one place.
func toEnrichmentDTO(
	anilistID int32,
	titleRomaji, titleChinese *string,
	bgmID *int32,
	bangumiScore *float64,
	adminFlag *string,
) enrichmentDTO {
	return enrichmentDTO{
		AnilistID:    anilistID,
		TitleRomaji:  titleRomaji,
		TitleChinese: titleChinese,
		BgmID:        bgmID,
		BangumiScore: bangumiScore,
		AdminFlag:    adminFlag,
	}
}
