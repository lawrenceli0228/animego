package edits

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/httpx"
	"github.com/lawrenceli0228/animego/go-api/internal/jwtx"
	"github.com/lawrenceli0228/animego/go-api/internal/overlay"
	"github.com/lawrenceli0228/animego/go-api/internal/pii"
)

const (
	msgReviewBody       = "Each item needs a decision"
	msgRejectNote       = "A rejected item needs a note"
	msgAlreadyReviewed  = "This submission has already been reviewed"
	msgSubmissionAbsent = "Submission not found"
	maxRejectNoteLen    = 500
	defaultPageSize     = 30
	maxPageSize         = 50
	reviewTimeout       = 10 * time.Second
)

// submitterResponse is who submitted, and what their history says: the
// how-many-th submission this is, and how many of theirs had something
// accepted.
type submitterResponse struct {
	Username string `json:"username"`
	Nth      int32  `json:"nth"`
	Accepted int32  `json:"accepted"`
}

// listItemResponse is one row of the queue.
type listItemResponse struct {
	ID            uuid.UUID         `json:"id"`
	Kind          string            `json:"kind"`
	EntityID      int32             `json:"entityId"`
	Snapshot      json.RawMessage   `json:"snapshot"`
	Status        string            `json:"status"`
	ItemCount     int16             `json:"itemCount"`
	AcceptedCount int16             `json:"acceptedCount"`
	RejectedCount int16             `json:"rejectedCount"`
	HasImage      bool              `json:"hasImage"`
	Submitter     submitterResponse `json:"submitter"`
	CreatedAt     time.Time         `json:"createdAt"`
	ReviewedAt    *time.Time        `json:"reviewedAt"`
}

// itemResponse is one item of a submission, as the review shows it.
type itemResponse struct {
	ID         uuid.UUID       `json:"id"`
	Field      string          `json:"field"`
	Key        string          `json:"key"`
	Old        json.RawMessage `json:"old"`
	New        json.RawMessage `json:"new"`
	Meta       json.RawMessage `json:"meta"`
	Status     string          `json:"status"`
	RejectNote *string         `json:"rejectNote"`
	// PreviewURL is where the proposed photo can be seen: the admin-only
	// route while it waits, its public address once accepted, null once
	// rejected (the file is gone).
	PreviewURL *string `json:"previewUrl"`
}

// submissionResponse is GET /api/admin/edits/{id}.
type submissionResponse struct {
	ID            uuid.UUID         `json:"id"`
	Kind          string            `json:"kind"`
	EntityID      int32             `json:"entityId"`
	Snapshot      json.RawMessage   `json:"snapshot"`
	SourceURL     string            `json:"sourceUrl"`
	Note          *string           `json:"note"`
	Status        string            `json:"status"`
	ItemCount     int16             `json:"itemCount"`
	AcceptedCount int16             `json:"acceptedCount"`
	RejectedCount int16             `json:"rejectedCount"`
	Submitter     submitterResponse `json:"submitter"`
	Reviewer      *string           `json:"reviewer"`
	CreatedAt     time.Time         `json:"createdAt"`
	ReviewedAt    *time.Time        `json:"reviewedAt"`
	Items         []itemResponse    `json:"items"`
}

func optionalTime(t pgtype.Timestamptz) *time.Time {
	if !t.Valid {
		return nil
	}
	v := t.Time.UTC()
	return &v
}

func positiveInt(raw string, fallback int) int {
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 {
		return fallback
	}
	return n
}

