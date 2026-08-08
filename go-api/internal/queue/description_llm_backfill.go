// description_llm_backfill.go — the LLM translation fallback tier for
// description_cn.
//
// The Bangumi sweep (description_backfill.go) is the primary channel, but it
// has a hard ceiling: it can only serve rows whose binding passes the
// description_cn_eligible trust gate AND whose bgm.tv subject actually
// carries usable Chinese prose.  After its first full walk that left the
// catalogue at ~29% coverage — ~4,100 rows tried with nothing usable
// upstream, ~7,500 more that can never enter the channel at all (untrusted
// binding or no bgm_id).  Every one of those rows has an English synopsis
// sitting in `description`.  This sweep translates it.
//
// # Ordering covenant: manual > bangumi > llm
//
// The LLM tier is strictly the primary channel's leftovers, enforced in SQL
// on both sides:
//
//   - ListDescriptionCnLlmCandidates only selects rows the Bangumi channel
//     is done with (attempt-stamped) or can never touch (fails the trust
//     gate / no binding).  It never races the primary channel.
//   - UpdateDescriptionCnLlm writes into description_cn IS NULL only — a
//     machine translation can never replace bangumi, manual, or even an
//     earlier llm value.
//   - The reverse IS allowed: ListDescriptionCnCandidates hands
//     source='llm' rows back to the Bangumi sweep on its 30-day cadence, so
//     a human-written summary appearing upstream eventually replaces the
//     machine translation.
//
// # SERP boundary
//
// Machine-translated text is BODY COPY ONLY.  generateMetadata and the
// JSON-LD builder in next-app read detail.description (the English
// original) and must keep doing so for llm-sourced rows — the detail page
// renders an attribution line and withholds llm text from snippets, keyed
// on descriptionCnSource.  Nothing in this file can enforce that; it is
// recorded here because this file is where the text enters the system.
//
// # Cost — the old estimate was wrong
//
// This header used to promise the whole backlog (~11,600 rows, ~4M chars of
// English) cost "about one US dollar": ~1M input tokens plus ~2.5M output
// tokens, the output side derived from how long the Chinese translations
// come out.
//
// That arithmetic silently assumed a non-reasoning model.  deepseek-v4-flash
// emits a chain of thought BEFORE the answer and the provider bills those
// reasoning tokens as output, so the visible translation — the only thing
// the estimate counted — is the minority of what is charged.  The 2026-08
// incident that produced this note measured single synopses whose reasoning
// chain ran to 3,943 tokens on its own, against translations of a few
// hundred; ordinary rows still land in the high hundreds to low thousands.
// The real output volume is therefore a multiple of the old figure, and the
// multiple is not stable enough to write down: it moves with the source
// text, the model version, and the max_tokens budget.
//
// So this file cannot tell you the price.  Read the DeepSeek billing
// dashboard after a full walk and treat every token count above as a stale
// sample rather than a forecast.  Only the old note's conclusion survives,
// and it still holds: the constants below optimise for operational calm,
// because the spend is dominated by the first walk either way and the sweep
// is a trickle afterwards.
//
// The same incident showed the failure mode is not "somewhat over budget"
// but "burn with nothing to show for it" — roughly 2M output tokens went to
// completions that came back empty, the reasoning chain having eaten the
// whole budget before the translation started.  See the empty-completion
// outcome on Work below for why that no longer wedges the sweep.
package queue

