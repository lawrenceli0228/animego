package admin

// list_users.go — GET /api/admin/users: the user table's page, its segment
// counts, and the per-page batches.
//
// The page query is composed at request time because its WHERE (search,
// segment, depth filter) and ORDER BY (five sorts) combine freely, which
// sqlc cannot express without a query per combination.  Composition follows
// one rule: the SQL text is assembled only from the constants in this file,
// chosen by values that parseUsersListParams has already checked against a
// whitelist, and every value that came from the request — the search
// pattern, the depth window and bounds, the page — travels as a bind
// parameter.  Nothing from the query string is ever spliced into the text.
//
// The reporting day is bound once, as $1, by a one-row CTE (`p.today`).
// Every date predicate reads it from there, so the same day drives the
// segment filters, the segment counts and the strip, and $1 is referenced
// by every statement whether or not a filter needs it (Postgres must be able
// to type every parameter it is sent).

import (
	"context"
	"fmt"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lawrenceli0228/animego/go-api/internal/auth"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// The segments, spelled as the query string and users.ts spell them.
const (
	segmentAll           = "all"
	segmentActive7       = "active7"
	segmentReturned      = "returned"
	segmentNeverReturned = "neverReturned"
	segmentSubscribed    = "subscribed"
	segmentAdmin         = "admin"
)

// The sorts.  All descending; lastSeen is the default.
const (
	sortLastSeen      = "lastSeen"
	sortJoined        = "joined"
	sortActiveDays    = "activeDays"
	sortSubscriptions = "subscriptions"
	sortWatched       = "watched"
)

// maxUsersPage caps ?page= so (page-1)*pageSize cannot overflow into a
// negative OFFSET.  Far beyond any real page: past the last one the answer
// is simply an empty page.
const maxUsersPage = 1 << 20

// userDayLayout is how a reporting day travels: a calendar date in +08,
// never an instant (see activity.ts / users.ts).
const userDayLayout = "2006-01-02"

// depthWindows are the windows the activity panel's depth rows link from.
var depthWindows = map[int32]bool{7: true, 30: true, 90: true}

// signupDaySQL is an account's signup day on the reporting boundary.
const signupDaySQL = `(u.created_at AT TIME ZONE 'Asia/Shanghai')::date`

// returnedSQL: recorded on any day after the signup day.  Shared by the
// segment filter, the segment count and the row's `returned` column.
const returnedSQL = `EXISTS (SELECT 1 FROM user_activity_daily AS a ` +
	`WHERE a.user_id = u.id AND a.activity_date > ` + signupDaySQL + `)`

// segmentConditions is the whitelist of segment predicates over `u`
// (users) and `p` (the reporting day).  "all" has none.
var segmentConditions = map[string]string{
	segmentActive7: `EXISTS (SELECT 1 FROM user_activity_daily AS a ` +
		`WHERE a.user_id = u.id AND a.activity_date >= p.today - 6)`,
	segmentReturned:      returnedSQL,
	segmentNeverReturned: `NOT ` + returnedSQL,
	segmentSubscribed:    `EXISTS (SELECT 1 FROM subscriptions AS s WHERE s.user_id = u.id)`,
	segmentAdmin:         `u.role = 'admin'`,
}

// userSegmentOrder is the order of the segment-count columns, and of the
// fields of userSegmentCounts.
var userSegmentOrder = []string{
	segmentAll, segmentActive7, segmentReturned, segmentNeverReturned, segmentSubscribed, segmentAdmin,
}

// depthConditionSQL keeps accounts recorded on between min and max distinct
// days (inclusive) in the window of `days` days ending today.  The three
// verbs are placeholders the builder numbers; the values are parameters.
const depthConditionSQL = `(SELECT count(*) FROM user_activity_daily AS a ` +
	`WHERE a.user_id = u.id AND a.activity_date BETWEEN p.today - (%s::int - 1) AND p.today) ` +
	`BETWEEN %s::int AND %s::int`

// usersCTE binds the reporting day; usersFrom is the row source every
// statement shares.
const (
	usersCTE  = `WITH p AS (SELECT $1::date AS today) `
	usersFrom = ` FROM users AS u CROSS JOIN p`
)

// userRowColumnsSQL is the page's projection.  Each counter is a correlated
// lookup on an indexed per-user key.  The sort keys below are these
// columns' aliases, so a column and the sort that claims to order by it are
// one expression and cannot drift apart.
const userRowColumnsSQL = `u.id, u.username, u.email, u.role, u.created_at, ` +
	`(SELECT max(a.last_seen_at) FROM user_activity_daily AS a WHERE a.user_id = u.id) AS last_seen_at, ` +
	`(SELECT count(*) FROM user_activity_daily AS a WHERE a.user_id = u.id) AS active_days, ` +
	`(SELECT COALESCE(sum(a.login_count), 0) FROM user_activity_daily AS a WHERE a.user_id = u.id)::bigint AS login_count, ` +
	`(SELECT count(*) FROM subscriptions AS s WHERE s.user_id = u.id) AS subscription_count, ` +
	`(SELECT count(*) FROM follows AS f WHERE f.followee_id = u.id) AS follower_count, ` +
	`(SELECT count(*) FROM subscriptions AS s WHERE s.user_id = u.id AND s.score IS NOT NULL) AS rating_count, ` +
	`(SELECT count(*) FROM episode_watches AS w WHERE w.user_id = u.id) AS watched_episodes, ` +
	returnedSQL + ` AS returned`

// userSortKeys maps each sort to its key.  Every sort is followed by
// created_at DESC, id DESC, so equal keys still page in a stable order.
var userSortKeys = map[string]string{
	sortLastSeen:      "last_seen_at",
	sortJoined:        "u.created_at",
	sortActiveDays:    "active_days",
	sortSubscriptions: "subscription_count",
	sortWatched:       "watched_episodes",
}

// userSegmentsSQL counts every segment over all accounts in one pass, from
// the same predicates the page filters with.
var userSegmentsSQL = buildUserSegmentsSQL()

func buildUserSegmentsSQL() string {
	var b strings.Builder
	b.WriteString(usersCTE + "SELECT ")
	for i, seg := range userSegmentOrder {
		if i > 0 {
			b.WriteString(", ")
		}
		if cond, ok := segmentConditions[seg]; ok {
			b.WriteString("count(*) FILTER (WHERE " + cond + ")::bigint")
			continue
		}
		b.WriteString("count(*)::bigint")
	}
	b.WriteString(usersFrom)
	return b.String()
}

// depthFilter is a validated ?depthDays=&depthMin=&depthMax= triple.
type depthFilter struct {
	Days int32
	Min  int32
	Max  int32
}

// usersListParams is the request after validation: Segment and Sort are
// always whitelisted values, Depth is nil unless all three parts were valid.
type usersListParams struct {
	Page    int
	Query   string
	Segment string
	Sort    string
	Depth   *depthFilter
	// Today is the reporting day (activity.Day) the request is answered for.
	Today time.Time
}

// parseUsersListParams reads the query string.  Anything unknown or partial
// falls back silently: an unknown segment means all, an unknown sort means
// lastSeen, and the depth filter applies only when depthDays is 7, 30 or 90
// and 1 <= depthMin <= depthMax.
func parseUsersListParams(qs url.Values, today time.Time) usersListParams {
	p := usersListParams{
		Page:    min(parsePage(qs.Get("page")), maxUsersPage),
		Query:   qs.Get("q"),
		Segment: segmentAll,
		Sort:    sortLastSeen,
		Depth:   parseDepthFilter(qs.Get("depthDays"), qs.Get("depthMin"), qs.Get("depthMax")),
		Today:   today,
	}
	if seg := qs.Get("segment"); slices.Contains(userSegmentOrder, seg) {
		p.Segment = seg
	}
	if s := qs.Get("sort"); userSortKeys[s] != "" {
		p.Sort = s
	}
	return p
}

func parseDepthFilter(daysRaw, minRaw, maxRaw string) *depthFilter {
	days, okDays := parseInt32(daysRaw)
	lo, okMin := parseInt32(minRaw)
	hi, okMax := parseInt32(maxRaw)
	if !okDays || !okMin || !okMax || !depthWindows[days] || lo < 1 || lo > hi {
		return nil
	}
	return &depthFilter{Days: days, Min: lo, Max: hi}
}

func parseInt32(s string) (int32, bool) {
	n, err := strconv.ParseInt(s, 10, 32)
	if err != nil {
		return 0, false
	}
	return int32(n), true
}

// usersListSQL is one request's statements and their parameters.
type usersListSQL struct {
	List      string
	ListArgs  []any
	Count     string
	CountArgs []any
}

// sqlParams numbers placeholders as values are added.
type sqlParams struct{ args []any }

func (s *sqlParams) add(v any) string {
	s.args = append(s.args, v)
	return "$" + strconv.Itoa(len(s.args))
}

// buildUsersListSQL composes the page and count statements.  The count
// takes the same filter and parameters, without LIMIT and OFFSET.
func buildUsersListSQL(p usersListParams) usersListSQL {
	var params sqlParams
	params.add(reportingDate(p.Today)) // $1, read through p.today

	conds := make([]string, 0, 3)
	if q := strings.TrimSpace(p.Query); q != "" {
		ph := params.add("%" + escapeLikePattern(q) + "%")
		conds = append(conds, "(u.username ILIKE "+ph+" OR u.email ILIKE "+ph+")")
	}
	if cond, ok := segmentConditions[p.Segment]; ok {
		conds = append(conds, cond)
	}
	if d := p.Depth; d != nil {
		conds = append(conds, fmt.Sprintf(depthConditionSQL, params.add(d.Days), params.add(d.Min), params.add(d.Max)))
	}
	where := ""
	if len(conds) > 0 {
		where = " WHERE " + strings.Join(conds, " AND ")
	}

	sortKey, ok := userSortKeys[p.Sort]
	if !ok {
		sortKey = userSortKeys[sortLastSeen]
	}
	countArgs := slices.Clone(params.args)
	page := min(max(p.Page, 1), maxUsersPage)
	limit := params.add(int64(pageSize))
	offset := params.add(int64(page-1) * pageSize)

	return usersListSQL{
		List: usersCTE + "SELECT " + userRowColumnsSQL + usersFrom + where +
			" ORDER BY " + sortKey + " DESC NULLS LAST, u.created_at DESC, u.id DESC" +
			" LIMIT " + limit + " OFFSET " + offset,
		ListArgs:  params.args,
		Count:     usersCTE + "SELECT count(*)::bigint" + usersFrom + where,
		CountArgs: countArgs,
	}
}

// reportingDate is a reporting day as a date parameter.
func reportingDate(day time.Time) pgtype.Date {
	return pgtype.Date{Time: time.Date(day.Year(), day.Month(), day.Day(), 0, 0, 0, 0, time.UTC), Valid: true}
}

// usersListResult is what runUsersList hands the handler.
type usersListResult struct {
	Items    []userItem
	Total    int64
	Segments userSegmentCounts
}

// userBatchQuerier is the sqlc subset the per-page batches use.
type userBatchQuerier interface {
	ListAdminUserRecentDays(ctx context.Context, userIds []uuid.UUID, today pgtype.Date) ([]dbgen.ListAdminUserRecentDaysRow, error)
	ListAdminUserLastDevices(ctx context.Context, userIds []uuid.UUID) ([]dbgen.ListAdminUserLastDevicesRow, error)
}

// runUsersList runs the page, the count, the segment counts and the two
// batches for the page's accounts (the 30-day strips and the last devices)
// in one REPEATABLE READ READ ONLY transaction, the activity panel's
// snapshot options.
//
// One snapshot is what makes the numbers on a page agree with each other.
// Run on separate connections, each statement read its own instant, so a
// signup or an activity flush landing between two of them put a chip's
// count one away from the total under it, or a row's strip a day away from
// the segment it was listed under.  The statements run one after another on
// the transaction's connection; each is a few milliseconds at this scale.
func runUsersList(ctx context.Context, pool *pgxpool.Pool, p usersListParams) (usersListResult, error) {
	stmts := buildUsersListSQL(p)

	tx, err := pool.BeginTx(ctx, activitySnapshotOptions)
	if err != nil {
		return usersListResult{}, fmt.Errorf("users list: begin snapshot: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	items, err := queryUserRows(ctx, tx, stmts.List, stmts.ListArgs)
	if err != nil {
		return usersListResult{}, err
	}
	var res usersListResult
	if err := tx.QueryRow(ctx, stmts.Count, stmts.CountArgs...).Scan(&res.Total); err != nil {
		return usersListResult{}, fmt.Errorf("users list count: %w", err)
	}
	var segments [6]int64
	dest := make([]any, len(segments))
	for i := range segments {
		dest[i] = &segments[i]
	}
	if err := tx.QueryRow(ctx, userSegmentsSQL, reportingDate(p.Today)).Scan(dest...); err != nil {
		return usersListResult{}, fmt.Errorf("users segment counts: %w", err)
	}
	res.Segments = userSegmentCounts{
		All: segments[0], Active7: segments[1], Returned: segments[2],
		NeverReturned: segments[3], Subscribed: segments[4], Admin: segments[5],
	}

	if err := attachUserBatches(ctx, dbgen.New(tx), items, p.Today); err != nil {
		return usersListResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return usersListResult{}, fmt.Errorf("users list: end snapshot: %w", err)
	}
	res.Items = items
	return res, nil
}

// userRowsQuerier is what queryUserRows reads through: the snapshot
// transaction in production.
type userRowsQuerier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// queryUserRows runs the page statement.  Every account starts with an
// empty strip and no device; attachUserBatches fills them in.
func queryUserRows(ctx context.Context, q userRowsQuerier, sql string, args []any) ([]userItem, error) {
	rows, err := q.Query(ctx, sql, args...)
	if err != nil {
		return nil, fmt.Errorf("users list query: %w", err)
	}
	defer rows.Close()

	items := []userItem{}
	for rows.Next() {
		var (
			it        userItem
			createdAt pgtype.Timestamptz
			lastSeen  pgtype.Timestamptz
		)
		if err := rows.Scan(
			&it.ID, &it.Username, &it.Email, &it.Role, &createdAt,
			&lastSeen, &it.ActiveDays, &it.Logins, &it.Subscriptions, &it.Followers,
			&it.Ratings, &it.WatchedEpisodes, &it.Returned,
		); err != nil {
			return nil, fmt.Errorf("users list scan: %w", err)
		}
		it.CreatedAt = createdAt.Time.UTC()
		// max() over no rows is NULL: nothing was ever recorded.  Valid is
		// the only thing separating that from the zero time, which would
		// serialise as year 1 and read as a visit in the distant past.
		it.LastSeenAt = timePtr(lastSeen)
		it.RecentActiveDates = []string{}
		items = append(items, it)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("users list rows: %w", err)
	}
	return items, nil
}

// attachUserBatches fills each item's strip and last device, in place, from
// one query each for the whole page.
func attachUserBatches(ctx context.Context, q userBatchQuerier, items []userItem, today time.Time) error {
	if len(items) == 0 {
		return nil
	}
	ids := make([]uuid.UUID, len(items))
	index := make(map[uuid.UUID]int, len(items))
	for i, it := range items {
		ids[i] = it.ID
		index[it.ID] = i
	}

	days, err := q.ListAdminUserRecentDays(ctx, ids, reportingDate(today))
	if err != nil {
		return fmt.Errorf("users recent days: %w", err)
	}
	for _, d := range days {
		if i, ok := index[d.UserID]; ok && d.ActivityDate.Valid {
			items[i].RecentActiveDates = append(items[i].RecentActiveDates, d.ActivityDate.Time.Format(userDayLayout))
		}
	}

	devices, err := q.ListAdminUserLastDevices(ctx, ids)
	if err != nil {
		return fmt.Errorf("users last devices: %w", err)
	}
	for _, d := range devices {
		if i, ok := index[d.UserID]; ok {
			dev := describeDevice(d.UserAgent)
			items[i].LastDevice = &userDevice{
				Kind:       dev.Kind,
				OS:         dev.OS,
				Browser:    dev.Browser,
				Country:    d.Country,
				LastUsedAt: d.LastUsedAt.Time.UTC(),
			}
		}
	}
	return nil
}

// describeDevice parses a stored User-Agent; a session that never stated
// one is an unknown device.
func describeDevice(userAgent *string) auth.Device {
	if userAgent == nil {
		return auth.ParseUserAgent("")
	}
	return auth.ParseUserAgent(*userAgent)
}

// timePtr is a nullable timestamp as a JSON-nullable instant, in UTC.
func timePtr(ts pgtype.Timestamptz) *time.Time {
	if !ts.Valid {
		return nil
	}
	t := ts.Time.UTC()
	return &t
}