// List implements GET /api/admin/edits?status=pending|reviewed&kind=&page=&limit=
// (admin): the queue oldest first, or the reviewed list newest first.
//
//	{"data":{"items":[…],"hasMore":false,"nextPage":null,"pendingCount":3}}
func (h *Handlers) List(w http.ResponseWriter, r *http.Request) {
	qs := r.URL.Query()
	status := qs.Get("status")
	if status == "" {
		status = "pending"
	}
	if status != "pending" && status != "reviewed" {
		fail(w, http.StatusBadRequest, httpx.CodeValidationError, "Invalid status")
		return
	}
	var kind *string
	if k := qs.Get("kind"); k != "" {
		if k != string(overlay.Character) && k != string(overlay.Person) {
			fail(w, http.StatusBadRequest, httpx.CodeValidationError, msgBadKind)
			return
		}
		kind = &k
	}
	page := positiveInt(qs.Get("page"), 1)
	limit := min(positiveInt(qs.Get("limit"), defaultPageSize), maxPageSize)
	offset := int32((page - 1) * limit)

	ctx, cancel := context.WithTimeout(r.Context(), reviewTimeout)
	defer cancel()
	var items []listItemResponse
	var err error
	if status == "pending" {
		var rows []dbgen.ListPendingEditSubmissionsRow
		rows, err = h.q.ListPendingEditSubmissions(ctx, kind, offset, int32(limit+1))
		for _, row := range rows {
			items = append(items, listItemResponse{
				ID: row.ID, Kind: row.Kind, EntityID: row.EntityID, Snapshot: row.Snapshot, Status: row.Status,
				ItemCount: row.ItemCount, AcceptedCount: row.AcceptedCount, RejectedCount: row.RejectedCount,
				HasImage: row.HasImage, CreatedAt: row.CreatedAt.Time.UTC(), ReviewedAt: optionalTime(row.ReviewedAt),
				Submitter: submitterResponse{Username: pii.PublicUsername(row.SubmitterUsername), Nth: row.SubmitterNth, Accepted: row.SubmitterAccepted},
			})
		}
	} else {
		var rows []dbgen.ListReviewedEditSubmissionsRow
		rows, err = h.q.ListReviewedEditSubmissions(ctx, kind, offset, int32(limit+1))
		for _, row := range rows {
			items = append(items, listItemResponse{
				ID: row.ID, Kind: row.Kind, EntityID: row.EntityID, Snapshot: row.Snapshot, Status: row.Status,
				ItemCount: row.ItemCount, AcceptedCount: row.AcceptedCount, RejectedCount: row.RejectedCount,
				HasImage: row.HasImage, CreatedAt: row.CreatedAt.Time.UTC(), ReviewedAt: optionalTime(row.ReviewedAt),
				Submitter: submitterResponse{Username: pii.PublicUsername(row.SubmitterUsername), Nth: row.SubmitterNth, Accepted: row.SubmitterAccepted},
			})
		}
	}
	if err != nil {
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "list failed"))
		return
	}
	pendingCount, err := h.q.CountPendingEditSubmissions(ctx)
	if err != nil {
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "count failed"))
		return
	}
	hasMore := len(items) > limit
	if hasMore {
		items = items[:limit]
	}
	if items == nil {
		items = []listItemResponse{}
	}
	var nextPage *int
	if hasMore {
		next := page + 1
		nextPage = &next
	}
	httpx.Data(w, http.StatusOK, struct {
		Items        []listItemResponse `json:"items"`
		HasMore      bool               `json:"hasMore"`
		NextPage     *int               `json:"nextPage"`
		PendingCount int32              `json:"pendingCount"`
	}{Items: items, HasMore: hasMore, NextPage: nextPage, PendingCount: pendingCount})
}

// Get implements GET /api/admin/edits/{id} (admin).
func (h *Handlers) Get(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		fail(w, http.StatusBadRequest, httpx.CodeBadRequest, "Invalid submission id")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), reviewTimeout)
	defer cancel()
	sub, found, err := h.load(ctx, id)
	if err != nil {
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "query failed"))
		return
	}
	if !found {
		fail(w, http.StatusNotFound, httpx.CodeNotFound, msgSubmissionAbsent)
		return
	}
	httpx.Data(w, http.StatusOK, sub)
}

func (h *Handlers) load(ctx context.Context, id uuid.UUID) (submissionResponse, bool, error) {
	row, err := h.q.GetEditSubmission(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return submissionResponse{}, false, nil
	}
	if err != nil {
		return submissionResponse{}, false, err
	}
	rows, err := h.q.ListEditItems(ctx, id)
	if err != nil {
		return submissionResponse{}, false, err
	}
	items := make([]itemResponse, 0, len(rows))
	for _, it := range rows {
		items = append(items, itemResponse{
			ID: it.ID, Field: it.Field, Key: it.ItemKey, Old: it.OldValue, New: it.NewValue, Meta: it.Meta,
			Status: it.Status, RejectNote: it.RejectNote, PreviewURL: h.previewURL(it),
		})
	}
	var reviewer *string
	if row.ReviewerUsername != nil {
		name := pii.PublicUsername(*row.ReviewerUsername)
		reviewer = &name
	}
	return submissionResponse{
		ID: row.ID, Kind: row.Kind, EntityID: row.EntityID, Snapshot: row.Snapshot, SourceURL: row.SourceUrl,
		Note: row.Note, Status: row.Status, ItemCount: row.ItemCount, AcceptedCount: row.AcceptedCount,
		RejectedCount: row.RejectedCount, Reviewer: reviewer,
		Submitter:  submitterResponse{Username: pii.PublicUsername(row.SubmitterUsername), Nth: row.SubmitterNth, Accepted: row.SubmitterAccepted},
		CreatedAt:  row.CreatedAt.Time.UTC(),
		ReviewedAt: optionalTime(row.ReviewedAt),
		Items:      items,
	}, true, nil
}

