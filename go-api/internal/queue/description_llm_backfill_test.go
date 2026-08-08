// description_llm_backfill_test.go — unit tests for the LLM translation
// fallback sweep.  No real DB, no real DeepSeek: fakes at each seam, same
// stance as description_backfill_test.go.
//
// The assertions that carry the most weight:
//
//   - the bangumi-won race: a row whose description_cn filled between scan
//     and work must NOT cost a completion (tokens are money; the primary
//     channel outranks this one).
//   - stamp discipline: transport errors must NOT stamp (river retries),
//     decided outcomes MUST (the sweep's finish guarantee rests on it).
//     TranslatorError_RetriedNotStamped and EmptyCompletion_StampedNotRetried
//     are a matched pair and belong together: the difference between "no
//     answer arrived" and "an empty answer arrived" is the whole 2026-08
//     incident, so changing one without the other means the boundary has
//     stopped being tested.
//   - validation fails closed: an English refusal or a runaway completion
//     must never reach UpdateDescriptionCnLlm.
package queue

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/riverqueue/river"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type fakeLlmReader struct {
	rows     []int32
	gotLimit int32
	err      error
	calls    int
}

func (f *fakeLlmReader) ListDescriptionCnLlmCandidates(_ context.Context, _ pgtype.Interval, rowLimit int32) ([]int32, error) {
	f.calls++
	f.gotLimit = rowLimit
	return f.rows, f.err
}

type fakeLlmEnqueuer struct {
	mu      sync.Mutex
	batches [][]DescriptionLlmBackfillArgs
	err     error
}

func (f *fakeLlmEnqueuer) EnqueueDescriptionLlmBackfillMany(_ context.Context, jobs []DescriptionLlmBackfillArgs) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	dup := make([]DescriptionLlmBackfillArgs, len(jobs))
	copy(dup, jobs)
	f.batches = append(f.batches, dup)
	return f.err
}

type fakeLlmWriter struct {
	row     dbgen.GetDescriptionForLlmTranslateRow
	readErr error

	wroteText *string
	writeErr  error
	stamped   []int32
}

func (f *fakeLlmWriter) GetDescriptionForLlmTranslate(_ context.Context, _ int32) (dbgen.GetDescriptionForLlmTranslateRow, error) {
	return f.row, f.readErr
}

func (f *fakeLlmWriter) UpdateDescriptionCnLlm(_ context.Context, descriptionCn *string, _ int32) error {
	f.wroteText = descriptionCn
	return f.writeErr
}

func (f *fakeLlmWriter) MarkDescriptionCnLlmAttempted(_ context.Context, anilistID int32) error {
	f.stamped = append(f.stamped, anilistID)
	return nil
}

type fakeTranslator struct {
	out     string
	err     error
	calls   int
	gotUser string
}

func (f *fakeTranslator) Chat(_ context.Context, _ string, user string) (string, error) {
	f.calls++
	f.gotUser = user
	return f.out, f.err
}

func llmJob(id int) *river.Job[DescriptionLlmBackfillArgs] {
	return &river.Job[DescriptionLlmBackfillArgs]{Args: DescriptionLlmBackfillArgs{AnilistID: id}}
}

const llmTestTranslation = "少年在异世界重新开始人生，与伙伴一同踏上冒险旅途，寻找回家的方法。"

// ---------------------------------------------------------------------------
// Scan worker
// ---------------------------------------------------------------------------

func TestLlmScan_MapsRowsToJobs(t *testing.T) {
	t.Parallel()

	db := &fakeLlmReader{rows: []int32{7, 42, 199409}}
	enq := &fakeLlmEnqueuer{}
	w := NewDescriptionLlmScanWorker(db, enq, false)

	require.NoError(t, w.Work(context.Background(), &river.Job[DescriptionLlmBackfillScanArgs]{}))

	assert.Equal(t, descriptionLlmScanBatchSize, db.gotLimit)
	require.Len(t, enq.batches, 1)
	assert.Equal(t, []DescriptionLlmBackfillArgs{
		{AnilistID: 7}, {AnilistID: 42}, {AnilistID: 199409},
	}, enq.batches[0])
}

func TestLlmScan_EmptyIsIdle(t *testing.T) {
	t.Parallel()

	db := &fakeLlmReader{rows: nil}
	enq := &fakeLlmEnqueuer{}
	w := NewDescriptionLlmScanWorker(db, enq, false)

	require.NoError(t, w.Work(context.Background(), &river.Job[DescriptionLlmBackfillScanArgs]{}))
	assert.Empty(t, enq.batches)
}

