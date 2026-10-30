package admin

// activity.go — GET /api/admin/activity, the user-activity panel.
//
// The wire contract, and the definitions every number in it uses (person,
// signup day, returning, signup-only, reconstructed), live in
// next-app/src/app/[lang]/admin/_types/activity.ts.  The types below encode
// exactly those field names; change one side and the other together.
//
// WHAT THIS ENDPOINT EXISTS TO FIX.  Before migration 0025 the admin page
// could report how many accounts existed and what each of them had subscribed
// to, commented on or followed — and nothing else.  Every one of those is a
// deliberate social action, so a reader who visited every evening without
// performing one was, to every query this codebase could write, identical to
// somebody who registered once and never came back.  "How many people were
// here today", "did last week's signups return" were not slow queries; they
// had no answer.  This endpoint is the answer, and its entire credibility
// rests on being clear about which parts of it are measured and which are
// inferred.
//
// TWO RELIABILITY TIERS, AND THE PAYLOAD KEEPS THEM APART:
//
//	everything from
//	instrumentedSince   server-side, derived from a signed access token on a
//	                    real request.  Unforgeable, and nothing a client sends
//	                    can move it.  Decide on these.
//	everything before
//	instrumentedSince   reconstructed by migration 0026 from whatever other
//	                    tables happened to witness.  Interaction days, not
//	                    visits: a strict and small subset.
//
// Every block that covers a range says which tier its range starts in (the
// `reconstructed` flags, `instrumented` per day, a null same-time comparison),
// so the UI can draw the second tier as a floor rather than blend it into the
// same line as the first.
//
// ONE SNAPSHOT PER REQUEST.  Every number comes out of one REPEATABLE READ
// READ ONLY transaction, so a response is never stitched together from two
// moments: depth.total is the 30-day window's active count, the daily bars
// add up to what the cards say, and a flush that commits mid-request is in
// every part of the response or in none.  The clock is the transaction's
// too: today and asOf come from the database's now(), and every judgement
// made here in Go -- gap filling, the instrumented and reconstructed flags,
// cohort eligibility -- is made against that today, never against this
// server's time.Now().
//
// PEOPLE, NOT ACCOUNTS.  The queries read the views activity_people and
// activity_days (migration 0054), so a deleted account is still counted in
// every number about the time it was here.
//
// WHAT THIS ENDPOINT CANNOT TELL YOU: anything about logged-out visitors.
// Every row it reads is keyed on a user id, so the majority of a search-led
// catalogue's traffic is outside its remit entirely.  That is a known gap and
// a deliberate one — see 0025's header for why closing it with a write
// endpoint on the hot path was the wrong trade.

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"slices"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/httpx"
)

const (
	// defaultActivityDays is the window the chart and the depth card open on.
	// Thirty days is long enough for a weekly rhythm to be visible (four
	// repeats, so a dip is distinguishable from a weekend) and short enough
	// that a single day is still a readable bar.
	defaultActivityDays = 30
	// minActivityDays keeps the window at least a week wide.  Below that,
	// weekday effects dominate anything the chart could show.
	minActivityDays = 7
	// maxActivityDays caps the scan.  Ninety days is a full quarter and stays
	// well inside migration 0025's 400-day retention, so the endpoint can
	// never ask for a range the table has already pruned and return a
	// misleading run of empty days at the far end.
	maxActivityDays = 90

	// activityShortWindowDays and activityLongWindowDays are the fixed windows the headline
	// cards read (windows.d7 / windows.d30), whatever ?days says.
	activityShortWindowDays = 7
	activityLongWindowDays  = 30
	// activitySignupWindowDays is the window signups30 covers.
	activitySignupWindowDays = 30
	// activityCohortWeeks is how many Monday-start signup weeks the retention table
	// lists, the current one included.
	activityCohortWeeks = 10

	// activityTimezoneLabel is reported in the payload so a reader can tell
	// which midnight the days are cut on without going to the schema.  It
	// MUST stay equal to the zone in internal/activity and in
	// internal/db/queries/activity.sql.
	activityTimezoneLabel = "Asia/Shanghai (UTC+8)"

	// dateLayout is the wire format for every date in this payload.  Plain
	// YYYY-MM-DD rather than RFC3339: these are calendar days in a named zone,
	// not instants, and rendering them as timestamps invites a browser to
	// re-interpret them in the reader's own timezone and shift every bar by
	// one day.
	dateLayout = "2006-01-02"

	panelDaySeconds = 24 * 60 * 60
)