func (h *Handlers) previewURL(it dbgen.ListEditItemsRow) *string {
	if it.Field != overlay.FieldImage {
		return nil
	}
	var img StoredImage
	if err := json.Unmarshal(it.NewValue, &img); err != nil || !imageNameRe.MatchString(img.File) {
		return nil
	}
	var url string
	switch it.Status {
	case "pending":
		url = "/api/admin/edits/images/" + img.File
	case "accepted":
		url = h.images.PublicURL(img.File)
	default:
		return nil
	}
	return &url
}

// reviewRequest is the body of POST /api/admin/edits/{id}/review: one
// decision per item of the submission, every item decided at once.
type reviewRequest struct {
	Decisions []struct {
		ItemID uuid.UUID `json:"itemId"`
		Accept bool      `json:"accept"`
		Note   *string   `json:"note"`
	} `json:"decisions"`
}

// Review implements POST /api/admin/edits/{id}/review (admin).
//
// Every item gets a decision; a rejected one needs a note (it is what the
// submitter reads).  In one transaction: the accepted items are merged
// into the page's overlay, their photos moved to public, each item and the
// submission marked, and the submitter notified (not when they reviewed
// it themselves).  After it, rejected photos are deleted and every title
// crediting the page is dropped from the detail cache.  Answers the
// submission as Get does.  409 when someone reviewed it first.
func (h *Handlers) Review(w http.ResponseWriter, r *http.Request) {
	claims, ok := jwtx.ClaimsFrom(r.Context())
	if !ok || claims == nil {
		fail(w, http.StatusUnauthorized, httpx.CodeUnauthorized, "Authentication required")
		return
	}
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		fail(w, http.StatusBadRequest, httpx.CodeBadRequest, "Invalid submission id")
		return
	}
	var req reviewRequest
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil || len(req.Decisions) == 0 {
		fail(w, http.StatusBadRequest, httpx.CodeBadRequest, msgReviewBody)
		return
	}
	decisions := map[uuid.UUID]*string{}
	accepted := map[uuid.UUID]bool{}
	for _, d := range req.Decisions {
		if _, dup := decisions[d.ItemID]; dup {
			fail(w, http.StatusBadRequest, httpx.CodeValidationError, msgReviewBody)
			return
		}
		var note *string
		if !d.Accept {
			if d.Note == nil {
				fail(w, http.StatusBadRequest, httpx.CodeValidationError, msgRejectNote)
				return
			}
			s, err := cleanText("note", *d.Note, maxRejectNoteLen)
			if err != nil || s == "" {
				fail(w, http.StatusBadRequest, httpx.CodeValidationError, msgRejectNote)
				return
			}
			note = &s
		}
		decisions[d.ItemID] = note
		accepted[d.ItemID] = d.Accept
	}

	ctx, cancel := context.WithTimeout(r.Context(), reviewTimeout)
	defer cancel()
	outcome, err := h.review(ctx, id, claims.UserID, decisions, accepted)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		fail(w, http.StatusNotFound, httpx.CodeNotFound, msgSubmissionAbsent)
		return
	case errors.Is(err, errAlreadyReviewed):
		fail(w, http.StatusConflict, httpx.CodeConflict, msgAlreadyReviewed)
		return
	case errors.Is(err, errDecisionsIncomplete):
		fail(w, http.StatusBadRequest, httpx.CodeValidationError, msgReviewBody)
		return
	case err != nil:
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "review failed"))
		return
	}

	// After the commit: what can no longer be rolled back.
	for _, file := range outcome.rejectedImages {
		h.images.Discard(file)
	}
	if outcome.anyAccepted && h.forget != nil {
		if ids, err := h.q.ListAnimeIDsCrediting(ctx, outcome.kind, outcome.entityID); err != nil {
			slog.WarnContext(ctx, "edits: titles to forget", "err", err)
		} else {
			h.forget(ids...)
		}
	}

	sub, _, err := h.load(ctx, id)
	if err != nil {
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "query failed"))
		return
	}
	httpx.Data(w, http.StatusOK, sub)
}