func TestLlmScan_DisabledNeverReads(t *testing.T) {
	t.Parallel()

	db := &fakeLlmReader{rows: []int32{1}}
	enq := &fakeLlmEnqueuer{}
	w := NewDescriptionLlmScanWorker(db, enq, true)

	require.NoError(t, w.Work(context.Background(), &river.Job[DescriptionLlmBackfillScanArgs]{}))
	assert.Zero(t, db.calls, "disabled sweep must not even list candidates")
	assert.Empty(t, enq.batches)
}

func TestLlmScan_ReaderErrorPropagates(t *testing.T) {
	t.Parallel()

	w := NewDescriptionLlmScanWorker(&fakeLlmReader{err: errors.New("pg down")}, &fakeLlmEnqueuer{}, false)
	require.Error(t, w.Work(context.Background(), &river.Job[DescriptionLlmBackfillScanArgs]{}))
}

func TestLlmScan_EnqueueErrorPropagates(t *testing.T) {
	t.Parallel()

	w := NewDescriptionLlmScanWorker(
		&fakeLlmReader{rows: []int32{1}},
		&fakeLlmEnqueuer{err: errors.New("river down")},
		false,
	)
	require.Error(t, w.Work(context.Background(), &river.Job[DescriptionLlmBackfillScanArgs]{}))
}

// ---------------------------------------------------------------------------
// Row worker
// ---------------------------------------------------------------------------

func TestLlmWorker_HappyPath(t *testing.T) {
	t.Parallel()

	db := &fakeLlmWriter{row: dbgen.GetDescriptionForLlmTranslateRow{
		Description: ptr("A boy restarts his life in another world.<br><br>(Source: MAL)"),
	}}
	tr := &fakeTranslator{out: llmTestTranslation}
	w := NewDescriptionLlmWorker(tr, db)

	require.NoError(t, w.Work(context.Background(), llmJob(42)))

	assert.Equal(t, 1, tr.calls)
	assert.NotContains(t, tr.gotUser, "<br>", "HTML must be stripped before the completion")
	assert.NotContains(t, tr.gotUser, "(Source:", "attribution tail must be stripped before the completion")
	require.NotNil(t, db.wroteText)
	assert.Equal(t, llmTestTranslation, *db.wroteText)
	assert.Equal(t, []int32{42}, db.stamped)
}

func TestLlmWorker_BangumiWonRace_NoTokensSpent(t *testing.T) {
	t.Parallel()

	db := &fakeLlmWriter{row: dbgen.GetDescriptionForLlmTranslateRow{
		Description:   ptr("English synopsis."),
		DescriptionCn: ptr("Bangumi 已经写入的真实中文简介。"),
	}}
	tr := &fakeTranslator{out: llmTestTranslation}
	w := NewDescriptionLlmWorker(tr, db)

	require.NoError(t, w.Work(context.Background(), llmJob(7)))

	assert.Zero(t, tr.calls, "a filled row must not cost a completion")
	assert.Nil(t, db.wroteText)
	assert.Equal(t, []int32{7}, db.stamped, "decided outcome still stamps")
}

func TestLlmWorker_RowGone_NoStamp(t *testing.T) {
	t.Parallel()

	db := &fakeLlmWriter{readErr: pgx.ErrNoRows}
	tr := &fakeTranslator{out: llmTestTranslation}
	w := NewDescriptionLlmWorker(tr, db)

	require.NoError(t, w.Work(context.Background(), llmJob(9)))
	assert.Zero(t, tr.calls)
	assert.Empty(t, db.stamped)
}

func TestLlmWorker_TranslatorError_RetriedNotStamped(t *testing.T) {
	t.Parallel()

	db := &fakeLlmWriter{row: dbgen.GetDescriptionForLlmTranslateRow{
		Description: ptr("English synopsis."),
	}}
	tr := &fakeTranslator{err: errors.New("429 too many requests")}
	w := NewDescriptionLlmWorker(tr, db)

	require.Error(t, w.Work(context.Background(), llmJob(11)))
	assert.Nil(t, db.wroteText)
	assert.Empty(t, db.stamped, "transient upstream failure must not stamp — river retries")
}

// permanentTestErr implements the same Permanent() behaviour
// *deepseek.ErrUpstream carries for 401/402/403, without importing the
// client — which is the entire point of matching on a local interface
// rather than a concrete type.  If someone "simplifies" the worker to
// errors.As against *deepseek.ErrUpstream, the queue package gains an
// import it deliberately does not have, and this double stops compiling
// as a stand-in.
type permanentTestErr struct{ perm bool }

