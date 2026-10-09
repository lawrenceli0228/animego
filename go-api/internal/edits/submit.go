package edits

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"math"
	"net/http"
	"slices"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lawrenceli0228/animego/go-api/internal/avatars"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/httpx"
	"github.com/lawrenceli0228/animego/go-api/internal/jwtx"
	"github.com/lawrenceli0228/animego/go-api/internal/overlay"
	"github.com/lawrenceli0228/animego/go-api/internal/people"
)

// The answers' messages.  Stable English: the edit page translates each one
// (next-app lib/people/edit/errors.ts), so a change here is a change there.
const (
	msgBadBody         = "Invalid request body"
	msgBadKind         = "Unknown page kind"
	msgBadID           = "Invalid page id"
	msgNotFound        = "Page not found"
	msgSourceRequired  = "A source link is required"
	msgSourceInvalid   = "The source must be an http or https link"
	msgNoteInvalid     = "The note is too long"
	msgNothingChanged  = "Nothing changed"
	msgTooManyChanges  = "Too many changes in one submission"
	msgImageLink       = "The image link must be a public https link"
	msgImageFetch      = "The image could not be fetched"
	msgImageType       = "The image must be a JPEG or PNG"
	msgImageTooLarge   = "The image is too large"
	msgImageUnreadable = "The image could not be read"
	msgPendingExists   = "This page already has a submission of yours waiting for review"
	msgTooMany         = "Too many submissions, try again later"
)

var (
	errSourceRequired = errors.New(msgSourceRequired)
	errSourceInvalid  = errors.New(msgSourceInvalid)
	errPendingExists  = errors.New(msgPendingExists)
	errTooMany        = errors.New(msgTooMany)
)

// The per-person limits.  A submission is reviewed by hand, so the limits
// are about the queue as much as the server: a handful in a burst, a
// working day's worth a day, and only so many waiting at once -- one of
// them per page (the partial unique index enforces that one too).
const (
	burstWindow       = 10 * time.Minute
	burstMax          = 5
	dayWindow         = 24 * time.Hour
	dayMax            = 20
	maxPendingPerUser = 10
)

// submitTimeout covers the page reads, a fetched photo (fetchTimeout) and
// the insert.
const submitTimeout = 20 * time.Second

// ForgetFunc drops titles from the anime detail cache
// (anime.DetailService.Forget).
type ForgetFunc func(ids ...int32)

// Handlers serves the submission and review endpoints.
type Handlers struct {
	pool   *pgxpool.Pool
	q      *dbgen.Queries
	images *ImageStore
	forget ForgetFunc
	now    func() time.Time
}

// NewHandlers wires the handlers.  forget may be nil.
func NewHandlers(pool *pgxpool.Pool, images *ImageStore, forget ForgetFunc) *Handlers {
	if pool == nil || images == nil {
		panic("edits.NewHandlers: nil dependency")
	}
	return &Handlers{pool: pool, q: dbgen.New(pool), images: images, forget: forget, now: time.Now}
}

// submitRequest is the body of POST /api/edits.
type submitRequest struct {
	Kind      string    `json:"kind"`
	EntityID  int64     `json:"entityId"`
	SourceURL string    `json:"sourceUrl"`
	Note      *string   `json:"note"`
	Changes   changeSet `json:"changes"`
}

// snapshot is the page as its submitter saw it, kept with the submission
// for the queue and the notification.
type snapshot struct {
	Name  people.Name  `json:"name"`
	Image *string      `json:"image"`
	Work  *people.Work `json:"work"`
}

func fail(w http.ResponseWriter, status int, code, message string) {
	httpx.Fail(w, httpx.NewError(status, code, message))
}