import (
	"context"
	"errors"
	"fmt"
	"html"
	"log/slog"
	"regexp"
	"strings"
	"time"
	"unicode"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/riverqueue/river"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// descriptionLlmScanBatchSize is how many candidate rows one scan pass turns
// into jobs.
//
// Unlike the Bangumi sweep there is no shared token bucket to protect — the
// constraint is wall-clock inside the hourly interval.  600 rows an hour
// across the LLM queue's 4 workers (the MaxWorkers entry for
// DescriptionLlmQueueName in cmd/server/main.go) walks the ~11,600-row
// backlog in about 20 hours.
//
// The old headroom claim behind that number — "~2-4s per completion, drains
// in well under 15 minutes" — is retired.  A reasoning model generates its
// entire chain of thought before the first character of the translation, so
// a completion is materially slower and the true drain time is no longer
// measured.  Overrunning the hour is survivable rather than compounding:
// DescriptionLlmBackfillArgs dedupes ByArgs, so the next scan re-submits the
// rows still queued and river skips them.  If the queue is visibly backed
// up, lower this number — do not raise it on the assumption the retired
// figure still holds.
const descriptionLlmScanBatchSize int32 = 600

// descriptionLlmWorkTimeout bounds one row: a DB re-read, one completion,
// one UPDATE.  The deepseek client's own 60s HTTP timeout sits inside this,
// so this fires only when the DB side wedges too.
//
// The 60s inner bound was sized for a plain translation and has become the
// live constraint now that the model reasons first: a long chain of thought
// spends real wall-clock before any output token.  A trip is safe (transport
// error → no stamp → river retries) but pure waste, so if the logs fill with
// client timeouts, raise the client bound and this one together — this must
// stay comfortably above it or the job dies before the client can report.
const descriptionLlmWorkTimeout = 90 * time.Second

// descriptionLlmScanInterval matches the Bangumi sweep's hourly cadence for
// the same reason: the scan is one indexed SELECT, and the interval must
// stay far above a batch's drain time so passes never stack.
const descriptionLlmScanInterval = time.Hour

// descriptionLlmRetryDays is the cooldown before a decided row is looked at
// again.  A row lands here when validation rejected the model's output, when
// the completion came back empty (the reasoning chain outran the token
// budget), or when the source text stripped to nothing — all worth a re-try
// eventually (models and prompts improve; budgets get raised; descriptions
// get edited upstream) but not worth spending tokens on next hour.  This
// cooldown IS the retry channel for those rows; river's attempt ladder
// deliberately is not.  30 days matches the Bangumi sweep.
const descriptionLlmRetryDays = 30

// descriptionLlmSystemPrompt is the fixed instruction prefix.  Constant so
// every request shares an identical prefix — DeepSeek prices cached prefix
// tokens at 1/50th of the miss rate, and across ~11,600 requests the system
// prompt is the bulk of the non-content input.
const descriptionLlmSystemPrompt = `You are a professional translator of anime synopses. Translate the user's English anime synopsis into natural, fluent Simplified Chinese.

Rules:
- Keep proper nouns (character names, place names, in-world terms) accurate: use the established Chinese rendering when one is widely known, otherwise keep the original form.
- Do not add, omit, or embellish information. No translator's notes, no commentary.
- Drop trailing source-attribution tags such as "(Source: ...)" — they are catalogue metadata, not synopsis.
- Output ONLY the translated synopsis as plain text. No HTML, no markdown, no quotation marks around the whole text.`

// descriptionLlmRetryAfter builds the interval bound for the candidate
// query.  Per-call for the same mutability reason as
// descriptionBackfillRetryAfter.
func descriptionLlmRetryAfter() pgtype.Interval {
	return pgtype.Interval{Days: descriptionLlmRetryDays, Valid: true}
}

// DescriptionTranslator is the single-method surface the row worker calls.
// *deepseek.Client satisfies it; tests substitute a canned double.  Declared
// here (use-site) so the queue package does not import the deepseek package.
type DescriptionTranslator interface {
	Chat(ctx context.Context, system, user string) (string, error)
}

// permanentError is the behaviour — not the type — that marks an upstream
// failure as one no amount of retrying can fix.  *deepseek.ErrUpstream
// implements it for 401 / 402 / 403 (dead key, unfunded account, entitlement
// revoked).
//
// Declared as a local interface, and matched with errors.As against a
// pointer to it, so the queue package still does NOT import deepseek — the
// same decoupling DescriptionTranslator exists to preserve.  Importing the
// client just to read one status code would trade a real architectural
// boundary for a log line.
//
// What this deliberately does NOT do: change behaviour.  A permanent error
// still returns, still goes unstamped, still rides river's retry ladder —
// because 401/402/403 are facts about the ACCOUNT, not about the row, and
// every row-level reaction is a lie.  Stamping would record "tried, nothing
// came back" for 11,600 rows that were never tried and bury them under a
// 30-day cooldown; returning nil without a stamp would strip the backoff and
// turn a silent bug into 600 billable failures an hour.
//
// The real defect was never the retry policy, it was visibility: 25 attempts
// on an attempt⁴ ladder is ~20 days, so an expired card produced no signal
// anyone would see in time.  This raises that one arm to ERROR with the
// status and body attached, which is where the cause is actually written.
// If an alert on it ever fires and goes unread, the correct escalation is
// pausing DescriptionLlmQueueName — the scan job rides that same queue
// (args.go InsertOpts), so a pause cuts the feed and the drain in one move,
// and resuming is a human decision because "did we pay" is a human fact.
type permanentError interface {
	Permanent() bool
}

// DescriptionLlmReader is the sqlc subset the scan worker reads.
type DescriptionLlmReader interface {
	ListDescriptionCnLlmCandidates(ctx context.Context, retryAfter pgtype.Interval, rowLimit int32) ([]int32, error)
}

// DescriptionLlmEnqueuer is the dispatch surface the scan worker needs.
type DescriptionLlmEnqueuer interface {
	EnqueueDescriptionLlmBackfillMany(ctx context.Context, jobs []DescriptionLlmBackfillArgs) error
}

// DescriptionLlmWriter is the per-row worker's DB surface: the work-time
// re-read plus the two writes (store / stamp).
type DescriptionLlmWriter interface {
	GetDescriptionForLlmTranslate(ctx context.Context, anilistID int32) (dbgen.GetDescriptionForLlmTranslateRow, error)
	UpdateDescriptionCnLlm(ctx context.Context, descriptionCn *string, anilistID int32) error
	MarkDescriptionCnLlmAttempted(ctx context.Context, anilistID int32) error
}

// DescriptionLlmScanWorker turns candidate rows into per-row jobs.
//
// disabled is the no-API-key posture: the worker registers either way (so a
// river client can always work jobs of this kind) but an unconfigured
// deployment scans nothing and enqueues nothing.  Logged at info once per
// pass — an hourly line is cheap, and its absence is how an operator
// notices the key went missing.
type DescriptionLlmScanWorker struct {
	river.WorkerDefaults[DescriptionLlmBackfillScanArgs]
	db       DescriptionLlmReader
	enq      DescriptionLlmEnqueuer
	disabled bool
}

// NewDescriptionLlmScanWorker constructs the scan worker.  Pass
// disabled=true when no translator is configured; db/enq stay required so a
// misconfigured ENABLED sweep crashes loudly (river contains the panic),
// matching NewDescriptionBackfillScanWorker's stance.
func NewDescriptionLlmScanWorker(db DescriptionLlmReader, enq DescriptionLlmEnqueuer, disabled bool) *DescriptionLlmScanWorker {
	return &DescriptionLlmScanWorker{db: db, enq: enq, disabled: disabled}
}

// Work reads one batch of candidates and enqueues a job per row.
func (w *DescriptionLlmScanWorker) Work(ctx context.Context, _ *river.Job[DescriptionLlmBackfillScanArgs]) error {
	if w.disabled {
		slog.InfoContext(ctx, "description_llm_scan disabled", "reason", "DEEPSEEK_API_KEY not set")
		return nil
	}

	ids, err := w.db.ListDescriptionCnLlmCandidates(ctx, descriptionLlmRetryAfter(), descriptionLlmScanBatchSize)
	if err != nil {
		return fmt.Errorf("description_llm_scan list (limit=%d): %w", descriptionLlmScanBatchSize, err)
	}
	if len(ids) == 0 {
		slog.InfoContext(ctx, "description_llm_scan idle", "candidates", 0)
		return nil
	}

	jobs := make([]DescriptionLlmBackfillArgs, len(ids))
	for i, id := range ids {
		jobs[i] = DescriptionLlmBackfillArgs{AnilistID: int(id)}
	}
	if err := w.enq.EnqueueDescriptionLlmBackfillMany(ctx, jobs); err != nil {
		return fmt.Errorf("description_llm_scan enqueue (n=%d): %w", len(jobs), err)
	}

	// "submitted", not "enqueued" — ByArgs dedupe may skip rows still queued
	// from the previous pass; the true insert count is on the enqueuer's
	// debug line and real coverage lives in the database.
	slog.InfoContext(ctx, "description_llm_scan done",
		"candidates", len(ids),
		"submitted", len(jobs))
	return nil
}

// DescriptionLlmWorker translates one row.
type DescriptionLlmWorker struct {
	river.WorkerDefaults[DescriptionLlmBackfillArgs]
	llm DescriptionTranslator
	db  DescriptionLlmWriter
}

// NewDescriptionLlmWorker constructs the row worker.  A nil translator is
// tolerated defensively (Work warns and no-ops) because the disabled scan
// never enqueues — the only way a job meets a nil translator is a key
// removed mid-flight, and eating the leftover jobs beats crashing on them.
func NewDescriptionLlmWorker(llm DescriptionTranslator, db DescriptionLlmWriter) *DescriptionLlmWorker {
	return &DescriptionLlmWorker{llm: llm, db: db}
}

// Work translates one row's synopsis.
//
// Outcomes:
//   - row gone (pgx.ErrNoRows) — return nil, nothing to stamp.
//   - description_cn already set — Bangumi won the race between scan and
//     work.  Stamp + nil: decided, and the stamp keeps the row out of the
//     next pass cheaply.
//   - source text strips to nothing — stamp + nil (decided; nothing to
//     translate).
//   - completion transport/API error — wrapped and returned so river
//     retries.  NOT stamped: a 429 or timeout says nothing about the row.
//     This is the boundary against the next case: an error means no answer
//     ever arrived, so the row is undecided.
//     401/402/403 take this same ladder ON PURPOSE — they are facts about
//     the account, not the row, so no row-level verdict is honest — but
//     they first get an ERROR line naming the status, because 25 attempts
//     of attempt⁴ backoff is ~20 days and an expired card used to produce
//     no signal anyone would see in time.  See permanentError.
//   - completion succeeded but returned an empty string — a DECIDED
//     outcome, not a fault.  It falls through to validateTranslation, fails
//     the non-empty check, and lands in the next arm (stamp + warn + nil).
//     That routing is the whole point: a reasoning model that spends its
//     max_tokens budget on the chain of thought answers 200 OK with
//     finish_reason "length" and content "" — the request worked, the row
//     simply has no translation.  Before 2026-08 the client reported that as
//     an error, so Work returned at the arm above and NEVER reached
//     markAttempted: description_cn_llm_attempted_at stayed NULL, the
//     candidate query's `NULLS FIRST` handed the same rows back at the head
//     of every batch, and river spread 25 doomed attempts over ~20 days
//     before discarding them — whereupon the next scan re-enqueued the row.
//     997 failed calls, 74 wedged jobs, ~2M output tokens, zero rows
//     translated.  The stamp is what breaks the loop; the 30-day cooldown is
//     the retry, river is not.
//   - output fails validation — stamp + warn + nil.  Decided for now; the
//     30-day cooldown doubles as a retry with a better model/prompt.
//   - write failure — warn and fall through to the stamp, mirroring
//     persistDescriptionCn's stance: retrying would re-spend tokens on an
//     optional column.
func (w *DescriptionLlmWorker) Work(ctx context.Context, job *river.Job[DescriptionLlmBackfillArgs]) error {
	anilistID := int32(job.Args.AnilistID)

	if w.llm == nil {
		slog.WarnContext(ctx, "description_llm worker without translator; skipping",
			"anilistId", anilistID)
		return nil
	}

	ctx, cancel := context.WithTimeout(ctx, descriptionLlmWorkTimeout)
	defer cancel()

	row, err := w.db.GetDescriptionForLlmTranslate(ctx, anilistID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("description_llm read %d: %w", anilistID, err)
	}
	if row.DescriptionCn != nil && *row.DescriptionCn != "" {
		w.markAttempted(ctx, anilistID)
		return nil
	}

	src := ""
	if row.Description != nil {
		src = stripDescriptionHTML(*row.Description)
	}
	if src == "" {
		w.markAttempted(ctx, anilistID)
		slog.DebugContext(ctx, "description_llm empty source", "anilistId", anilistID)
		return nil
	}

	out, err := w.llm.Chat(ctx, descriptionLlmSystemPrompt, src)
	if err != nil {
		// Account-level failures get an ERROR line before taking the same
		// retry path as everything else.  See permanentError for why the
		// behaviour is deliberately unchanged and only the volume differs.
		var perm permanentError
		if errors.As(err, &perm) && perm.Permanent() {
			slog.ErrorContext(ctx, "description_llm upstream rejected the account; sweep will stall",
				"anilistId", anilistID,
				"err", err)
		}
		return fmt.Errorf("description_llm translate %d: %w", anilistID, err)
	}

	cleaned, ok := validateTranslation(src, out)
	if !ok {
		w.markAttempted(ctx, anilistID)
		slog.WarnContext(ctx, "description_llm output rejected",
			"anilistId", anilistID,
			"outLen", len(out))
		return nil
	}

	if err := w.db.UpdateDescriptionCnLlm(ctx, &cleaned, anilistID); err != nil {
		slog.WarnContext(ctx, "description_llm write error",
			"anilistId", anilistID,
			"err", err)
	}
	w.markAttempted(ctx, anilistID)

	slog.DebugContext(ctx, "description_llm done",
		"anilistId", anilistID,
		"srcLen", len(src),
		"outLen", len(cleaned))
	return nil
}

// markAttempted mirrors the Bangumi sweep's helper: bookkeeping, logged not
// returned, safe to miss (the row just gets re-picked later).
func (w *DescriptionLlmWorker) markAttempted(ctx context.Context, anilistID int32) {
	if err := w.db.MarkDescriptionCnLlmAttempted(ctx, anilistID); err != nil {
		slog.WarnContext(ctx, "description_llm attempt stamp failed",
			"anilistId", anilistID,
			"err", err)
	}
}

// PeriodicDescriptionLlmBackfillScanJob returns the hourly trigger.
// RunOnStart=true for the same reason as the Bangumi sweep: this scan has no
// boot-time companion call, and river schedules a periodic job's first run a
// full interval after Start — without it, frequent deploys could starve the
// sweep entirely.  Registered unconditionally; the disabled posture lives in
// the scan worker, keeping the wiring identical whether or not a key is set.
func PeriodicDescriptionLlmBackfillScanJob() *river.PeriodicJob {
	return river.NewPeriodicJob(
		river.PeriodicInterval(descriptionLlmScanInterval),
		func() (river.JobArgs, *river.InsertOpts) {
			return DescriptionLlmBackfillScanArgs{}, nil
		},
		&river.PeriodicJobOpts{RunOnStart: true},
	)
}

// AddDescriptionLlmWorkers registers both workers on an existing bundle.
// Separate from WorkersWithBangumi so that function's signature (and its
// existing call sites and test doubles) stay untouched; main.go calls this
// immediately after building the bundle.  translator may be nil — the scan
// worker registers disabled and the sweep is inert until a key is deployed.
func AddDescriptionLlmWorkers(w *river.Workers, translator DescriptionTranslator, db interface {
	DescriptionLlmReader
	DescriptionLlmWriter
}, enq DescriptionLlmEnqueuer) {
	river.AddWorker(w, NewDescriptionLlmScanWorker(db, enq, translator == nil))
	river.AddWorker(w, NewDescriptionLlmWorker(translator, db))
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

var (
	// brTag matches the <br>, <br/>, <br /> line-break family AniList
	// descriptions use between paragraphs.
	brTag = regexp.MustCompile(`(?i)<br\s*/?\s*>`)
	// anyTag matches every other tag (AniList uses <i>, <b>, <a>, spoiler
	// spans); their text content is kept, only the markup goes.
	anyTag = regexp.MustCompile(`<[^>]*>`)
	// sourceTail matches a trailing "(Source: …)" / "[Written by …]"
	// attribution line — catalogue metadata, not synopsis, and the prompt
	// tells the model to drop it; stripping it here saves the tokens too.
	// Deliberately NOT anchored to the end.  It was, and 240 of the rows
	// still waiting carry the attribution mid-text — AniList appends a
	// "Note: ..." paragraph (air-date corrections, cancellations) after it,
	// which pushed the tag out of reach of a `$`-anchored pattern and sent
	// it to the model.  With the chain of thought disabled the model no
	// longer silently drops such a line, so stripping it here is what keeps
	// it out of the translation.
	//
	// The colon after "source" is load-bearing: unanchored and without it,
	// an ordinary sentence like "(source of his power)" would match and be
	// deleted from the synopsis.  "written by" needs no colon — it is only
	// ever the credit form.
	sourceTail = regexp.MustCompile(`(?is)[\(\[]\s*(?:source\s*:|written by\b)[^\)\]]*[\)\]]`)
	// blankRuns collapses 3+ newlines to a paragraph break.
	blankRuns = regexp.MustCompile(`\n{3,}`)
)

// stripDescriptionHTML flattens an AniList description to plain text: break
// tags become newlines, other tags drop their markup, entities decode, the
// trailing source attribution goes, and whitespace tidies up.  Applied
// BEFORE the completion call so the model sees prose (fewer tokens, no HTML
// for it to echo back).
func stripDescriptionHTML(s string) string {
	s = brTag.ReplaceAllString(s, "\n")
	s = anyTag.ReplaceAllString(s, "")
	s = html.UnescapeString(s)
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = sourceTail.ReplaceAllString(s, "")
	s = blankRuns.ReplaceAllString(s, "\n\n")
	return strings.TrimSpace(s)
}

// validateTranslation gates what lands in the database.  The model is asked
// for plain Chinese prose; anything else — an English refusal, an
// accidental echo of the source, markup, pathological length — must fail
// closed, because a bad write here is a whole page of wrong text under a
// real anime's title.
//
// Checks, in order:
//   - non-empty after trimming (and after stripping any markup the model
//     ignored instructions about).  Load-bearing, not belt-and-braces: since
//     2026-08 this is also where a SUCCESSFUL completion carrying no content
//     lands — a reasoning model whose chain of thought consumed the whole
//     max_tokens budget.  Routing it here is what stamps the row and stops
//     the sweep re-serving it forever; do not remove the check as
//     unreachable.
//   - actually Chinese: ≥10 Han runes AND Han runes ≥25% of all runes.
//     English refusals ("I'm sorry, I can't…") and untranslated echoes have
//     near-zero Han density; legitimate translations of even the shortest
//     synopsis clear both bars comfortably.
//   - length sanity: no longer than 4× the source in bytes (+200 slack for
//     very short sources).  Chinese runs shorter than English; a blow-up
//     means the model padded or looped.
func validateTranslation(src, out string) (string, bool) {
	cleaned := strings.TrimSpace(anyTag.ReplaceAllString(out, ""))
	if cleaned == "" {
		return "", false
	}

	han := 0
	total := 0
	for _, r := range cleaned {
		total++
		if unicode.Is(unicode.Han, r) {
			han++
		}
	}
	if han < 10 || han*4 < total {
		return "", false
	}

	if len(cleaned) > 4*len(src)+200 {
		return "", false
	}
	return cleaned, true
}

// Compile-time guards: both workers must satisfy river.Worker for their args.
var (
	_ river.Worker[DescriptionLlmBackfillScanArgs] = (*DescriptionLlmScanWorker)(nil)
	_ river.Worker[DescriptionLlmBackfillArgs]     = (*DescriptionLlmWorker)(nil)
)