// activityCohortHorizons are the retention horizons in days, in the order the payload
// lists them.  They MUST match ListActivityCohorts' returned_1 / returned_7 /
// returned_14 / returned_30 columns, which activityCohortHorizonsOf reads in this
// order.
var activityCohortHorizons = [...]int{1, 7, 14, 30}

// activityDepthEdges are the "how many days did they come" buckets before they are
// clipped to a window: 1, 2, 3–6, 7–13 and 14 or more.  The open-ended last
// edge is closed at the window's length, and an edge that starts beyond the
// window is dropped (see activityDepthBuckets).
var activityDepthEdges = [...]struct{ min, max int }{
	{1, 1}, {2, 2}, {3, 6}, {7, 13}, {14, math.MaxInt},
}

// ---------------------------------------------------------------------------
// Wire types (next-app/src/app/[lang]/admin/_types/activity.ts).
// ---------------------------------------------------------------------------

// ActivityPanel is the GET /api/admin/activity body.
type ActivityPanel struct {
	// Days is the window the chart and the depth card cover.
	Days     int    `json:"days"`
	Timezone string `json:"timezone"`
	// Today is the snapshot's reporting day; AsOf its moment, "YYYY-MM-DD
	// HH:mm" in +08.
	Today string `json:"today"`
	AsOf  string `json:"asOf"`
	// InstrumentedSince is the first day with per-request data, derived from
	// the data itself (the earliest row with a non-zero request count;
	// migration 0026's reconstruction always writes zero).  Null means
	// recording has not started and must be rendered as "not instrumented",
	// not as a date.
	InstrumentedSince *string `json:"instrumentedSince"`

	TodayActive ActivityTodayActive  `json:"todayActive"`
	Windows     ActivityWindows      `json:"windows"`
	Signups30   ActivitySignupWindow `json:"signups30"`

	// Daily has exactly Days points, oldest first, every day present.
	Daily []ActivityDay `json:"daily"`
	Depth ActivityDepth `json:"depth"`
	// Cohorts are the activityCohortWeeks most recent signup weeks, newest first.
	Cohorts []ActivityCohortWeek `json:"cohorts"`
}

// ActivityTodayActive is today so far, against the same moment of earlier
// days.  The two same-time comparisons are null when the day they describe
// predates instrumentation: a reconstructed day carries the time of an
// interaction, not of a first visit, so "by this time of day" has no answer
// there and any number would be made up.
type ActivityTodayActive struct {
	Active            int64  `json:"active"`
	SameTimeYesterday *int64 `json:"sameTimeYesterday"`
	SameTimeLastWeek  *int64 `json:"sameTimeLastWeek"`
	YesterdayTotal    int64  `json:"yesterdayTotal"`
}

// ActivityWindows are the two fixed windows the headline cards read.
type ActivityWindows struct {
	D7  ActivityWindow `json:"d7"`
	D30 ActivityWindow `json:"d30"`
}

// ActivityWindow is a window of Days days ending today and the window of the
// same length right before it.  Active is always Returning + SignupOnly.
type ActivityWindow struct {
	Days              int   `json:"days"`
	Active            int64 `json:"active"`
	Returning         int64 `json:"returning"`
	SignupOnly        int64 `json:"signupOnly"`
	PrevActive        int64 `json:"prevActive"`
	PrevReturning     int64 `json:"prevReturning"`
	PrevSignupOnly    int64 `json:"prevSignupOnly"`
	Reconstructed     bool  `json:"reconstructed"`
	PrevReconstructed bool  `json:"prevReconstructed"`
}

// ActivitySignupWindow counts signups in the last activitySignupWindowDays days and
// the window before, and how many of the recent ones came back later.
type ActivitySignupWindow struct {
	Count         int64 `json:"count"`
	PrevCount     int64 `json:"prevCount"`
	ReturnedAfter int64 `json:"returnedAfter"`
	// Reconstructed: ReturnedAfter may undercount.  Signups never do.
	Reconstructed bool `json:"reconstructed"`
}