// Submit implements POST /api/edits (RequireAuth).
//
//	{"kind":"character","entityId":184313,"sourceUrl":"https://…","note":"…",
//	 "changes":{"nameCn":"…","image":{"url":"https://…"},"roles":[{"animeId":154587,"role":"MAIN"}]}}
//
// 201 {"data":{"id","status":"pending","itemCount","createdAt"}}.  400 for a
// body, field, link or photo it refuses -- including a submission that
// changes nothing on the page as it is shown now; 404 for a page that does
// not exist; 409 when the submitter already has one waiting on this page;
// 429 past the limits above.
func (h *Handlers) Submit(w http.ResponseWriter, r *http.Request) {
	claims, ok := jwtx.ClaimsFrom(r.Context())
	if !ok || claims == nil {
		fail(w, http.StatusUnauthorized, httpx.CodeUnauthorized, "Authentication required")
		return
	}
	var req submitRequest
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		fail(w, http.StatusBadRequest, httpx.CodeBadRequest, msgBadBody)
		return
	}
	kind := overlay.Kind(req.Kind)
	if kind != overlay.Character && kind != overlay.Person {
		fail(w, http.StatusBadRequest, httpx.CodeValidationError, msgBadKind)
		return
	}
	if req.EntityID <= 0 || req.EntityID > math.MaxInt32 {
		fail(w, http.StatusBadRequest, httpx.CodeValidationError, msgBadID)
		return
	}
	entityID := int32(req.EntityID)
	source, err := cleanSource(req.SourceURL)
	if err != nil {
		msg := msgSourceInvalid
		if errors.Is(err, errSourceRequired) {
			msg = msgSourceRequired
		}
		fail(w, http.StatusBadRequest, httpx.CodeValidationError, msg)
		return
	}
	note, err := cleanNote(req.Note)
	if err != nil {
		fail(w, http.StatusBadRequest, httpx.CodeValidationError, msgNoteInvalid)
		return
	}
	if err := checkImage(req.Changes.Image); err != nil {
		fail(w, http.StatusBadRequest, httpx.CodeValidationError, err.Error())
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), submitTimeout)
	defer cancel()

	// The refusals that cost a query come before the ones that cost a
	// fetch: a submitter past the limits never makes the server reach out.
	if err := h.checkLimits(ctx, h.q, claims.UserID, kind, entityID); err != nil {
		h.failLimits(w, err)
		return
	}

	items, snap, currentImage, found, err := h.diff(ctx, kind, entityID, req.Changes)
	switch {
	case err != nil:
		var ce *changeError
		if errors.As(err, &ce) {
			fail(w, http.StatusBadRequest, httpx.CodeValidationError, ce.Error())
			return
		}
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "query failed"))
		return
	case !found:
		fail(w, http.StatusNotFound, httpx.CodeNotFound, msgNotFound)
		return
	}
	total := len(items)
	if req.Changes.Image != nil {
		total++
	}
	if total == 0 {
		fail(w, http.StatusBadRequest, httpx.CodeValidationError, msgNothingChanged)
		return
	}
	if total > maxItems {
		fail(w, http.StatusBadRequest, httpx.CodeValidationError, msgTooManyChanges)
		return
	}

	// The photo last: the only step that costs more than a query.
	var stored *StoredImage
	if img := req.Changes.Image; img != nil {
		var si StoredImage
		if img.URL != "" {
			si, err = h.images.SaveLink(ctx, img.URL)
		} else {
			si, err = h.images.SaveUpload(img.DataURL)
		}
		if err != nil {
			h.failImage(w, err)
			return
		}
		stored = &si
		items = append([]item{{Field: overlay.FieldImage, Old: mustJSON(currentImage), New: mustJSON(si)}}, items...)
	}
	committed := false
	defer func() {
		if !committed && stored != nil {
			h.images.Discard(stored.File)
		}
	}()

	row, err := h.insert(ctx, claims.UserID, kind, entityID, snap, source, note, items)
	if err != nil {
		if errors.Is(err, errPendingExists) || errors.Is(err, errTooMany) {
			h.failLimits(w, err)
			return
		}
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "submission failed"))
		return
	}
	committed = true
	httpx.Data(w, http.StatusCreated, struct {
		ID        uuid.UUID `json:"id"`
		Status    string    `json:"status"`
		ItemCount int       `json:"itemCount"`
		CreatedAt time.Time `json:"createdAt"`
	}{ID: row.ID, Status: "pending", ItemCount: len(items), CreatedAt: row.CreatedAt.Time})
}

