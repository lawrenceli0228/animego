//go:build integration

// trailer_columns_test.go — migration 0032's trailer columns against a real
// Postgres.
//
// Three properties live in SQL and cannot be shown from a unit test, because
// each is a property of the statement rather than of the Go around it:
//
//	CASE WHEN EXCLUDED.trailer_checked_at IS NOT NULL   a caller whose query
//	                                                    did not select trailer
//	                                                    must not clear a stored
//	                                                    one
//	trailer_checked_at = now() on a selecting upsert    "asked, none" has to
//	                                                    outlive the answer, or
//	                                                    isStale re-fetches the
//	                                                    row forever
//	CHECK anime_trailer_pair                            the column, not the
//	                                                    caller, is what refuses
//	                                                    a malformed id
//
// The last subtest is the one that earns its keep: the 11-character YouTube
// id rule is written down THREE times — the Go regexp in internal/anime, this
// CHECK, and the consumer's own guard — and nothing links them.  It drives the
// Go validator's whole accept/reject table through the real constraint, so a
// future edit to either side that pulls them apart fails here rather than in
// production.  Drift is not hypothetical harm: warm_season logs and skips a
// per-row upsert error, so rows whose values the constraint started refusing
// would silently stop refreshing.
//
// Hermeticity: everything runs in one transaction rolled back in t.Cleanup.
// now() inside that transaction is the transaction's start time, so the
// "checked_at was not bumped" assertions compare against an explicitly seeded
// sentinel rather than against a clock reading.
//
// Run with:
//
//	go test -race -tags=integration -timeout=300s ./test/integration/...
package integration

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/anilist"
	"github.com/lawrenceli0228/animego/go-api/internal/anime"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// Fixture ids held far above anything the catalogue contains.
const (
	trailerRoundTrip = int32(9960001)
	trailerAgreement = int32(9960002)
)

// trailerSeededAt is a timestamp no writer would produce, so a column still
// wearing it was not written to.
var trailerSeededAt = time.Date(2001, 2, 3, 4, 5, 6, 0, time.UTC)

func tptr(s string) *string { return &s }

