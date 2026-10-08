package queue

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/anilist"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/profiles"
	"github.com/lawrenceli0228/animego/go-api/internal/testutil"
)

// TestProfiles_PG runs the sweep's statements on a real Postgres: which
// ids a pass is offered and in what order, a whole pass through the
// production store, and a save being one transaction.
func TestProfiles_PG(t *testing.T) {
	ctx := context.Background()
	uri := testutil.SetupPG(t)
	pool := testutil.NewWebPool(t, ctx, uri)
	q := dbgen.New(pool)
	stale := pgtype.Interval{Microseconds: int64(profilesStaleAfter / time.Microsecond), Valid: true}

	exec := func(sql string, args ...any) {
		t.Helper()
		_, err := pool.Exec(ctx, sql, args...)
		require.NoError(t, err, sql)
	}
	count := func(sql string, args ...any) int {
		t.Helper()
		var n int
		require.NoError(t, pool.QueryRow(ctx, sql, args...).Scan(&n), sql)
		return n
	}

	// Three titles: popular, less so, and one with no popularity figure.
	exec(`INSERT INTO anime_cache (anilist_id, title_romaji, popularity) VALUES
		(1, 'less popular', 100), (2, 'popular', 900), (3, 'no figure', NULL)`)

	t.Run("people: never asked by popularity, then due by stamp, from all three credit sources", func(t *testing.T) {
		exec(`INSERT INTO anime_staff (anime_id, display_order, staff_id, role) VALUES
			(2, 0, 11, 'Music'),
			(1, 0, 10, 'Director'),
			(1, 1, 14, 'Script'), (1, 2, 14, 'Storyboard'),
			(3, 0, 12, 'Key Animation'),
			(3, 1, 17, 'Key Animation'), (2, 1, 17, 'Key Animation'),
			(2, 2, 20, 'Producer'),
			(1, 3, 21, 'Producer'),
			(3, 2, 25, 'Producer')`)
		// 15 is only ever a character's primary voice; 16 and 22 only ever
		// appear in the voices table.
		exec(`INSERT INTO anime_characters (anime_id, display_order, character_id, voice_actor_id) VALUES
			(2, 0, 500, 15), (1, 0, 501, NULL), (3, 0, 502, NULL)`)
		exec(`INSERT INTO anime_character_voices (anime_id, character_id, staff_id, display_order) VALUES
			(1, 501, 16, 0), (3, 502, 22, 0)`)
		// 20: asked yesterday, not due.  21, 22: due, 22 the older.  23:
		// due but no credit names it any more.  25: a stamp-only row (absent
		// upstream), due.
		exec(`INSERT INTO people (anilist_id, checked_at, fetched_at, absent_since) VALUES
			(20, now() - interval '1 day',   now() - interval '1 day',   NULL),
			(21, now() - interval '100 days', now() - interval '100 days', NULL),
			(22, now() - interval '200 days', now() - interval '200 days', NULL),
			(23, now() - interval '300 days', now() - interval '300 days', NULL),
			(25, now() - interval '95 days',  NULL,                       now() - interval '95 days')`)

		ids, err := q.ListPeopleCandidates(ctx, 20, stale)
		require.NoError(t, err)
		assert.Equal(t, []int32{
			17, 11, 15, // credited on the popular title; 17 twice (its other title has no figure: the highest counts)
			14, 10, 16, // the less popular title; 14 twice
			12,         // no popularity figure: last of the never-asked
			22, 21, 25, // then the due, oldest stamp first
		}, ids)

		ids, err = q.ListPeopleCandidates(ctx, 4, stale)
		require.NoError(t, err)
		assert.Equal(t, []int32{17, 11, 15, 14}, ids, "the pass cap is honoured")
	})

	t.Run("characters: the same two tiers", func(t *testing.T) {
		exec(`INSERT INTO anime_characters (anime_id, display_order, character_id) VALUES
			(1, 1, 603), (2, 1, 603), (1, 2, 604), (2, 2, 605)`)
		exec(`INSERT INTO characters (anilist_id, checked_at, fetched_at) VALUES
			(604, now() - interval '1 day',   now() - interval '1 day'),
			(605, now() - interval '100 days', now() - interval '100 days'),
			(606, now() - interval '200 days', now() - interval '200 days')`)

		ids, err := q.ListCharacterCandidates(ctx, 20, stale)
		require.NoError(t, err)
		assert.Equal(t, []int32{603, 500, 501, 502, 605}, ids,
			"603 is on the popular title twice; 604 is fresh; 606 is due but no title lists it")
	})

	t.Run("a pass through the production store writes, stamps, and leaves nothing due", func(t *testing.T) {
		exec(`TRUNCATE anime_cache, people, characters CASCADE`)
		exec(`INSERT INTO anime_cache (anilist_id, title_romaji, popularity) VALUES (154587, 'Frieren', 1)`)
		exec(`INSERT INTO anime_staff (anime_id, display_order, staff_id, role)
			SELECT 154587, g, 1000 + g, 'Key Animation' FROM generate_series(0, 59) g`)
		exec(`INSERT INTO anime_characters (anime_id, display_order, character_id, voice_actor_id)
			SELECT 154587, g, 5000 + g, 2000 + g FROM generate_series(0, 4) g`)

		al := &fakeProfilesAniList{missing: map[int]bool{1003: true, 5004: true}}
		w := NewProfilesWorker(al, pgProfilesStore{Queries: q, pool: pool})
		w.enabled = func() bool { return true }
		w.sleep = func(context.Context, time.Duration) error { return nil }
		require.NoError(t, w.Work(ctx, profilesJob()))

		assert.Len(t, al.calls, 3, "65 people in two requests, 5 characters in one")
		assert.Equal(t, 64, count(`SELECT count(*) FROM people WHERE fetched_at IS NOT NULL AND name_full LIKE 'person %'`))
		assert.Equal(t, 1, count(`SELECT count(*) FROM people
			WHERE anilist_id = 1003 AND fetched_at IS NULL AND absent_since IS NOT NULL`))
		assert.Equal(t, 4, count(`SELECT count(*) FROM characters WHERE fetched_at IS NOT NULL`))
		assert.Equal(t, 1, count(`SELECT count(*) FROM characters WHERE anilist_id = 5004 AND absent_since IS NOT NULL`))

		ids, err := q.ListPeopleCandidates(ctx, 200, stale)
		require.NoError(t, err)
		assert.Empty(t, ids, "asked about, absent included: nothing is due for the re-check interval")
		ids, err = q.ListCharacterCandidates(ctx, 200, stale)
		require.NoError(t, err)
		assert.Empty(t, ids)

		al.calls = nil
		require.NoError(t, w.Work(ctx, profilesJob()))
		assert.Empty(t, al.calls, "a second pass finds nothing to ask")
	})

	t.Run("a failed batch is due again after the retry delay", func(t *testing.T) {
		exec(`INSERT INTO anime_staff (anime_id, display_order, staff_id, role) VALUES (154587, 100, 3000, 'Music')`)
		store := pgProfilesStore{Queries: q, pool: pool}
		backDated := time.Now().Add(profilesRetryAfterFailure - profilesStaleAfter)
		require.NoError(t, store.StampPeopleChecked(ctx, pgtype.Timestamptz{Time: backDated, Valid: true}, false, []int32{3000}))

		ids, err := q.ListPeopleCandidates(ctx, 200, stale)
		require.NoError(t, err)
		assert.Empty(t, ids, "not before the delay")

		exec(`UPDATE people SET checked_at = checked_at - $1::interval WHERE anilist_id = 3000`,
			pgtype.Interval{Microseconds: int64((profilesRetryAfterFailure + time.Minute) / time.Microsecond), Valid: true})
		ids, err = q.ListPeopleCandidates(ctx, 200, stale)
		require.NoError(t, err)
		assert.Equal(t, []int32{3000}, ids)
	})

	t.Run("a save is one transaction", func(t *testing.T) {
		store := pgProfilesStore{Queries: q, pool: pool}
		at := time.Now()
		name := "Good"
		good := profiles.PersonRow(anilist.StaffProfile{ID: 4001, Name: &anilist.StaffName{Full: &name}}, at)
		bad := profiles.PersonRow(anilist.StaffProfile{ID: 4002}, at)
		month := int32(13)
		bad.BirthMonth = &month // the CHECK refuses it; the normaliser never produces it

		require.Error(t, store.SavePeople(ctx, []dbgen.UpsertPersonParams{good, bad}, []int32{4003}, at))
		assert.Zero(t, count(`SELECT count(*) FROM people WHERE anilist_id IN (4001, 4002, 4003)`),
			"neither the row before the failure nor the batch's absent stamp")
	})
}