func (h *Handlers) failLimits(w http.ResponseWriter, err error) {
	if errors.Is(err, errPendingExists) {
		fail(w, http.StatusConflict, httpx.CodeConflict, msgPendingExists)
		return
	}
	if errors.Is(err, errTooMany) {
		fail(w, http.StatusTooManyRequests, httpx.CodeTooManyRequests, msgTooMany)
		return
	}
	httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "query failed"))
}

func (h *Handlers) failImage(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errImageLink):
		fail(w, http.StatusBadRequest, httpx.CodeValidationError, msgImageLink)
	case errors.Is(err, errImageFetch):
		fail(w, http.StatusBadRequest, httpx.CodeValidationError, msgImageFetch)
	case errors.Is(err, errImageType), avatars.IsUnsupportedFormat(err), avatars.IsNotImage(err):
		fail(w, http.StatusBadRequest, httpx.CodeValidationError, msgImageType)
	case errors.Is(err, errImageTooLarge), avatars.IsTooLarge(err):
		fail(w, http.StatusBadRequest, httpx.CodeValidationError, msgImageTooLarge)
	case avatars.IsBadImage(err):
		fail(w, http.StatusBadRequest, httpx.CodeValidationError, msgImageUnreadable)
	default:
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "image store failed"))
	}
}

// limitQueries is what checkLimits reads, inside or outside a transaction.
type limitQueries interface {
	HasPendingEditSubmission(ctx context.Context, userID uuid.UUID, kind string, entityID int32) (bool, error)
	CountPendingEditSubmissionsByUser(ctx context.Context, userID uuid.UUID) (int32, error)
	CountEditSubmissionsSince(ctx context.Context, userID uuid.UUID, since pgtype.Timestamptz) (int32, error)
}

// checkLimits answers errPendingExists, errTooMany, a query error, or nil.
func (h *Handlers) checkLimits(ctx context.Context, q limitQueries, user uuid.UUID, kind overlay.Kind, entityID int32) error {
	pending, err := q.HasPendingEditSubmission(ctx, user, string(kind), entityID)
	if err != nil {
		return err
	}
	if pending {
		return errPendingExists
	}
	open, err := q.CountPendingEditSubmissionsByUser(ctx, user)
	if err != nil {
		return err
	}
	if open >= maxPendingPerUser {
		return errTooMany
	}
	now := h.now()
	for _, limit := range []struct {
		window time.Duration
		max    int32
	}{{burstWindow, burstMax}, {dayWindow, dayMax}} {
		n, err := q.CountEditSubmissionsSince(ctx, user, pgtype.Timestamptz{Time: now.Add(-limit.window), Valid: true})
		if err != nil {
			return err
		}
		if n >= limit.max {
			return errTooMany
		}
	}
	return nil
}

// diff reads the page as it is shown now and diffs the changes against it.
// found is false for a page that does not exist.
func (h *Handlers) diff(ctx context.Context, kind overlay.Kind, id int32, ch changeSet) (items []item, snap snapshot, image *string, found bool, err error) {
	if kind == overlay.Person {
		p, found, err := people.LoadPerson(ctx, h.q, id)
		if err != nil || !found {
			return nil, snapshot{}, nil, found, err
		}
		items, err := diffPerson(p, ch)
		return items, snapshot{Name: p.Name, Image: p.Image, Work: personWork(p)}, p.Image, true, err
	}
	c, found, err := people.LoadCharacter(ctx, h.q, id)
	if err != nil || !found {
		return nil, snapshot{}, nil, found, err
	}
	refs := map[int32]people.PersonRef{}
	if ids := voicePeopleIn(ch.Voices); len(ids) > 0 {
		rows, err := h.q.ListPersonRefs(ctx, ids)
		if err != nil {
			return nil, snapshot{}, nil, true, err
		}
		for _, r := range rows {
			refs[r.AnilistID] = people.PersonRefFromRow(r)
		}
	}
	items, err = diffCharacter(c, ch, refs)
	return items, snapshot{Name: c.Name, Image: c.Image, Work: characterWork(c)}, c.Image, true, err
}