var (
	errAlreadyReviewed     = errors.New(msgAlreadyReviewed)
	errDecisionsIncomplete = errors.New(msgReviewBody)
)

type reviewOutcome struct {
	kind           string
	entityID       int32
	anyAccepted    bool
	rejectedImages []string
}

func (h *Handlers) review(ctx context.Context, id, reviewer uuid.UUID, notes map[uuid.UUID]*string, accepted map[uuid.UUID]bool) (reviewOutcome, error) {
	tx, err := h.pool.Begin(ctx)
	if err != nil {
		return reviewOutcome{}, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	q := h.q.WithTx(tx)

	sub, err := q.LockEditSubmission(ctx, id)
	if err != nil {
		return reviewOutcome{}, err
	}
	if sub.Status != "pending" {
		return reviewOutcome{}, errAlreadyReviewed
	}
	items, err := q.ListEditItems(ctx, id)
	if err != nil {
		return reviewOutcome{}, err
	}
	if len(items) != len(notes) {
		return reviewOutcome{}, errDecisionsIncomplete
	}
	for _, it := range items {
		if _, ok := notes[it.ID]; !ok {
			return reviewOutcome{}, errDecisionsIncomplete
		}
	}

	out := reviewOutcome{kind: sub.Kind, entityID: sub.EntityID}
	var published []string
	committed := false
	defer func() {
		if committed {
			return
		}
		for _, file := range published {
			if err := h.images.Unpublish(file); err != nil {
				slog.WarnContext(ctx, "edits: unpublish after a failed review", "file", file, "err", err)
			}
		}
	}()

	var acceptedItems []dbgen.ListEditItemsRow
	var nAccepted, nRejected int16
	for _, it := range items {
		if accepted[it.ID] {
			acceptedItems = append(acceptedItems, it)
			nAccepted++
			continue
		}
		nRejected++
		if it.Field == overlay.FieldImage {
			var img StoredImage
			if json.Unmarshal(it.NewValue, &img) == nil {
				out.rejectedImages = append(out.rejectedImages, img.File)
			}
		}
	}

	if len(acceptedItems) > 0 {
		out.anyAccepted = true
		if err := q.EnsureEntityOverlay(ctx, sub.Kind, sub.EntityID); err != nil {
			return reviewOutcome{}, err
		}
		raw, err := q.LockEntityOverlay(ctx, sub.Kind, sub.EntityID)
		if err != nil {
			return reviewOutcome{}, err
		}
		doc, err := overlay.Decode(raw)
		if err != nil {
			return reviewOutcome{}, err
		}
		for _, it := range acceptedItems {
			value := json.RawMessage(it.NewValue)
			if it.Field == overlay.FieldImage {
				var img StoredImage
				if err := json.Unmarshal(it.NewValue, &img); err != nil {
					return reviewOutcome{}, err
				}
				url, err := h.images.Publish(img.File)
				if err != nil {
					return reviewOutcome{}, err
				}
				published = append(published, img.File)
				value = mustJSON(url)
			}
			if doc, err = doc.With(it.Field, it.ItemKey, value); err != nil {
				return reviewOutcome{}, err
			}
		}
		if err := q.SaveEntityOverlay(ctx, mustJSON(doc), &reviewer, sub.Kind, sub.EntityID); err != nil {
			return reviewOutcome{}, err
		}
	}

	for _, it := range items {
		status := "rejected"
		if accepted[it.ID] {
			status = "accepted"
		}
		n, err := q.DecideEditItem(ctx, status, notes[it.ID], it.ID, id)
		if err != nil {
			return reviewOutcome{}, err
		}
		if n != 1 {
			return reviewOutcome{}, errAlreadyReviewed
		}
	}
	if err := q.MarkEditSubmissionReviewed(ctx, nAccepted, nRejected, reviewer, id); err != nil {
		return reviewOutcome{}, err
	}
	if sub.UserID != reviewer {
		if err := q.InsertEditReviewNotification(ctx, sub.UserID, reviewer, id); err != nil {
			return reviewOutcome{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return reviewOutcome{}, err
	}
	committed = true
	slog.InfoContext(ctx, "edits: reviewed", "id", id, "kind", sub.Kind, "entity", sub.EntityID,
		"accepted", nAccepted, "rejected", nRejected)
	return out, nil
}