// ActivityDay is one bar of the daily chart.
type ActivityDay struct {
	Date string `json:"date"`
	// Returning and SignupDay split the day's active people by whether the
	// day is their signup day.  People, not events: a person counts once per
	// day however many requests they make.
	Returning int64 `json:"returning"`
	SignupDay int64 `json:"signupDay"`
	// Requests counts authenticated API calls, including server-side
	// rendering fan-out and client polling: a volume signal, not an
	// engagement one.
	Requests int64 `json:"requests"`
	Logins   int64 `json:"logins"`
	// Instrumented is false for days that predate per-request recording.
	// Decided here rather than in the browser, so a client cannot get the
	// comparison subtly wrong (off by one on the boundary day, or a
	// timezone-shifted parse of the date string).
	Instrumented bool `json:"instrumented"`
	// Partial marks today: the day is not over.
	Partial bool `json:"partial"`
}

// ActivityDepth is how many distinct days people active in the Days-day
// window were active in it.  Total is the sum of the buckets.
type ActivityDepth struct {
	Days          int                   `json:"days"`
	Total         int64                 `json:"total"`
	SignupOnly    int64                 `json:"signupOnly"`
	Reconstructed bool                  `json:"reconstructed"`
	Buckets       []ActivityDepthBucket `json:"buckets"`
}

// ActivityDepthBucket covers Min..Max active days, inclusive.
type ActivityDepthBucket struct {
	Min   int   `json:"min"`
	Max   int   `json:"max"`
	Count int64 `json:"count"`
}

// ActivityCohortWeek is the people who signed up in one Monday-start week.
type ActivityCohortWeek struct {
	WeekStart string `json:"weekStart"`
	Signups   int64  `json:"signups"`
	// LastSignup is the latest signup day in the week; null when nobody
	// signed up.
	LastSignup *string `json:"lastSignup"`
	// Reconstructed: the week's earliest possible return day predates
	// instrumentation.
	Reconstructed bool                    `json:"reconstructed"`
	Horizons      []ActivityCohortHorizon `json:"horizons"`
}

// ActivityCohortHorizon is how many of a week's members were back within Days
// days of their signup day.  Eligible is false while the week can still gain
// members or any member's horizon is still open; until then Returned and the
// week's size are still growing and must not be shown as a rate.
type ActivityCohortHorizon struct {
	Days     int   `json:"days"`
	Returned int64 `json:"returned"`
	Eligible bool  `json:"eligible"`
}

// ---------------------------------------------------------------------------
// Reading: one snapshot per request.
// ---------------------------------------------------------------------------

// activityReader is the sqlc subset the panel reads.  Declared here per
// "accept interfaces, return structs"; dbgen.Queries satisfies it.
type activityReader interface {
	GetActivityClock(ctx context.Context) (dbgen.GetActivityClockRow, error)
	GetActivityTodayActive(ctx context.Context) (dbgen.GetActivityTodayActiveRow, error)
	GetActivityWindow(ctx context.Context, days int32) (dbgen.GetActivityWindowRow, error)
	GetActivitySignups(ctx context.Context, days int32) (dbgen.GetActivitySignupsRow, error)
	ListActivityDaily(ctx context.Context, dayCount int32) ([]dbgen.ListActivityDailyRow, error)
	ListActivityDepth(ctx context.Context, dayCount int32) ([]dbgen.ListActivityDepthRow, error)
	ListActivityCohorts(ctx context.Context, weeks int32) ([]dbgen.ListActivityCohortsRow, error)
}

// activitySnapshots runs fn against one consistent, read-only view of the
// database.  The handler's only way to the data, so a read outside the
// snapshot is not something it can do by accident.
type activitySnapshots interface {
	Read(ctx context.Context, fn func(activityReader) error) error
}

// activityTxBeginner is the pgxpool surface pgActivitySnapshots needs; *pgxpool.Pool
// satisfies it, and a test can substitute a fake.
type activityTxBeginner interface {
	BeginTx(ctx context.Context, txOptions pgx.TxOptions) (pgx.Tx, error)
}

// activitySnapshotOptions: REPEATABLE READ so every statement reads the same
// snapshot (READ COMMITTED takes a new one per statement, and the queries
// would disagree whenever a flush committed between two of them); READ ONLY
// because nothing here writes, and saying so lets Postgres refuse it if that
// ever changes.
var activitySnapshotOptions = pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly}

// pgActivitySnapshots is the production activitySnapshots.
type pgActivitySnapshots struct {
	db        activityTxBeginner
	newReader func(pgx.Tx) activityReader
}