// characterWork is the title a character's page hangs under: its most
// popular lead role, else its most popular title.
func characterWork(c *people.Character) *people.Work {
	var best *people.Appearance
	rank := func(a people.Appearance) int {
		if a.Role != nil && *a.Role == "MAIN" {
			return 0
		}
		return 1
	}
	for i := range c.Appearances {
		a := c.Appearances[i]
		if best == nil || rank(a) < rank(*best) ||
			(rank(a) == rank(*best) && popularity(a.Anime) > popularity(best.Anime)) {
			best = &c.Appearances[i]
		}
	}
	if best == nil {
		return nil
	}
	work := best.Anime
	return &work
}

// personWork is the title a person's page is best known by: their first
// representative role's, else their newest voice role's or staff credit's.
func personWork(p *people.Person) *people.Work {
	switch {
	case len(p.RepresentativeRoles) > 0:
		w := p.RepresentativeRoles[0].Anime
		return &w
	case len(p.VoiceRoles) > 0 && len(p.VoiceRoles[0].Roles) > 0:
		w := p.VoiceRoles[0].Roles[0].Anime
		return &w
	case len(p.StaffRoles) > 0 && len(p.StaffRoles[0].Works) > 0:
		w := p.StaffRoles[0].Works[0].Anime
		return &w
	}
	return nil
}

func popularity(w people.Work) int32 {
	if w.Popularity == nil {
		return -1
	}
	return *w.Popularity
}

// insert writes the submission and its items in one transaction, after the
// limits are checked again under the submitter's lock.
func (h *Handlers) insert(ctx context.Context, user uuid.UUID, kind overlay.Kind, entityID int32, snap snapshot, source string, note *string, items []item) (dbgen.InsertEditSubmissionRow, error) {
	tx, err := h.pool.Begin(ctx)
	if err != nil {
		return dbgen.InsertEditSubmissionRow{}, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	q := h.q.WithTx(tx)
	if err := q.LockEditSubmitter(ctx, user); err != nil {
		return dbgen.InsertEditSubmissionRow{}, err
	}
	if err := h.checkLimits(ctx, q, user, kind, entityID); err != nil {
		return dbgen.InsertEditSubmissionRow{}, err
	}
	row, err := q.InsertEditSubmission(ctx, dbgen.InsertEditSubmissionParams{
		UserID: user, Kind: string(kind), EntityID: entityID, Snapshot: mustJSON(snap),
		SourceUrl: source, Note: note, ItemCount: int16(len(items)),
	})
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return dbgen.InsertEditSubmissionRow{}, errPendingExists
		}
		return dbgen.InsertEditSubmissionRow{}, err
	}
	for i, it := range items {
		if err := q.InsertEditItem(ctx, dbgen.InsertEditItemParams{
			SubmissionID: row.ID, Position: int16(i), Field: it.Field, ItemKey: it.Key,
			OldValue: it.Old, NewValue: it.New, Meta: it.Meta,
		}); err != nil {
			return dbgen.InsertEditSubmissionRow{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return dbgen.InsertEditSubmissionRow{}, err
	}
	slog.InfoContext(ctx, "edits: submitted", "id", row.ID, "kind", kind, "entity", entityID,
		"items", len(items), "fields", slices.Compact(fieldsOf(items)))
	return row, nil
}

func fieldsOf(items []item) []string {
	out := make([]string, 0, len(items))
	for _, it := range items {
		out = append(out, it.Field)
	}
	return out
}
