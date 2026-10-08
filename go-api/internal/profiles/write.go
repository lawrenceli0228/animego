package profiles

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// PeopleWriter is the statement set WritePeople runs.  *dbgen.Queries
// satisfies it; the profiles sweep binds it to one transaction per batch.
type PeopleWriter interface {
	UpsertPerson(ctx context.Context, arg dbgen.UpsertPersonParams) error
	StampPeopleChecked(ctx context.Context, checkedAt pgtype.Timestamptz, absent bool, ids []int32) error
}

// CharactersWriter is PeopleWriter for characters.
type CharactersWriter interface {
	UpsertCharacter(ctx context.Context, arg dbgen.UpsertCharacterParams) error
	StampCharactersChecked(ctx context.Context, checkedAt pgtype.Timestamptz, absent bool, ids []int32) error
}

// WritePeople stores one batch's answer: the profiles AniList returned,
// then an absent stamp at `at` for the ids it was asked about and did not
// return.  It stops at the first failure and is not transactional by
// itself -- the sweep runs it inside one transaction, so a batch is
// written whole or not at all.
//
// A statement per profile, not the one jsonb statement per list the
// credit writes use (credits.WriteCast).  That shape exists for the five
// seconds a cold detail request has; this runs in the background, where
// fifty statements in one transaction cost nothing that matters, and
// typed parameters cannot drift from the column list the way a jsonb key
// can -- jsonb_to_recordset answers a misspelt key with NULL and no error.
func WritePeople(ctx context.Context, w PeopleWriter, rows []dbgen.UpsertPersonParams, absent []int32, at time.Time) error {
	for _, r := range rows {
		if err := w.UpsertPerson(ctx, r); err != nil {
			return fmt.Errorf("upsert person %d: %w", r.AnilistID, err)
		}
	}
	if len(absent) == 0 {
		return nil
	}
	if err := w.StampPeopleChecked(ctx, pgtype.Timestamptz{Time: at, Valid: true}, true, absent); err != nil {
		return fmt.Errorf("stamp %d absent people: %w", len(absent), err)
	}
	return nil
}

// WriteCharacters is WritePeople for characters.
func WriteCharacters(ctx context.Context, w CharactersWriter, rows []dbgen.UpsertCharacterParams, absent []int32, at time.Time) error {
	for _, r := range rows {
		if err := w.UpsertCharacter(ctx, r); err != nil {
			return fmt.Errorf("upsert character %d: %w", r.AnilistID, err)
		}
	}
	if len(absent) == 0 {
		return nil
	}
	if err := w.StampCharactersChecked(ctx, pgtype.Timestamptz{Time: at, Valid: true}, true, absent); err != nil {
		return fmt.Errorf("stamp %d absent characters: %w", len(absent), err)
	}
	return nil
}