func newPgActivitySnapshots(db activityTxBeginner) pgActivitySnapshots {
	return pgActivitySnapshots{
		db:        db,
		newReader: func(tx pgx.Tx) activityReader { return dbgen.New(tx) },
	}
}

// Read implements activitySnapshots.  Every query fn makes goes through the
// transaction; the transaction is committed when fn succeeds and rolled back
// otherwise (the deferred rollback after a commit is a no-op).
func (s pgActivitySnapshots) Read(ctx context.Context, fn func(activityReader) error) error {
	tx, err := s.db.BeginTx(ctx, activitySnapshotOptions)
	if err != nil {
		return fmt.Errorf("admin activity: begin snapshot: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if err := fn(s.newReader(tx)); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("admin activity: end snapshot: %w", err)
	}
	return nil
}

// ActivityHandlers carries the deps for the activity panel.  Its own bundle
// rather than more methods on Handlers, following HantHandlers: this is a
// self-contained surface that reads through its own transaction, and widening
// the shared adminQuerier interface would force every existing test double to
// grow methods it will never call.
type ActivityHandlers struct {
	snapshots activitySnapshots
}

// NewActivityHandlers constructs the bundle.  A nil pool panics at boot
// rather than at request time, matching the other handler constructors.
func NewActivityHandlers(pool *pgxpool.Pool) *ActivityHandlers {
	if pool == nil {
		panic("admin.NewActivityHandlers: nil pool")
	}
	return &ActivityHandlers{snapshots: newPgActivitySnapshots(pool)}
}

// GetActivity implements GET /api/admin/activity?days=N.
//
// All or nothing: a failed query fails the response.  A zero in this payload
// is a claim ("nobody came back"), so a block that could not be read must not
// ship as one, and a panel assembled from a partial read would no longer be
// one snapshot.
func (h *ActivityHandlers) GetActivity(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
	defer cancel()

	days := parseActivityDays(r.URL.Query().Get("days"))

	var rows activityRows
	err := h.snapshots.Read(ctx, func(q activityReader) error {
		var rerr error
		rows, rerr = readActivityRows(ctx, q, days)
		return rerr
	})
	if err != nil {
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "activity query failed"))
		return
	}

	panel, err := buildActivityPanel(days, rows)
	if err != nil {
		httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "activity query failed"))
		return
	}
	httpx.Data(w, http.StatusOK, panel)
}

// parseActivityDays clamps the window.  A missing or unparseable value falls
// back to the default rather than 400-ing: this is a dashboard knob, and the
// worst outcome of a typo should be the default view, not an error page.
func parseActivityDays(raw string) int {
	days := defaultActivityDays
	if raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil {
			days = parsed
		}
	}
	if days < minActivityDays {
		return minActivityDays
	}
	if days > maxActivityDays {
		return maxActivityDays
	}
	return days
}

// activityRows is everything one request reads, exactly as the queries
// returned it.
type activityRows struct {
	clock       dbgen.GetActivityClockRow
	todayActive dbgen.GetActivityTodayActiveRow
	shortWindow dbgen.GetActivityWindowRow
	longWindow  dbgen.GetActivityWindowRow
	signups     dbgen.GetActivitySignupsRow
	daily       []dbgen.ListActivityDailyRow
	depth       []dbgen.ListActivityDepthRow
	cohorts     []dbgen.ListActivityCohortsRow
}

// readActivityRows runs the panel's queries against q, the clock first.
func readActivityRows(ctx context.Context, q activityReader, days int) (activityRows, error) {
	var rows activityRows
	var err error
	if rows.clock, err = q.GetActivityClock(ctx); err != nil {
		return activityRows{}, fmt.Errorf("activity clock: %w", err)
	}
	if rows.todayActive, err = q.GetActivityTodayActive(ctx); err != nil {
		return activityRows{}, fmt.Errorf("activity today: %w", err)
	}
	if rows.shortWindow, err = q.GetActivityWindow(ctx, activityShortWindowDays); err != nil {
		return activityRows{}, fmt.Errorf("activity %d-day window: %w", activityShortWindowDays, err)
	}
	if rows.longWindow, err = q.GetActivityWindow(ctx, activityLongWindowDays); err != nil {
		return activityRows{}, fmt.Errorf("activity %d-day window: %w", activityLongWindowDays, err)
	}
	if rows.signups, err = q.GetActivitySignups(ctx, activitySignupWindowDays); err != nil {
		return activityRows{}, fmt.Errorf("activity signups: %w", err)
	}
	if rows.daily, err = q.ListActivityDaily(ctx, int32(days)); err != nil {
		return activityRows{}, fmt.Errorf("activity daily: %w", err)
	}
	if rows.depth, err = q.ListActivityDepth(ctx, int32(days)); err != nil {
		return activityRows{}, fmt.Errorf("activity depth: %w", err)
	}
	if rows.cohorts, err = q.ListActivityCohorts(ctx, activityCohortWeeks); err != nil {
		return activityRows{}, fmt.Errorf("activity cohorts: %w", err)
	}
	return rows, nil
}

