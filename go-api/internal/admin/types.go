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

// DescriptionCnStats is the coverage side of the Chinese-description
// backfill — how much of the catalogue can have a Chinese synopsis, and
// how much of it does.  BackfillQueue is the other half (is the sweep
// running); this one is what it has achieved.
//
// Deliberately a coverage model, not processed/total:  the sweep never
// terminates, so a progress bar would either sit at a fake 100% or reset
// on every pass.  done/eligible is a number that stays true.
//
// Every field is counted off the description_cn_eligible view (migration
// 0016) — the same definition of "trusted binding" the sweep picks work
// with — so each one is reproducible by hand:
//
//	Eligible  count(*) — rows whose Bangumi binding an independent source
//	          confirms, i.e. rows a synopsis may legally be copied onto.
//	          NOT the size of anime_cache; the untrusted remainder can
//	          never be backfilled and counting it would understate us.
//	Done      of those, description_cn IS NOT NULL.
//	Rejected  no description_cn but description_cn_attempted_at is set —
//	          "we reached a decision about this row and got no text".
//	          Read the name narrowly:  the worker stamps that column on
//	          FOUR different decided outcomes, not just the language gate —
//	          Bangumi had no summary at all, the summary failed
//	          bangumi.CleanSummary's Chinese check, the subject 404'd
//	          (stale binding), or the UPDATE errored and was swallowed.
//	          Only transient fetch errors escape the stamp, because those
//	          return an error and go to river's retry path.
//	          A large steady Rejected is normal (Japanese-only summaries).
//	          A CLIMBING one is not automatically benign:  a mass 404 or a
//	          broken writer produces zero retryable jobs — the worker
//	          returns nil for both — so BackfillQueue stays green and this
//	          counter is the only place that breakage surfaces.
//	Pending   no description_cn and either never attempted or past the
//	          cooldown — the whole live backlog.  Not capped at the
//	          per-pass batch size, so this is "how far behind are we",
//	          not "what runs next hour".
//
// Rejected and Pending overlap by design (a row decided against longer ago
// than the cooldown is in both) and must never be summed:  they answer
// "how much has upstream already refused us" and "how much is still live",
// which are different questions about the same rows.
type DescriptionCnStats struct {
	Eligible int64 `json:"eligible"`
	Done     int64 `json:"done"`
	Rejected int64 `json:"rejected"`
	Pending  int64 `json:"pending"`
}

// DescriptionCnLlmStats is the coverage side of the LLM translation tier —
// the fallback that serves rows the Bangumi channel never can.
//
// Deliberately a SEPARATE object from DescriptionCnStats rather than four
// more fields on it, because the two tiers do not share a denominator and
// merging them would invite exactly the wrong arithmetic:
//
//	Remit     the rows this tier could ever write — an English source text
//	          exists, the row is empty or already machine-translated, and
//	          the Bangumi channel is done with it or can never reach it.
//	          NOT the catalogue, and NOT DescriptionCnStats.Eligible: the
//	          two sets are nearly disjoint by construction.
//	Done      description_cn_source = 'llm'.  Machine-translated rows still
//	          return to the Bangumi sweep's 30-day recheck, so this number
//	          can legitimately go DOWN when human prose replaces a
//	          translation — that is the covenant working, not data loss.
//	Rejected  in remit, still empty, LLM attempt stamped — the validation
//	          gate (Han density / length) refused the model's output, or
//	          the source stripped to nothing.
//	Pending   in remit, still empty, never attempted or past the 30-day
//	          cooldown.  This is the live backlog the sweep will pick up.
//
// Rejected and Pending overlap by design, same as the Bangumi tier's.
type DescriptionCnLlmStats struct {
	Remit    int64 `json:"remit"`
	Done     int64 `json:"done"`
	Rejected int64 `json:"rejected"`
	Pending  int64 `json:"pending"`
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

	// DescriptionBackfill is the Chinese-description sweep's queue
	// health.  Unlike phase1/phase4/v3 (one "outstanding work" number
	// per kind) this is split by river state — see BackfillQueue.
	DescriptionBackfill BackfillQueue `json:"descriptionBackfill"`

	// DescriptionLlm is the LLM translation tier's queue health, in the
	// same three-state shape and for the same reason.  Separate from
	// DescriptionBackfill because the two sweeps fail independently and
	// for unrelated causes — one is throttled by bgm.tv's token bucket,
	// the other by a paid API that can rate-limit, run out of credit, or
	// retire a model.  A single fused counter would make "DeepSeek is
	// out of credit" indistinguishable from "bgm.tv is slow".
	DescriptionLlm BackfillQueue `json:"descriptionLlm"`
}

// BackfillQueue is the queue health of the perpetual Chinese-description
// sweep (river kinds description_backfill + description_backfill_scan).
//
// Why three counters instead of one depth number:  the sweep never
// "finishes", so a single depth tells you nothing about whether it is
// healthy.  river's states mean genuinely different things here —
//
//	Queued    available+running+pending+scheduled — real backlog.
//	Retrying  retryable — jobs that FAILED and are waiting to retry.
//	          Folding this into Queued is exactly what makes a bgm.tv
//	          outage look perfectly healthy:  the depth stays non-zero
//	          and nobody can tell a backlog from a retry storm.
//	Discarded retries exhausted — work we have permanently given up on.
//
// Retrying climbing while Queued stalls = upstream breakage.
// Discarded climbing = data we will never backfill without a manual
// re-enqueue.  Both are invisible in a single-number gauge.
//
// The two timestamps are the two halves of "is it alive" — a single
// heartbeat cannot distinguish "idle because there is nothing to do"
// from "dead".  Both are nilable and nil is a state, not an error:
//
//	LastScanAt   max(finalized_at) of a COMPLETED description_backfill_scan.
//	             The real liveness signal — the periodic scan finalises
//	             every hour whether or not it found candidates.  river
//	             prunes completed jobs after a retention window
//	             (24h by default), so nil means "no successful scan for
//	             at least 24h", which is an alert, not a bug.
//	LastWriteAt  max(anime_cache.description_cn_attempted_at) — when the
//	             sweep last actually touched a row.  This one legitimately
//	             freezes once the backlog is drained, so it must never be
//	             read as liveness on its own.
type BackfillQueue struct {
	Queued      int64      `json:"queued"`
	Retrying    int64      `json:"retrying"`
	Discarded   int64      `json:"discarded"`
	LastScanAt  *time.Time `json:"lastScanAt"`
	LastWriteAt *time.Time `json:"lastWriteAt"`
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
// descriptionCn is appended after the Express-era fields rather than
// slotted next to enrichment so the historical prefix keeps its exact
// order — the field-order assertions in handlers_test.go check the
// original seven against each other, and a new tail field cannot
// disturb them.
type statsData struct {
	Users         int64           `json:"users"`
	Anime         int64           `json:"anime"`
	Enrichment    statsEnrichment `json:"enrichment"`
	Queue         QueueSnapshot   `json:"queue"`
	Flagged       int64           `json:"flagged"`
	Subscriptions int64           `json:"subscriptions"`
	Follows       int64           `json:"follows"`

	DescriptionCn DescriptionCnStats `json:"descriptionCn"`

	// DescriptionCnLlm is the machine-translation fallback's coverage.
	// Its own object because the two tiers have different denominators —
	// see DescriptionCnLlmStats.
	DescriptionCnLlm DescriptionCnLlmStats `json:"descriptionCnLlm"`
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
	BgmMatchSource *string  `json:"bgmMatchSource"`
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
