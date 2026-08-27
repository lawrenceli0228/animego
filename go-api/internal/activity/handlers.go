package activity

// handlers.go -- POST /api/activity/beacon.
//
// WHAT THIS ENDPOINT IS FOR, AND WHAT IT IS NOT.
//
// Two facts about a visit cannot be inferred from server logs.  A soft
// navigation between two already-cached routes issues no API call at all, so
// the request-derived record simply does not contain it; and arriving at a
// player is not the same event as pressing play, though both live at the same
// URL.  This endpoint reports those two, and nothing else.
//
// It is reachable without a session, because the majority of this site's
// readers do not have one -- it is an SEO-led catalogue, and a "page visits"
// figure assembled from logged-in traffic alone would understate reality by an
// order of magnitude while looking precise.
//
// IT DOES NO DATABASE WORK.  Both counters it moves are in-memory increments
// under a mutex; Postgres is written once a minute from the recorder's flush
// goroutine.  That is not an optimisation, it is the only way this endpoint
// can be safe to expose to the whole of the site's logged-out traffic:
// activity_surface_daily holds twenty rows, so writing through would make
// every anonymous page view in the catalogue contend for the same row lock,
// and the endpoint measuring the site would be slowing it.  See recorder.go.
//
// THE TRUST BOUNDARY, STATED SO NOBODY HAS TO INFER IT.
//
// Anything a stranger can POST to is a counter a stranger can move.  Rate
// limiting (the global per-IP limiter fronts all of /api/*) raises the cost;
// it does not make the number auditable.  So the containment is structural
// rather than defensive:
//
//   - the increment is fixed at +1 in SQL.  The caller reports that something
//     happened, never how much.  A client-supplied magnitude on a public
//     endpoint is a counter anyone can set to any value in one request.
//   - the only caller-controlled value that reaches the database is the
//     surface, and NormalizeSurface maps it onto a ten-value allow-list before
//     it gets there.  A CHECK constraint on the table is the durable copy.
//   - nothing identifying is stored.  No IP, no user agent, no path, no user
//     id -- authentication collapses to a single boolean column, exactly the
//     line migration 0020 drew for community telemetry.
//   - and the metrics that matter DO NOT READ THIS TABLE.  DAU, WAU, MAU,
//     visit days and retention all come from the middleware's
//     server-side, token-derived record.  An outsider inflating the beacon can
//     make the surface breakdown wrong; they cannot touch a number anyone
//     would make a decision on.
//
// The per-user page-view and playback counters ARE attributed, but only for a
// caller that already holds a valid session -- i.e. only to themselves.

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/lawrenceli0228/animego/go-api/internal/httpx"
	"github.com/lawrenceli0228/animego/go-api/internal/jwtx"
)

// Handlers carries the beacon endpoint's dependencies -- which is just the
// recorder, because the endpoint has no database of its own to reach.
type Handlers struct {
	Recorder *Recorder
}

// NewHandlers builds the beacon handler bundle.  rec may be nil (see
// Recorder's doc comment on nil receivers), in which case the endpoint still
// answers 202 and records nothing.
func NewHandlers(rec *Recorder) *Handlers {
	return &Handlers{Recorder: rec}
}

type beaconRequest struct {
	// Kind is required and validated strictly: it decides which counter column
	// moves, so an unrecognised value has no honest home.  Quietly bucketing
	// an unknown kind into page views would corrupt a number rather than
	// coarsen one.
	Kind string `json:"kind"`
	// Surface is required to be present but not to be recognised --
	// NormalizeSurface collapses anything unfamiliar to "other".  A page that
	// ships before somebody adds its name to the allow-list should lose its
	// label, not its count.
	Surface string `json:"surface"`
}

// Track implements POST /api/activity/beacon.
//
// Mount behind OptionalAuth so an authenticated caller's own counters can be
// attributed while anonymous callers still land in the aggregate.
//
// Answers 202 on success: the write is a counter increment nobody is waiting
// on, and 202 is the honest code for "recorded, nothing to fetch".  Mirrors
// POST /api/community/engagement.
func (h *Handlers) Track(w http.ResponseWriter, r *http.Request) {
	var req beaconRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || !ValidKind(req.Kind) {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeValidationError, "Invalid activity beacon"))
		return
	}
	surface := NormalizeSurface(req.Surface)

	claims, authenticated := jwtx.ClaimsFrom(r.Context())
	now := time.Now()

	// The aggregate bucket: every caller, session or not.
	h.Recorder.Surface(surface, authenticated, now)

	// The attributed counters: only for a caller who already holds a valid
	// session, and only ever to themselves.  There is no path here by which
	// one visitor's beacon can move another visitor's row.
	if authenticated && claims != nil {
		switch req.Kind {
		case KindPageView:
			h.Recorder.PageView(claims.UserID, now)
		case KindPlayback:
			h.Recorder.Playback(claims.UserID, now)
		}
	}

	// 202 unconditionally past validation.  Both writes above are memory
	// increments that cannot fail, so there is no failure left to report --
	// and reporting one to a fire-and-forget beacon would be useless anyway:
	// the caller is a page the reader is already looking at, with nothing to
	// do with an error except retry and amplify whatever caused it.
	httpx.Data(w, http.StatusAccepted, map[string]bool{"recorded": true})
}
