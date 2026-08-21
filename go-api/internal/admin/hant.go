package admin

// hant.go — the zh-Hant drift monitor:
//
//	GET  /api/admin/hant/stats     coverage + how far behind the columns are
//	POST /api/admin/hant/backfill  enqueue one sweep
//
// The two exist together on purpose.  title_hant's bottom tier is a
// machine conversion of title_chinese, and description_hant is entirely a
// conversion of description_cn; both source columns keep growing as the
// enrichment workers fill them, and nothing converts the new arrivals
// until the sweep runs.  titleBehind / descBehind are what a human reads
// to decide whether pressing the button is worth it — a monitor without
// the button would be a number nobody can act on, and the button without
// the numbers would be a coin flip.

import (
	"context"
	"net/http"
	"time"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/httpx"
	"github.com/lawrenceli0228/animego/go-api/internal/queue"
)

// hantQuerier is the sqlc subset this surface reads.  Declared here per
// "accept interfaces, return structs" so a test can stub two methods
// rather than the full dbgen.Querier; dbgen.Queries satisfies it.
type hantQuerier interface {
	GetHantStats(ctx context.Context) (dbgen.GetHantStatsRow, error)
	GetHantBackfillJobStatus(ctx context.Context) (dbgen.GetHantBackfillJobStatusRow, error)
}

// hantEnqueuer is the one dispatch method the button needs.  Narrow on
// purpose — this surface has no business reaching the V1/V2/V3 chain — so
// any Enqueuer carrying the method satisfies it.
type hantEnqueuer interface {
	EnqueueHantBackfillNow(ctx context.Context) (bool, error)
}

// HantHandlers carries the deps for both endpoints.
//
// Its own bundle rather than more fields on Handlers or UserHandlers,
// because this is the first surface that needs a querier AND an enqueuer:
// splitting the read onto Handlers and the write onto UserHandlers would
// put one feature's two halves in two structs wired at two call sites.
type HantHandlers struct {
	Queries hantQuerier
	Enq     hantEnqueuer
}

// NewHantHandlers constructs the bundle.  Both dependencies are required;
// a nil one panics at boot rather than at request time, matching
// NewUserHandlers.  A nil enqueuer in particular has to fail loudly: the
// endpoint would otherwise answer 200 to every press while scheduling
// nothing, which is indistinguishable from a healthy button.
func NewHantHandlers(queries hantQuerier, enq hantEnqueuer) *HantHandlers {
	if queries == nil {
		panic("admin.NewHantHandlers: nil querier")
	}
	if enq == nil {
		panic("admin.NewHantHandlers: nil Enqueuer")
	}
	return &HantHandlers{Queries: queries, Enq: enq}
}

// HantStatsResp is the GET /api/admin/hant/stats body.
//
// LastRunAt is a *time.Time without omitempty: never-run has to serialise
// as an explicit null.  Dropping the key would make "no sweep has ever
// run" and "this build predates the field" look identical to the caller.
type HantStatsResp struct {
	Total        int64 `json:"total"`
	TitleHant    int64 `json:"titleHant"`
	DescHant     int64 `json:"descHant"`
	SerpEligible int64 `json:"serpEligible"`

	// TitleBehind counts rows that have a Chinese title and no Traditional
	// one.  NOT the complement of TitleHant: a row with no title_chinese
	// at all is out of reach rather than behind, and counting it would
	// leave this number permanently non-zero and therefore ignorable.
	TitleBehind int64 `json:"titleBehind"`
	// DescBehind is the same measure for the synopsis columns.
	DescBehind int64 `json:"descBehind"`

	LastRunAt *time.Time `json:"lastRunAt"`
	Running   bool       `json:"running"`
}

// GetHantStats implements GET /api/admin/hant/stats.
//
// Two queries rather than one: the coverage counters scan anime_cache and
// the run state reads river_job, and they fail for unrelated reasons.
// Neither is soft-failed, though — unlike the description-coverage block
// on /api/admin/stats, this endpoint IS the panel.  Emitting zeros here
// would say "nothing is behind, nothing is running", which is the exact
// reading that makes an operator do nothing.  A 500 says "ask again".
func (h *HantHandlers) GetHantStats(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()

	row, err := h.Queries.GetHantStats(ctx)
	if err != nil {
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "hant stats query failed"))
		return
	}

	job, err := h.Queries.GetHantBackfillJobStatus(ctx)
	if err != nil {
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "hant job status query failed"))
		return
	}

	resp := HantStatsResp{
		Total:        row.Total,
		TitleHant:    row.TitleHant,
		DescHant:     row.DescHant,
		SerpEligible: row.SerpEligible,
		TitleBehind:  row.TitleBehind,
		DescBehind:   row.DescBehind,
		Running:      job.Running,
	}
	// pgtype.Timestamptz over *time.Time because max() of an empty set is
	// NULL and that is the normal state before the first sweep.  Valid is
	// the only thing that distinguishes it from the zero time, which would
	// serialise as year 1 and read as a run that happened.
	if job.LastRunAt.Valid {
		t := job.LastRunAt.Time.UTC()
		resp.LastRunAt = &t
	}

	httpx.Data(w, http.StatusOK, resp)
}

// HantBackfillResp is the POST /api/admin/hant/backfill body.
type HantBackfillResp struct {
	// Enqueued is false when a sweep was already queued or running and
	// river collapsed this insert into it.  Reporting true either way
	// would let an operator believe a second pass had been scheduled.
	Enqueued bool   `json:"enqueued"`
	Message  string `json:"message"`
}

// hantAlreadyRunningMsg and hantEnqueuedMsg are the two outcomes, spelled
// out rather than assembled, so the message and the boolean beside it
// cannot drift apart.
const (
	hantEnqueuedMsg       = "zh-Hant backfill enqueued. It rewrites title_hant / description_hant for every row the ladder disagrees with; check server logs for the pass summary."
	hantAlreadyRunningMsg = "A zh-Hant backfill is already queued or running; this request was folded into it."
)

// BackfillHant implements POST /api/admin/hant/backfill.
//
// Unlike WarmAll this does NOT respond before doing the work and then
// enqueue in a goroutine.  There is one insert here, not fifty, so it
// costs a single round-trip — and doing it inline is what lets the
// response say whether river actually took the job.  A fire-and-forget
// goroutine would have to answer before it knew, i.e. would have to
// answer "enqueued: true" unconditionally, which is the one thing this
// endpoint must not do.
func (h *HantHandlers) BackfillHant(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()

	inserted, err := h.Enq.EnqueueHantBackfillNow(ctx)
	if err != nil {
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "hant backfill enqueue failed"))
		return
	}

	msg := hantAlreadyRunningMsg
	if inserted {
		msg = hantEnqueuedMsg
	}
	httpx.Data(w, http.StatusOK, HantBackfillResp{Enqueued: inserted, Message: msg})
}

// Compile-time guard: the application Enqueuer must keep satisfying the
// narrow surface this handler holds.  Catches a rename on the queue side
// that would otherwise only surface as a wiring failure in main.go.
var _ hantEnqueuer = (queue.Enqueuer)(nil)