func (e *permanentTestErr) Error() string   { return "upstream: 402 insufficient balance" }
func (e *permanentTestErr) Permanent() bool { return e.perm }

// TestLlmWorker_PermanentError_LoudButStillRetried pins the deliberate
// asymmetry: an account-level failure changes the LOG LEVEL and nothing
// else.  It must keep returning an error (so river backs off rather than
// hammering a dead key 600 times an hour) and must keep NOT stamping (so
// 11,600 untried rows are not buried under a 30-day cooldown recording a
// verdict that was never reached).
//
// Both halves are load-bearing in opposite directions — a future change
// that "handles" the permanent case by stamping it, or by returning nil,
// breaks exactly one of the two assertions below.
func TestLlmWorker_PermanentError_LoudButStillRetried(t *testing.T) {
	t.Parallel()

	db := &fakeLlmWriter{row: dbgen.GetDescriptionForLlmTranslateRow{
		Description: ptr("English synopsis."),
	}}
	tr := &fakeTranslator{err: &permanentTestErr{perm: true}}
	w := NewDescriptionLlmWorker(tr, db)

	require.Error(t, w.Work(context.Background(), llmJob(12)),
		"an account-level failure is still an error: the row is undecided")
	assert.Nil(t, db.wroteText)
	assert.Empty(t, db.stamped,
		"a dead key says nothing about this row — stamping it would record a verdict never reached")
}

// TestLlmWorker_NonPermanentError_Unchanged guards the other side of the
// errors.As branch: a wrapped error whose Permanent() is false must take
// the ordinary path, unchanged.  Without this, a branch that always
// matched would look correct in the test above.
func TestLlmWorker_NonPermanentError_Unchanged(t *testing.T) {
	t.Parallel()

	db := &fakeLlmWriter{row: dbgen.GetDescriptionForLlmTranslateRow{
		Description: ptr("English synopsis."),
	}}
	tr := &fakeTranslator{err: &permanentTestErr{perm: false}}
	w := NewDescriptionLlmWorker(tr, db)

	require.Error(t, w.Work(context.Background(), llmJob(13)))
	assert.Empty(t, db.stamped)
}

// TestLlmWorker_EmptyCompletion_StampedNotRetried is the regression test for
// the 2026-08 reasoning-token incident.
//
// deepseek-v4-flash reasons before it answers, and max_tokens caps reasoning
// plus answer together.  A chain of thought that eats the whole budget yields
// 200 OK, finish_reason "length", content "" — a request that SUCCEEDED and
// produced no translation.  The client used to report that as an error, so
// Work returned before markAttempted, the row's attempt stamp stayed NULL,
// and `ORDER BY ... NULLS FIRST` re-served the same rows at the head of every
// batch until river's 25 attempts (attempt⁴ backoff, ~20 days) discarded them
// and the next scan put them straight back.  997 failed calls, 74 wedged
// jobs, ~2M output tokens, nothing translated.
//
// The fix lives in the client (empty content is now ("", nil)); this asserts
// the worker end of the contract — the empty string must reach
// validateTranslation, be judged a decided outcome, and get stamped.  The
// stamp is the loop-breaker, so assert it explicitly rather than settling for
// "Work returned nil".
func TestLlmWorker_EmptyCompletion_StampedNotRetried(t *testing.T) {
	t.Parallel()

	db := &fakeLlmWriter{row: dbgen.GetDescriptionForLlmTranslateRow{
		Description: ptr("English synopsis long enough to translate."),
	}}
	tr := &fakeTranslator{out: "", err: nil}
	w := NewDescriptionLlmWorker(tr, db)

	require.NoError(t, w.Work(context.Background(), llmJob(19)),
		"an empty completion is a decided outcome, not a fault for river to retry")
	assert.Equal(t, 1, tr.calls)
	assert.Nil(t, db.wroteText, "empty content must never reach description_cn")
	assert.Equal(t, []int32{19}, db.stamped,
		"the stamp is what stops NULLS FIRST re-serving this row every pass")
}

func TestLlmWorker_RefusalRejected_StampedNotWritten(t *testing.T) {
	t.Parallel()

	db := &fakeLlmWriter{row: dbgen.GetDescriptionForLlmTranslateRow{
		Description: ptr("English synopsis long enough to translate."),
	}}
	tr := &fakeTranslator{out: "I'm sorry, but I can't translate this content."}
	w := NewDescriptionLlmWorker(tr, db)

	require.NoError(t, w.Work(context.Background(), llmJob(13)))
	assert.Nil(t, db.wroteText, "English refusal must never land in description_cn")
	assert.Equal(t, []int32{13}, db.stamped)
}