// ---------------------------------------------------------------------------
// Building: pure functions of the rows and the snapshot's clock.
// ---------------------------------------------------------------------------

// buildActivityPanel assembles the payload.  It refuses rows that contradict
// the queries' own guarantees (a daily row outside the window, a day count
// no bucket holds) rather than drop them: a dropped row would make the chart
// quietly disagree with the cards, which is worse than an error.
func buildActivityPanel(days int, rows activityRows) (ActivityPanel, error) {
	clock, err := newActivityClock(rows.clock)
	if err != nil {
		return ActivityPanel{}, err
	}
	daily, err := buildActivityDaily(clock, days, rows.daily)
	if err != nil {
		return ActivityPanel{}, err
	}
	depth, err := buildActivityDepth(clock, days, rows.depth)
	if err != nil {
		return ActivityPanel{}, err
	}
	cohorts, err := buildActivityCohorts(clock, rows.cohorts)
	if err != nil {
		return ActivityPanel{}, err
	}
	return ActivityPanel{
		Days:              days,
		Timezone:          activityTimezoneLabel,
		Today:             clock.today.String(),
		AsOf:              clock.asOf,
		InstrumentedSince: panelDayString(clock.since, clock.hasSince),
		TodayActive:       buildActivityTodayActive(clock, rows.todayActive),
		Windows: ActivityWindows{
			D7:  buildActivityWindow(clock, activityShortWindowDays, rows.shortWindow),
			D30: buildActivityWindow(clock, activityLongWindowDays, rows.longWindow),
		},
		Signups30: buildActivitySignupWindow(clock, activitySignupWindowDays, rows.signups),
		Daily:     daily,
		Depth:     depth,
		Cohorts:   cohorts,
	}, nil
}

// panelDay is a calendar day in the reporting zone, counted in days since
// 1970-01-01.  An integer rather than a time.Time so the arithmetic in this
// file reads exactly like the SQL's (`today - 29`, `lastSignup + h <=
// today - 1`) and cannot pick up a time zone on the way: these are calendar
// days, not instants.
type panelDay int64

// panelDayOf converts a date the database returned.  pgx decodes a date
// as midnight UTC of that calendar day; only its year, month and day are
// read.  NULL and ±infinity are not days.
func panelDayOf(d pgtype.Date) (panelDay, bool) {
	if !d.Valid || d.InfinityModifier != pgtype.Finite {
		return 0, false
	}
	y, m, dd := d.Time.Date()
	return panelDay(time.Date(y, m, dd, 0, 0, 0, 0, time.UTC).Unix() / panelDaySeconds), true
}

// String formats the day as YYYY-MM-DD.
func (d panelDay) String() string {
	return time.Unix(int64(d)*panelDaySeconds, 0).UTC().Format(dateLayout)
}

// panelDayString is d as a nullable wire date.
func panelDayString(d panelDay, ok bool) *string {
	if !ok {
		return nil
	}
	s := d.String()
	return &s
}

// activityClock is the snapshot's clock: the database's today and asOf, and
// the instrumentation seam.
type activityClock struct {
	today    panelDay
	asOf     string
	since    panelDay
	hasSince bool
}

func newActivityClock(row dbgen.GetActivityClockRow) (activityClock, error) {
	today, ok := panelDayOf(row.Today)
	if !ok {
		return activityClock{}, fmt.Errorf("activity clock: the database returned no today")
	}
	since, hasSince := panelDayOf(row.InstrumentedSince)
	return activityClock{today: today, asOf: row.AsOf, since: since, hasSince: hasSince}, nil
}

