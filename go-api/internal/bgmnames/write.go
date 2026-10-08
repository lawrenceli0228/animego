package bgmnames

import (
	"context"
	"fmt"
	"slices"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// Change is what one import does to one map table.
type Change struct {
	Inserted, Updated, Deleted, Unchanged int
}

// Changes is an import's effect on both tables.
type Changes struct {
	People, Characters Change
}

// Reader is the statement set Preview runs.  *dbgen.Queries satisfies it.
type Reader interface {
	ListBgmPersonMap(ctx context.Context) ([]dbgen.ListBgmPersonMapRow, error)
	ListBgmCharacterMap(ctx context.Context) ([]dbgen.ListBgmCharacterMapRow, error)
}

// deleteBatch bounds the ids one DELETE carries.
const deleteBatch = 5000

// stored is a map row as the import compares it.
type stored struct {
	bgmID  int32
	nameCn string
}

// Preview returns what Apply would change, reading the tables and writing
// nothing: the dry run's numbers.
func Preview(ctx context.Context, r Reader, res Result) (Changes, error) {
	people, characters, err := readStored(ctx, r)
	if err != nil {
		return Changes{}, err
	}
	_, _, pc := plan(people, res.People)
	_, _, cc := plan(characters, res.Characters)
	return Changes{People: pc, Characters: cc}, nil
}

// Apply makes both tables hold exactly res's pairs, in one transaction:
// a pair already stored as it is (same Bangumi id, same name) is left
// alone, matched_at and source included, so a weekly run over an
// unchanged dump writes nothing; a changed pair is replaced; a new pair
// inserted; and a stored pair this run did not find -- a correction on
// Bangumi, a conflict, a binding that moved -- is deleted, because
// keeping a match the latest dump does not support is how a wrong name
// would outlive its fix.
//
// Not the TRUNCATE + COPY that seeds bgm_id_map: /api/anime/:id joins these
// tables on every request, and TRUNCATE's lock would hold those requests
// for the length of the import.  Row-level deletes and a COPY of only what
// changed leave readers seeing the old rows until the commit and the new
// ones after.
//
// Changed and vanished rows are deleted before anything is inserted, so a
// Bangumi id that moves between two AniList ids in one run never meets
// the unique index twice.
func Apply(ctx context.Context, pool *pgxpool.Pool, res Result, source string, at time.Time) (Changes, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return Changes{}, fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := dbgen.New(pool).WithTx(tx)

	if err := q.LockBgmNameMaps(ctx); err != nil {
		return Changes{}, fmt.Errorf("lock: %w", err)
	}
	people, characters, err := readStored(ctx, q)
	if err != nil {
		return Changes{}, err
	}
	stamp := pgtype.Timestamptz{Time: at, Valid: true}

	pc, err := replace(ctx, people, res.People, q.DeleteBgmPersonMap, q.InsertBgmPersonMap,
		func(p Pair) dbgen.InsertBgmPersonMapParams {
			return dbgen.InsertBgmPersonMapParams{AnilistID: p.AnilistID, BgmID: p.BgmID, NameCn: nullable(p.NameCn), Source: source, MatchedAt: stamp}
		})
	if err != nil {
		return Changes{}, fmt.Errorf("people: %w", err)
	}
	cc, err := replace(ctx, characters, res.Characters, q.DeleteBgmCharacterMap, q.InsertBgmCharacterMap,
		func(p Pair) dbgen.InsertBgmCharacterMapParams {
			return dbgen.InsertBgmCharacterMapParams{AnilistID: p.AnilistID, BgmID: p.BgmID, NameCn: nullable(p.NameCn), Source: source, MatchedAt: stamp}
		})
	if err != nil {
		return Changes{}, fmt.Errorf("characters: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return Changes{}, fmt.Errorf("commit: %w", err)
	}
	return Changes{People: pc, Characters: cc}, nil
}

// replace brings one table from existing to next: plan, then the deletes in
// batches of deleteBatch, then one COPY of the inserts.
func replace[R any](
	ctx context.Context,
	existing map[int32]stored,
	next []Pair,
	del func(context.Context, []int32) error,
	ins func(context.Context, []R) (int64, error),
	row func(Pair) R,
) (Change, error) {
	deletes, inserts, c := plan(existing, next)
	for start := 0; start < len(deletes); start += deleteBatch {
		if err := del(ctx, deletes[start:min(start+deleteBatch, len(deletes))]); err != nil {
			return Change{}, fmt.Errorf("delete: %w", err)
		}
	}
	if len(inserts) == 0 {
		return c, nil
	}
	rows := make([]R, 0, len(inserts))
	for _, p := range inserts {
		rows = append(rows, row(p))
	}
	if _, err := ins(ctx, rows); err != nil {
		return Change{}, fmt.Errorf("insert: %w", err)
	}
	return c, nil
}

// plan compares a run's pairs with what is stored.  It returns the
// AniList ids to delete (changed and vanished rows, ascending), the pairs
// to insert (changed and new), and the counts.  An empty Chinese name and
// a NULL one are the same.
func plan(existing map[int32]stored, next []Pair) (deletes []int32, inserts []Pair, c Change) {
	seen := make(map[int32]bool, len(next))
	for _, p := range next {
		seen[p.AnilistID] = true
		old, ok := existing[p.AnilistID]
		switch {
		case !ok:
			c.Inserted++
			inserts = append(inserts, p)
		case old.bgmID == p.BgmID && old.nameCn == p.NameCn:
			c.Unchanged++
		default:
			c.Updated++
			deletes = append(deletes, p.AnilistID)
			inserts = append(inserts, p)
		}
	}
	for id := range existing {
		if !seen[id] {
			c.Deleted++
			deletes = append(deletes, id)
		}
	}
	slices.Sort(deletes)
	return deletes, inserts, c
}

// readStored reads both tables into plan's form.
func readStored(ctx context.Context, r Reader) (people, characters map[int32]stored, err error) {
	personRows, err := r.ListBgmPersonMap(ctx)
	if err != nil {
		return nil, nil, fmt.Errorf("list people: %w", err)
	}
	people = make(map[int32]stored, len(personRows))
	for _, row := range personRows {
		people[row.AnilistID] = stored{bgmID: row.BgmID, nameCn: deref(row.NameCn)}
	}
	characterRows, err := r.ListBgmCharacterMap(ctx)
	if err != nil {
		return nil, nil, fmt.Errorf("list characters: %w", err)
	}
	characters = make(map[int32]stored, len(characterRows))
	for _, row := range characterRows {
		characters[row.AnilistID] = stored{bgmID: row.BgmID, nameCn: deref(row.NameCn)}
	}
	return people, characters, nil
}

// nullable stores "" as NULL.
func nullable(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// deref reads NULL as "".
func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