func TestLlmWorker_EmptySource_StampedNoCall(t *testing.T) {
	t.Parallel()

	db := &fakeLlmWriter{row: dbgen.GetDescriptionForLlmTranslateRow{
		Description: ptr("<br><br>(Source: MAL)"),
	}}
	tr := &fakeTranslator{out: llmTestTranslation}
	w := NewDescriptionLlmWorker(tr, db)

	require.NoError(t, w.Work(context.Background(), llmJob(15)))
	assert.Zero(t, tr.calls, "nothing left after stripping → nothing to spend")
	assert.Equal(t, []int32{15}, db.stamped)
}

func TestLlmWorker_NilTranslator_NoOps(t *testing.T) {
	t.Parallel()

	db := &fakeLlmWriter{row: dbgen.GetDescriptionForLlmTranslateRow{
		Description: ptr("English synopsis."),
	}}
	w := NewDescriptionLlmWorker(nil, db)

	require.NoError(t, w.Work(context.Background(), llmJob(17)))
	assert.Nil(t, db.wroteText)
	assert.Empty(t, db.stamped)
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

func TestStripDescriptionHTML(t *testing.T) {
	t.Parallel()

	in := "Line one.<br><br>Second &amp; <i>styled</i> line.<br/>\n\n\n\nThird.\n(Source: Crunchyroll)"
	out := stripDescriptionHTML(in)

	assert.NotContains(t, out, "<")
	assert.Contains(t, out, "Second & styled line.")
	assert.NotContains(t, out, "(Source:")
	assert.NotContains(t, out, "\n\n\n", "blank runs collapse to a paragraph break")
	assert.Equal(t, out, strings.TrimSpace(out))
}

// TestStripDescriptionHTML_SourceTagAnywhere covers the shape that made the
// attribution survive into 240 of the rows still queued: AniList appends a
// "Note: ..." paragraph AFTER the credit, so an end-anchored pattern never
// reached it and the tag went to the model.
//
// The last case is the reason the pattern demands a colon after "source".
// Unanchored without it, an ordinary parenthetical would be silently
// deleted from a synopsis — a quieter bug than the one being fixed.
func TestStripDescriptionHTML_SourceTagAnywhere(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name   string
		in     string
		absent string
		kept   string
	}{
		{
			name:   "credit followed by a Note paragraph",
			in:     "Body text.<br><br>(Source: Bushiroad)<br><br>Note: episode 1 was pre-screened.",
			absent: "Bushiroad",
			kept:   "Note: episode 1 was pre-screened.",
		},
		{
			name:   "two credits, both go",
			in:     "Body.\n(Source: ANN)\n(Source: MAL Rewrite)",
			absent: "Source:",
			kept:   "Body.",
		},
		{
			name:   "bracketed writer credit",
			in:     "Body.\n[Written by MAL Rewrite]\n\nNote: delayed.",
			absent: "Written by",
			kept:   "Note: delayed.",
		},
		{
			name:   "ordinary parenthetical survives",
			in:     "He must find the (source of his power) before dawn.",
			absent: "",
			kept:   "(source of his power)",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			out := stripDescriptionHTML(tc.in)
			if tc.absent != "" {
				assert.NotContains(t, out, tc.absent, "catalogue credit must not reach the model")
			}
			assert.Contains(t, out, tc.kept, "synopsis prose must survive")
		})
	}
}

func TestValidateTranslation(t *testing.T) {
	t.Parallel()

	src := "A boy restarts his life in another world and searches for a way home."

	cases := []struct {
		name string
		out  string
		ok   bool
	}{
		{"valid Chinese", llmTestTranslation, true},
		{"English refusal", "I'm sorry, but I can't help with that request.", false},
		{"empty", "   ", false},
		// The exact shape a budget-exhausted reasoning completion arrives in:
		// a successful call whose content is the zero value.  Distinct from
		// the whitespace case above — that one exercises TrimSpace, this one
		// is the incident.
		{"empty string from a successful completion", "", false},
		// …and the same outcome dressed as markup, which only strips to
		// nothing after anyTag runs.
		{"markup that strips to nothing", "<p></p>", false},
		{"untranslated echo", src, false},
		{"markup-only wrapper stripped but valid", "<p>" + llmTestTranslation + "</p>", true},
		{"runaway length", strings.Repeat("异世界冒险之旅永不停歇。", 60), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			cleaned, ok := validateTranslation(src, tc.out)
			assert.Equal(t, tc.ok, ok)
			if ok {
				assert.NotContains(t, cleaned, "<")
				assert.NotEmpty(t, cleaned)
			}
		})
	}
}
