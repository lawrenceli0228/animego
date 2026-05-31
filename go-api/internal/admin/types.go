// Package admin owns the /api/admin/* HTTP handlers.
//
// P2.3.2 implements the three read endpoints — stats, listEnrichment,
// listUsers — ported from server/controllers/admin.controller.js.  The
// write endpoints (reset / flag / patch / re-enrich / heal-cn /
// pauseHeal / resumeHeal / createUser / updateUser / deleteUser) land
// in later phases.
//
// The package follows the same "small handler + injected deps" shape
// as internal/auth and internal/anime: a Handlers struct carries
// pool / Querier / QueueStatus / validator, each method is a thin
// chi-compatible http.HandlerFunc, all DB round-trips are bounded by a
// 5s query timeout, and responses go through byte-exact envelopes
// matching the Express controller output.
//
// Two queries can't be expressed through sqlc because Express composes
// the WHERE / ORDER BY clauses dynamically (filter + q + sort + order
// + pagination):  listEnrichment + listUsers.  Those run as raw
// pgxpool queries with a column-name allow-list — see
// list_enrichment.go + list_users.go for the SQL builders.
package admin

import (
	"time"

	"github.com/google/uuid"
)

// statsEnrichment is the nested counts object inside StatsData.  Field
// order matches Express:  v0, v1, v2, v3, noCn.  The six additional
// fields (hasCn…srcFuzzyLow) surface the real enrichment-quality
// numbers that the DB now computes — they were absent in the Mongo port
// because Mongo's aggregation pipeline didn't track them.
type statsEnrichment struct {
	V0           int64 `json:"v0"`
	V1           int64 `json:"v1"`
	V2           int64 `json:"v2"`
	V3           int64 `json:"v3"`
	NoCn         int64 `json:"noCn"`
	HasCn        int64 `json:"hasCn"`
	HealCnReal   int64 `json:"healCnReal"`
	CnStuck      int64 `json:"cnStuck"`
	SrcIDMap     int64 `json:"srcIdMap"`
	SrcFuzzyHigh int64 `json:"srcFuzzyHigh"`
	SrcFuzzyLow  int64 `json:"srcFuzzyLow"`
}

// QueueSnapshot is the byte-exact queue object inside /api/admin/stats'
// response.  Mirrors server/services/bangumi.service.js
// getQueueStatus() (lines 408-421):  phase1, phase4, v3, v3Progress.
//
// The internal/queue package owns a different (smaller) Stats type
// that tracks only the V3 pause flag — we intentionally don't reuse
// it here because the admin payload needs depth counters that
// internal/queue.Status doesn't currently surface.  When the wiring
// phase teaches main.go how to compose phase1/phase4/v3 depths from
// river's JobList API, the injected QueueStatusFn will return this
// QueueSnapshot ready-shaped for the response.
type QueueSnapshot struct {
	Phase1     int64            `json:"phase1"`
	Phase4     int64            `json:"phase4"`
	V3         int64            `json:"v3"`
	V3Progress *V3BatchProgress `json:"v3Progress"`
}

// V3BatchProgress is the optional sub-object inside QueueSnapshot.
// Express returns null when no V3 batch is active; in Go that's a
// nil *V3BatchProgress pointer.  Field order matches Express:
// total, processed, healed, paused.
type V3BatchProgress struct {
	Total     int64 `json:"total"`
	Processed int64 `json:"processed"`
	Healed    int64 `json:"healed"`
	Paused    bool  `json:"paused"`
}

// statsData is the {data: {...}} payload of /api/admin/stats.  Field
// order matches Express controllers/admin.controller.js:35-46 exactly:
// users, anime, enrichment, queue, flagged, subscriptions, follows.
//
// The Queue field is a QueueSnapshot (value, not pointer) so it
// always marshals to a JSON object.  Express's getQueueStatus is
// in-memory and infallible, but the Go-side fn can fail (river DB
// hiccup).  When that happens the handler logs the error and emits
// a zero-value QueueSnapshot (which serialises to
// {"phase1":0,"phase4":0,"v3":0,"v3Progress":null}).
type statsData struct {
	Users         int64           `json:"users"`
	Anime         int64           `json:"anime"`
	Enrichment    statsEnrichment `json:"enrichment"`
	Queue         QueueSnapshot   `json:"queue"`
	Flagged       int64           `json:"flagged"`
	Subscriptions int64           `json:"subscriptions"`
	Follows       int64           `json:"follows"`
}

// enrichmentItem is one row in /api/admin/enrichment's data array.
// Field order matches Express's mongoose .select() projection:
// anilistId, titleRomaji, titleChinese, bgmId, bangumiVersion,
// bangumiScore, adminFlag.  Mongoose includes _id by default but the
// .select() above does not list it, so Mongo still emits it; we
// deliberately drop _id from the Go shape because the Postgres row
// has no equivalent primary-key surrogate (anilist_id IS the PK).
//
// All nullable columns map to pointer types so a missing value
// becomes JSON null (not zero) — matches Mongo's
// "absent field absent in JSON" semantics for this endpoint when the
// underlying document genuinely had a NULL.
type enrichmentItem struct {
	AnilistID      int32    `json:"anilistId"`
	TitleRomaji    *string  `json:"titleRomaji"`
	TitleChinese   *string  `json:"titleChinese"`
	BgmID          *int32   `json:"bgmId"`
	BangumiVersion int32    `json:"bangumiVersion"`
	BangumiScore   *float64 `json:"bangumiScore"`
	AdminFlag      *string  `json:"adminFlag"`
}

// enrichmentListResponse is the full /api/admin/enrichment envelope.
// Field order: data, hasMore, total, page — matches Express
// res.json({ data: items, hasMore, total, page }).  Crucially this
// is NOT the same field order as httpx.Page (data, total, page,
// hasMore, nextPage) — Express's listEnrichment uses a custom shape.
type enrichmentListResponse struct {
	Data    []enrichmentItem `json:"data"`
	HasMore bool             `json:"hasMore"`
	Total   int64            `json:"total"`
	Page    int              `json:"page"`
}

// userItem is one row in /api/admin/users' data array.
//
// Express uses Mongo's _id (the underscore-prefixed name is mongoose
// canon) and the response JSON serialises it as `_id`.  The Go port
// uses Postgres uuid for ID but the JSON tag is intentionally `_id`
// to match Express byte-for-byte during the shadow-traffic cutover.
// This is a deliberate divergence from internal/auth.SafeUser, which
// uses `id` because the /auth/me + /auth/register Express controllers
// already pass through a transformed user object (via toJSON()) that
// renames _id to id.  /api/admin/users does NOT run that transform —
// it lean()s the raw document, so _id leaks through unchanged.
//
// Field order matches the Mongoose .lean() default for the projection
// `username email role createdAt`:  _id, username, email, role,
// createdAt, then the two injected counts.
type userItem struct {
	ID            uuid.UUID `json:"_id"`
	Username      string    `json:"username"`
	Email         string    `json:"email"`
	Role          *string   `json:"role"`
	CreatedAt     time.Time `json:"createdAt"`
	Subscriptions int64     `json:"subscriptions"`
	Followers     int64     `json:"followers"`
}

// userListResponse is the full /api/admin/users envelope.  Same
// field order as enrichmentListResponse — Express keeps both list
// endpoints' top-level shape identical.
type userListResponse struct {
	Data    []userItem `json:"data"`
	HasMore bool       `json:"hasMore"`
	Total   int64      `json:"total"`
	Page    int        `json:"page"`
}