// instrumented reports whether day has per-request data: instrumentation has
// started and day is on or after the day it did.
//
// Every "reconstructed" flag in the payload is this predicate negated for the
// FIRST day its range depends on -- a window's start, a week's earliest
// possible return day, the day a same-time comparison looks at -- so the
// boundary is defined once and moves for all of them together.
func (c activityClock) instrumented(day panelDay) bool {
	return c.hasSince && day >= c.since
}

// windowStart is the first day of the `days`-day range ending today.
func (c activityClock) windowStart(days int) panelDay {
	return c.today - panelDay(days-1)
}

// measured is n when day is instrumented and nil when it is not.
func (c activityClock) measured(day panelDay, n int64) *int64 {
	if !c.instrumented(day) {
		return nil
	}
	return &n
}

func buildActivityTodayActive(c activityClock, row dbgen.GetActivityTodayActiveRow) ActivityTodayActive {
	return ActivityTodayActive{
		Active:            row.Active,
		SameTimeYesterday: c.measured(c.today-1, row.SameTimeYesterday),
		SameTimeLastWeek:  c.measured(c.today-7, row.SameTimeLastWeek),
		YesterdayTotal:    row.YesterdayTotal,
	}
}

// buildActivityWindow fills one window.  Active is the sum of its two parts by
// construction: the query returns the parts (see GetActivityWindow), never a
// third count that could disagree with them.
func buildActivityWindow(c activityClock, days int, row dbgen.GetActivityWindowRow) ActivityWindow {
	start := c.windowStart(days)
	return ActivityWindow{
		Days:              days,
		Active:            row.ReturningPeople + row.SignupOnlyPeople,
		Returning:         row.ReturningPeople,
		SignupOnly:        row.SignupOnlyPeople,
		PrevActive:        row.PrevReturningPeople + row.PrevSignupOnlyPeople,
		PrevReturning:     row.PrevReturningPeople,
		PrevSignupOnly:    row.PrevSignupOnlyPeople,
		Reconstructed:     !c.instrumented(start),
		PrevReconstructed: !c.instrumented(start - panelDay(days)),
	}
}

func buildActivitySignupWindow(c activityClock, days int, row dbgen.GetActivitySignupsRow) ActivitySignupWindow {
	return ActivitySignupWindow{
		Count:         row.Signups,
		PrevCount:     row.PrevSignups,
		ReturnedAfter: row.ReturnedAfter,
		Reconstructed: !c.instrumented(c.windowStart(days)),
	}
}

// buildActivityDaily turns the sparse daily rows into one dense series, oldest
// day first, with a point for every day of [today-(days-1), today] -- the
// same range ListActivityDaily's predicate uses.
//
// GAPS ARE FILLED HERE, NOT IN SQL.  "No row" and "a row of zeroes" are
// different claims -- one says nobody came, the other says we did not look --
// and only the caller knows the window well enough to tell them apart.  The
// window is laid out from the snapshot's today, so it is the same set of days
// the query read even when this server's clock disagrees with the database's
// or the request straddles midnight.
func buildActivityDaily(c activityClock, days int, rows []dbgen.ListActivityDailyRow) ([]ActivityDay, error) {
	start := c.windowStart(days)
	byDay := make(map[panelDay]dbgen.ListActivityDailyRow, len(rows))
	for _, row := range rows {
		day, ok := panelDayOf(row.ActivityDate)
		if !ok {
			return nil, fmt.Errorf("activity daily: a row without a date")
		}
		if day < start || day > c.today {
			return nil, fmt.Errorf("activity daily: row for %s is outside [%s, %s]", day, start, c.today)
		}
		if _, dup := byDay[day]; dup {
			return nil, fmt.Errorf("activity daily: two rows for %s", day)
		}
		byDay[day] = row
	}

	out := make([]ActivityDay, 0, days)
	for day := start; day <= c.today; day++ {
		row := byDay[day] // the zero row when nobody was active
		out = append(out, ActivityDay{
			Date:         day.String(),
			Returning:    row.ReturningPeople,
			SignupDay:    row.SignupDayPeople,
			Requests:     row.Requests,
			Logins:       row.Logins,
			Instrumented: c.instrumented(day),
			Partial:      day == c.today,
		})
	}
	return out, nil
}