func TestTrailerColumns(t *testing.T) {
	ctx := context.Background()
	pool := newPGPool(t, ctx)

	tx, err := pool.Begin(ctx)
	require.NoError(t, err, "begin fixture transaction")
	t.Cleanup(func() { _ = tx.Rollback(context.Background()) })

	var held int
	require.NoError(t, tx.QueryRow(ctx, `
		SELECT count(*) FROM anime_cache WHERE anilist_id BETWEEN 9960000 AND 9969999`).Scan(&held))
	require.Zero(t, held, "fixture id range must be unheld before seeding")

	q := dbgen.New(tx)

	type stored struct {
		id        *string
		site      *string
		checkedAt *time.Time
	}
	read := func(anilistID int32) stored {
		t.Helper()
		var s stored
		require.NoError(t, tx.QueryRow(ctx, `
			SELECT trailer_id, trailer_site, trailer_checked_at
			FROM anime_cache WHERE anilist_id = $1`, anilistID).
			Scan(&s.id, &s.site, &s.checkedAt))
		return s
	}

	withTrailer := anilist.Media{
		ID:      int(trailerRoundTrip),
		Trailer: &anilist.Trailer{ID: tptr("abcdefghijk"), Site: tptr("youtube")},
	}

	t.Run("a selecting query stores the pair and stamps when it asked", func(t *testing.T) {
		require.NoError(t, q.UpsertAnimeCache(ctx, anime.NormalizeMainRow(withTrailer, anilist.TrailerSelected)))

		got := read(trailerRoundTrip)
		require.NotNil(t, got.id)
		assert.Equal(t, "abcdefghijk", *got.id)
		assert.Equal(t, "youtube", *got.site)
		require.NotNil(t, got.checkedAt, "a selecting upsert must record that it asked")
	})

	t.Run("a query that did not select trailer leaves all three columns alone", func(t *testing.T) {
		// Seed a sentinel so "unchanged" is provable inside a transaction,
		// where now() would be indistinguishable from the previous write.
		_, err := tx.Exec(ctx, `
			UPDATE anime_cache SET trailer_checked_at = $2 WHERE anilist_id = $1`,
			trailerRoundTrip, trailerSeededAt)
		require.NoError(t, err)

		// Search's shape: no trailer in the payload, and none asked for.
		omitted := anime.NormalizeMainRow(anilist.Media{ID: int(trailerRoundTrip)}, anilist.TrailerNotSelected)
		require.NoError(t, q.UpsertAnimeCache(ctx, omitted))

		got := read(trailerRoundTrip)
		require.NotNil(t, got.id, "a listing that never asked must not clear a stored trailer")
		assert.Equal(t, "abcdefghijk", *got.id)
		require.NotNil(t, got.checkedAt)
		assert.True(t, got.checkedAt.Equal(trailerSeededAt),
			"and must not restamp when it was asked either")
	})

	t.Run("a selecting query with no trailer clears the pair and keeps the stamp", func(t *testing.T) {
		checked := anime.NormalizeMainRow(anilist.Media{ID: int(trailerRoundTrip)}, anilist.TrailerSelected)
		require.NoError(t, q.UpsertAnimeCache(ctx, checked))

		got := read(trailerRoundTrip)
		assert.Nil(t, got.id, "AniList's null is an answer once we asked for the field")
		assert.Nil(t, got.site)
		require.NotNil(t, got.checkedAt, "the stamp never goes back to NULL")
		assert.False(t, got.checkedAt.Equal(trailerSeededAt), "and it moves forward on a fresh check")
	})

	t.Run("the row read by the detail path carries the stamp", func(t *testing.T) {
		row, err := q.GetAnimeMainByID(ctx, trailerRoundTrip)
		require.NoError(t, err)
		assert.True(t, row.TrailerCheckedAt.Valid,
			"isStale reads this; an unset stamp would re-fetch the row on every view")
	})

	// ---------------------------------------------------------------------
	// The constraint, and its agreement with the Go validator.
	// ---------------------------------------------------------------------

	t.Run("the constraint refuses what the caller must never write", func(t *testing.T) {
		for _, tc := range []struct {
			name      string
			id, site  any
			checkedAt any
		}{
			{"id without site", "abcdefghijk", nil, trailerSeededAt},
			{"site without id", nil, "youtube", trailerSeededAt},
			{"an unsupported site", "abcdefghijk", "dailymotion", trailerSeededAt},
			{"an embed url smuggled into id", "https://youtu.be/x", "youtube", trailerSeededAt},
			{"an id of the wrong length", "short", "youtube", trailerSeededAt},
			{"metadata on a row nobody asked about", "abcdefghijk", "youtube", nil},
		} {
			t.Run(tc.name, func(t *testing.T) {
				sub, err := tx.Begin(ctx)
				require.NoError(t, err)
				defer func() { _ = sub.Rollback(context.Background()) }()

				_, err = sub.Exec(ctx, `
					UPDATE anime_cache
					SET trailer_id = $2, trailer_site = $3, trailer_checked_at = $4
					WHERE anilist_id = $1`, trailerRoundTrip, tc.id, tc.site, tc.checkedAt)
				require.Error(t, err, "the column, not the caller, refuses this")
			})
		}
	})

	// Every shape the Go validator accepts must be storable, and every shape
	// it rejects must be stored as the empty pair rather than smuggled past.
	// A single UPSERT failure here is what warm_season would swallow.
	t.Run("the Go validator and the constraint agree on every shape", func(t *testing.T) {
		for _, tc := range []struct {
			name     string
			trailer  *anilist.Trailer
			wantKept bool
		}{
			{"youtube lowercase", &anilist.Trailer{ID: tptr("abcdefghijk"), Site: tptr("youtube")}, true},
			{"youtube mixed case", &anilist.Trailer{ID: tptr("abcdefghijk"), Site: tptr("YouTube")}, true},
			{"id using the full charset", &anilist.Trailer{ID: tptr("a-b_c1D2e3F"), Site: tptr("youtube")}, true},
			{"unsupported site", &anilist.Trailer{ID: tptr("abcdefghijk"), Site: tptr("dailymotion")}, false},
			{"url smuggled into id", &anilist.Trailer{ID: tptr("https://evil"), Site: tptr("youtube")}, false},
			{"id too short", &anilist.Trailer{ID: tptr("short"), Site: tptr("youtube")}, false},
			{"id too long", &anilist.Trailer{ID: tptr("abcdefghijkl"), Site: tptr("youtube")}, false},
			{"null id beside a site", &anilist.Trailer{Site: tptr("youtube")}, false},
			{"null site beside an id", &anilist.Trailer{ID: tptr("abcdefghijk")}, false},
			{"no trailer object", nil, false},
		} {
			t.Run(tc.name, func(t *testing.T) {
				sub, err := tx.Begin(ctx)
				require.NoError(t, err)
				defer func() { _ = sub.Rollback(context.Background()) }()

				params := anime.NormalizeMainRow(
					anilist.Media{ID: int(trailerAgreement), Trailer: tc.trailer},
					anilist.TrailerSelected,
				)
				require.NoError(t, dbgen.New(sub).UpsertAnimeCache(ctx, params),
					"normalizer output must always satisfy the constraint")

				var id *string
				require.NoError(t, sub.QueryRow(ctx, `
					SELECT trailer_id FROM anime_cache WHERE anilist_id = $1`, trailerAgreement).Scan(&id))
				if tc.wantKept {
					require.NotNil(t, id)
				} else {
					require.Nil(t, id)
				}
			})
		}
	})
}
