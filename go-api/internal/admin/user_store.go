package admin

// user_store.go — the production UserDB.
//
// Every user-CRUD query is a single sqlc statement and goes straight to the
// embedded dbgen.Queries.  Deleting an account is the exception: it has to
// archive the account's activity history and remove the account atomically,
// which takes a transaction, so it is the one method written out here.

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// UserStore satisfies UserDB against a live pool.
type UserStore struct {
	*dbgen.Queries
	pool *pgxpool.Pool
}

// NewUserStore wraps pool.  A nil pool panics at boot, like the handler
// constructors, rather than on the first delete.
func NewUserStore(pool *pgxpool.Pool) *UserStore {
	if pool == nil {
		panic("admin.NewUserStore: nil pool")
	}
	return &UserStore{Queries: dbgen.New(pool), pool: pool}
}

// ArchiveAndDeleteUser deletes the account and, in the same transaction,
// moves what the activity statistics are built from -- its signup instant
// and every recorded day -- into the anonymous archive (migration 0054).
// Without the archive, the cascade from users would subtract the person from
// every past day they were counted in.
//
// Reports false, with nothing written, when the account no longer exists.
//
// The order is the point; see activity_archive.sql.  The account's activity
// rows are locked before its users row, the order the activity recorder's
// flush takes them in, so a flush running at the same moment is waited for
// instead of deadlocked with or overwritten.  READ COMMITTED is load-bearing
// and so is stated rather than inherited: every statement takes a fresh
// snapshot, which is how the move sees a row a flush committed while the
// locks were being waited for.  Under REPEATABLE READ that row would be
// invisible to the move and the cascade would delete it unarchived.
//
// Activity still buffered in the recorder is not in the database yet and so
// not here; DeleteUser flushes the recorder before calling this.
func (s *UserStore) ArchiveAndDeleteUser(ctx context.Context, id uuid.UUID) (bool, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return false, fmt.Errorf("admin: begin archive-and-delete: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	q := dbgen.New(tx)
	if err := q.LockUserActivityForArchive(ctx, id); err != nil {
		return false, fmt.Errorf("admin: lock activity for archive: %w", err)
	}
	createdAt, err := q.LockUserForArchive(ctx, id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false, nil
		}
		return false, fmt.Errorf("admin: lock user for archive: %w", err)
	}
	archiveID, err := q.InsertArchivedUser(ctx, createdAt)
	if err != nil {
		return false, fmt.Errorf("admin: archive signup: %w", err)
	}
	if _, err := q.MoveUserActivityToArchive(ctx, archiveID, id); err != nil {
		return false, fmt.Errorf("admin: archive activity: %w", err)
	}
	if err := q.AdminDeleteUser(ctx, id); err != nil {
		return false, fmt.Errorf("admin: delete user: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("admin: commit archive-and-delete: %w", err)
	}
	return true, nil
}
