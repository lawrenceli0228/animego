package admin

// list_users.go — SQL building + execution for /api/admin/users.
//
// Simpler than list_enrichment.go: only one optional q filter, fixed
// ORDER BY created_at DESC.  Kept in its own file for symmetry and
// to keep the SQL composition unit-testable in isolation.

import (
	"bytes"
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/sync/errgroup"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// usersListParams carries the parsed query-string inputs of
// ListUsers.  Same shape as enrichmentListParams but with fewer
// knobs — users has no sort/filter UI in Express.
type usersListParams struct {
	Page  int
	Query string
}

// buildUsersListSQL composes the page-fetch SQL + parameter slice
// for the given inputs.  Returns the SQL text, the param slice, and
// the matching COUNT(*) SQL.
//
// Projection: id, username, email, role, created_at — matches the
// Express .select() projection 'username email role createdAt' plus
// the implicit _id (which lean() includes by default).
//
// Order: created_at DESC (fixed — no public sort param).
func buildUsersListSQL(p usersListParams) (listSQL string, countSQL string, args []any) {
	const projection = `id, username, email, role, created_at`
	const tableName = `users`

	args = make([]any, 0, 1)
	var where bytes.Buffer
	nextParam := 1
	addParam := func(v any) string {
		args = append(args, v)
		idx := nextParam
		nextParam++
		return "$" + strconv.Itoa(idx)
	}

	if q := strings.TrimSpace(p.Query); q != "" {
		pattern := "%" + escapeLikePattern(q) + "%"
		placeholder := addParam(pattern)
		where.WriteString(" WHERE username ILIKE ")
		where.WriteString(placeholder)
		where.WriteString(" OR email ILIKE ")
		where.WriteString(placeholder)
	}

	skip := (p.Page - 1) * pageSize
	listSQL = fmt.Sprintf(
		"SELECT %s FROM %s%s ORDER BY created_at DESC LIMIT %d OFFSET %d",
		projection, tableName, where.String(), pageSize, skip,
	)
	countSQL = "SELECT count(*)::bigint FROM " + tableName + where.String()
	return listSQL, countSQL, args
}

// runUsersList executes the page-fetch + COUNT, then enriches each
// returned row with subscription + follower counts via
// dbgen.GetAdminUserSubFollowCounts (a single round-trip for the
// whole page).  Returns the materialised slice + total.
func runUsersList(ctx context.Context, pool *pgxpool.Pool, q adminQuerier, p usersListParams) ([]userItem, int64, error) {
	listSQL, countSQL, args := buildUsersListSQL(p)

	type basicUser struct {
		ID        uuid.UUID
		Username  string
		Email     string
		Role      *string
		CreatedAt pgtype.Timestamptz
	}

	var (
		rowsOut []basicUser
		total   int64
	)
	g, gctx := errgroup.WithContext(ctx)
	g.Go(func() error {
		rows, err := pool.Query(gctx, listSQL, args...)
		if err != nil {
			return fmt.Errorf("users list query: %w", err)
		}
		defer rows.Close()
		for rows.Next() {
			var u basicUser
			if err := rows.Scan(
				&u.ID,
				&u.Username,
				&u.Email,
				&u.Role,
				&u.CreatedAt,
			); err != nil {
				return fmt.Errorf("users list scan: %w", err)
			}
			rowsOut = append(rowsOut, u)
		}
		return rows.Err()
	})
	g.Go(func() error {
		if err := pool.QueryRow(gctx, countSQL, args...).Scan(&total); err != nil {
			return fmt.Errorf("users list count: %w", err)
		}
		return nil
	})
	if err := g.Wait(); err != nil {
		return nil, 0, err
	}

	if len(rowsOut) == 0 {
		return []userItem{}, total, nil
	}

	ids := make([]uuid.UUID, len(rowsOut))
	for i, r := range rowsOut {
		ids[i] = r.ID
	}

	counts, err := q.GetAdminUserSubFollowCounts(ctx, ids)
	if err != nil {
		return nil, 0, fmt.Errorf("users sub/follow counts: %w", err)
	}

	type countPair struct {
		Subscriptions int64
		Followers     int64
	}
	byID := make(map[uuid.UUID]countPair, len(counts))
	for _, c := range counts {
		// sqlc generates UserID as interface{} because the SQL uses
		// unnest($1::uuid[]).  At runtime PG returns it as
		// [16]byte — which uuid.UUID is already aliased to.  Convert
		// defensively via the standard pgx parser path.
		id, ok := asUUID(c.UserID)
		if !ok {
			continue
		}
		byID[id] = countPair{Subscriptions: c.Subscriptions, Followers: c.Followers}
	}

	out := make([]userItem, 0, len(rowsOut))
	for _, r := range rowsOut {
		cp := byID[r.ID]
		out = append(out, userItem{
			ID:            r.ID,
			Username:      r.Username,
			Email:         r.Email,
			Role:          r.Role,
			CreatedAt:     r.CreatedAt.Time,
			Subscriptions: cp.Subscriptions,
			Followers:     cp.Followers,
		})
	}

	return out, total, nil
}

// asUUID coerces an interface{} from sqlc's GetAdminUserSubFollowCounts
// into a uuid.UUID.  pgx parses Postgres uuid into a [16]byte; sqlc's
// generated type is interface{} because the underlying query uses
// unnest($1::uuid[]).  Both the [16]byte path and a direct uuid.UUID
// path are handled.
//
// Returns (zero, false) on any unexpected shape so callers can skip
// the row rather than panic.
func asUUID(v any) (uuid.UUID, bool) {
	switch x := v.(type) {
	case uuid.UUID:
		return x, true
	case [16]byte:
		return uuid.UUID(x), true
	case []byte:
		// Some pgx versions return uuid as text; try parse.
		if id, err := uuid.Parse(string(x)); err == nil {
			return id, true
		}
	case string:
		if id, err := uuid.Parse(x); err == nil {
			return id, true
		}
	}
	return uuid.UUID{}, false
}

// _ silences "imported and not used" for dbgen — keeping the import
// because GetAdminUserSubFollowCounts lives in dbgen and the type is
// referenced via the adminQuerier interface in handlers.go.
var _ = dbgen.GetAdminUserSubFollowCountsRow{}