// activityDepthBuckets lays activityDepthEdges over a `days`-day window: an edge that starts
// after the window's last possible day count is dropped, and the rest are
// closed at `days`.  A 7-day window ends with {7, 7}; a 30-day one with
// {14, 30}.  The buckets always cover 1..days without a gap, so every person
// active in the window lands in exactly one.
func activityDepthBuckets(days int) []ActivityDepthBucket {
	out := make([]ActivityDepthBucket, 0, len(activityDepthEdges))
	for _, e := range activityDepthEdges {
		if e.min > days {
			break
		}
		out = append(out, ActivityDepthBucket{Min: e.min, Max: min(e.max, days)})
	}
	return out
}

// buildActivityDepth folds ListActivityDepth's histogram into the buckets.
// Total is the sum of what went into them, so it equals the sum of the
// buckets by construction.
func buildActivityDepth(c activityClock, days int, rows []dbgen.ListActivityDepthRow) (ActivityDepth, error) {
	buckets := activityDepthBuckets(days)
	var total, signupOnly int64
	for _, row := range rows {
		i := slices.IndexFunc(buckets, func(b ActivityDepthBucket) bool {
			return int64(b.Min) <= row.ActiveDays && row.ActiveDays <= int64(b.Max)
		})
		if i < 0 {
			return ActivityDepth{}, fmt.Errorf("activity depth: %d active days cannot happen in a %d-day window", row.ActiveDays, days)
		}
		buckets[i].Count += row.People
		total += row.People
		signupOnly += row.SignupOnly
	}
	return ActivityDepth{
		Days:          days,
		Total:         total,
		SignupOnly:    signupOnly,
		Reconstructed: !c.instrumented(c.windowStart(days)),
		Buckets:       buckets,
	}, nil
}

// buildActivityCohorts maps ListActivityCohorts' weeks, newest first, and
// judges each horizon's eligibility against the snapshot's today.
func buildActivityCohorts(c activityClock, rows []dbgen.ListActivityCohortsRow) ([]ActivityCohortWeek, error) {
	out := make([]ActivityCohortWeek, 0, len(rows))
	for _, row := range rows {
		weekStart, ok := panelDayOf(row.WeekStart)
		if !ok {
			return nil, fmt.Errorf("activity cohorts: a week without a start")
		}
		lastSignup, hasLast := panelDayOf(row.LastSignup)
		if hasLast != (row.Signups > 0) {
			return nil, fmt.Errorf("activity cohorts: week %s has %d signups but last signup %v", weekStart, row.Signups, hasLast)
		}
		out = append(out, ActivityCohortWeek{
			WeekStart:  weekStart.String(),
			Signups:    row.Signups,
			LastSignup: panelDayString(lastSignup, hasLast),
			// A member who signed up on the Monday can first come back on the
			// Tuesday.  If that day is already reconstructed, every rate in
			// the row may undercount.
			Reconstructed: !c.instrumented(weekStart + 1),
			Horizons:      activityCohortHorizonsOf(c, weekStart, lastSignup, hasLast, row),
		})
	}
	return out, nil
}

// activityCohortHorizonsOf lists a week's horizons in activityCohortHorizons order.
//
// ELIGIBLE means the week's members are final and every one of their horizons
// is over.
//
// The members are final once the week's Sunday, weekStart + 6, is a whole day
// in the past.  Before that, a signup later this week would join the
// denominator with a horizon that has barely begun: a week whose members so
// far all signed up on its Monday would otherwise print a one-day rate on the
// Wednesday and take it back when somebody signed up that afternoon.
//
// The last member to sign up is then the last to finish, and a horizon of h
// days is over once its final day, lastSignup + h, is a whole day in the
// past: lastSignup + h <= today - 1.  Today does not count -- it is not over
// -- so somebody who signed up yesterday is not yet eligible for the one-day
// horizon even though "tomorrow" has begun.
func activityCohortHorizonsOf(c activityClock, weekStart, lastSignup panelDay, hasLast bool, row dbgen.ListActivityCohortsRow) []ActivityCohortHorizon {
	returned := [len(activityCohortHorizons)]int64{row.Returned1, row.Returned7, row.Returned14, row.Returned30}
	membersFinal := weekStart+6 <= c.today-1
	out := make([]ActivityCohortHorizon, len(activityCohortHorizons))
	for i, h := range activityCohortHorizons {
		out[i] = ActivityCohortHorizon{
			Days:     h,
			Returned: returned[i],
			Eligible: hasLast && membersFinal && lastSignup+panelDay(h) <= c.today-1,
		}
	}
	return out
}
