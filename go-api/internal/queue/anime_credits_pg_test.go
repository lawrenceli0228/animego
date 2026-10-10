package queue

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/anilist"
	"github.com/lawrenceli0228/animego/go-api/internal/credits"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/testutil"
)

// TestAnimeCredits_PG runs the sweep's statements on a real Postgres:
// which titles a pass is offered and in what order, a whole pass through
// the production store, and the replace being one transaction.
func TestAnimeCredits_PG(t *testing.T) {
	ctx := context.Background()
	uri := testutil.SetupPG(t)
	pool := testutil.NewWebPool(t, ctx, uri)
	q := dbgen.New(pool)
	stale := pgtype.Interval{Microseconds: int64(creditsStaleAfter / time.Microsecond), Valid: true}

	exec := func(sql string, args ...any) {
		t.Helper()
		_, err := pool.Exec(ctx, sql, args...)
		require.NoError(t, err, sql)
	}

	t.Run("candidates: flagged or full-page titles, never-swept first, most popular first", func(t *testing.T) {
		exec(`INSERT INTO anime_cache (anilist_id, title_romaji, popularity, cast_has_more, cast_checked_at, staff_has_more) VALUES
			(10, 'flagged',             100,  true,  NULL,                        NULL),
			(20, 'flagged, popular',    500,  true,  NULL,                        NULL),
			(30, 'unread, full page',   50,   NULL,  NULL,                        NULL),
			(40, 'unread, short',       5000, NULL,  NULL,                        NULL),
			(50, 'complete',            9000, false, NULL,                        false),
			(60, 'swept, lapsed',       1000, true,  now() - interval '40 days',  NULL),
			(70, 'swept, fresh',        1000, true,  now() - interval '1 day',    NULL),
			(80, 'flagged, no figure',  NULL, true,  NULL,                        NULL)`)
		exec(`INSERT INTO anime_characters (anime_id, display_order, character_id)
			SELECT 30, g, 100 + g FROM generate_series(0, 24) g`)
		exec(`INSERT INTO anime_characters (anime_id, display_order, character_id)
			SELECT 40, g, 100 + g FROM generate_series(0, 23) g`)
		exec(`INSERT INTO anime_staff (anime_id, display_order, staff_id, role)
			SELECT 40, g, 100 + g, 'Key Animation' FROM generate_series(0, 24) g`)

		ids, err := q.ListAnimeCastCandidates(ctx, stale, anilist.CreditsPerPage, 10)
		require.NoError(t, err)
		assert.Equal(t, []int32{20, 10, 30, 80, 60}, ids)

		ids, err = q.ListAnimeCastCandidates(ctx, stale, anilist.CreditsPerPage, 2)
		require.NoError(t, err)
		assert.Equal(t, []int32{20, 10}, ids, "the pass cap is honoured")

		// Staff is its own list with its own flag: 40 has a full first
		// page of staff and no flag yet; 50 said there is no more.
		ids, err = q.ListAnimeStaffCandidates(ctx, stale, anilist.CreditsPerPage, 10)
		require.NoError(t, err)
		assert.Equal(t, []int32{40}, ids)
	})

	t.Run("a pass through the production store writes the whole lists and stamps them", func(t *testing.T) {
		exec(`TRUNCATE anime_cache CASCADE`)
		exec(`INSERT INTO anime_cache (anilist_id, title_romaji, popularity, cast_has_more, staff_has_more)
			VALUES (154587, 'Frieren', 1, true, true)`)
		// Page 1 as the detail refresh left it: 25 rows and their voices.
		al := &fakeCreditsAniList{castLen: map[int]int{154587: 100}, staffLen: map[int]int{154587: 205}}
		first, err := al.CharacterPagesNoWait(ctx, anilist.CreditPagesVars{ID: 154587, FirstPage: 1, LastPage: 1})
		require.NoError(t, err)
		require.NoError(t, credits.WriteCast(ctx, q, 154587, credits.CastFromEdges(first.Pages[0].Edges), credits.FirstPage))

		w := NewAnimeCreditsWorker(al, pgCreditsStore{Queries: q, pool: pool})
		w.enabled = func() bool { return true }
		w.sleep = func(context.Context, time.Duration) error { return nil }
		require.NoError(t, w.Work(ctx, creditsJob()))

		count := func(sql string) int {
			var n int
			require.NoError(t, pool.QueryRow(ctx, sql).Scan(&n), sql)
			return n
		}
		assert.Equal(t, 100, count(`SELECT count(*) FROM anime_characters WHERE anime_id = 154587`))
		assert.Equal(t, 100, count(`SELECT count(*) FROM anime_character_voices WHERE anime_id = 154587`))
		assert.Equal(t, 205, count(`SELECT count(*) FROM anime_staff WHERE anime_id = 154587`))
		assert.Equal(t, 99, count(`SELECT max(display_order) FROM anime_characters WHERE anime_id = 154587`))
		assert.Equal(t, 1, count(`SELECT count(*) FROM anime_cache WHERE anilist_id = 154587
			AND cast_has_more AND staff_has_more
			AND cast_checked_at > now() - interval '1 minute' AND staff_checked_at > now() - interval '1 minute'`))

		ids, err := q.ListAnimeCastCandidates(ctx, stale, anilist.CreditsPerPage, 10)
		require.NoError(t, err)
		assert.Empty(t, ids, "a swept title is not due again for 30 days")

		read, err := q.GetAnimeCharactersByID(ctx, 154587)
		require.NoError(t, err)
		assert.Len(t, read, 25, "the API still answers with the first page")
	})

	t.Run("a replace is one transaction: a failure leaves rows and stamp as they were", func(t *testing.T) {
		before := func() (rows int, stamped bool) {
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM anime_characters WHERE anime_id = 154587`).Scan(&rows))
			var at *time.Time
			require.NoError(t, pool.QueryRow(ctx, `SELECT cast_checked_at FROM anime_cache WHERE anilist_id = 154587`).Scan(&at))
			return rows, at != nil
		}
		exec(`UPDATE anime_cache SET cast_checked_at = NULL WHERE anilist_id = 154587`)
		rows, stamped := before()
		require.Equal(t, 100, rows)
		require.False(t, stamped)

		id := int32(1)
		bad := credits.Cast{
			Characters: []credits.Character{{DisplayOrder: 0, CharacterID: &id}},
			Voices:     []credits.Voice{{CharacterID: 1, StaffID: 0}}, // refused by the CHECK, after the prune ran
		}
		store := pgCreditsStore{Queries: q, pool: pool}
		require.Error(t, store.ReplaceCast(ctx, 154587, bad, false, time.Now()))

		rows, stamped = before()
		assert.Equal(t, 100, rows, "the prune that ran before the failure was rolled back")
		assert.False(t, stamped, "no stamp for a write that did not happen")
	})

	t.Run("a has_more flag turning true puts a swept title back in the list", func(t *testing.T) {
		exec(`TRUNCATE anime_cache CASCADE`)
		exec(`INSERT INTO anime_cache (anilist_id, title_romaji, cast_has_more, cast_checked_at, staff_has_more, staff_checked_at) VALUES
			(900, 'swept short, now growing', false, now(), false, now()),
			(901, 'swept long, still long',   true,  now(), NULL,  NULL),
			(902, 'nothing said',             false, now(), false, now())`)
		yes := true

		require.NoError(t, q.SetAnimeCreditsHasMore(ctx, &yes, nil, 900))
		require.NoError(t, q.SetAnimeCreditsHasMore(ctx, &yes, nil, 901))
		require.NoError(t, q.SetAnimeCreditsHasMore(ctx, nil, nil, 902))

		ids, err := q.ListAnimeCastCandidates(ctx, stale, anilist.CreditsPerPage, 10)
		require.NoError(t, err)
		assert.Equal(t, []int32{900}, ids,
			"900's stamp was for a one-page list and is void; 901's flag was already true, so its 30-day stamp stands")

		var staffStamped bool
		require.NoError(t, pool.QueryRow(ctx,
			`SELECT staff_checked_at IS NOT NULL FROM anime_cache WHERE anilist_id = 900`).Scan(&staffStamped))
		assert.True(t, staffStamped, "the staff stamp is the staff flag's business")

		require.NoError(t, q.SetAnimeCreditsHasMore(ctx, nil, &yes, 900))
		ids, err = q.ListAnimeStaffCandidates(ctx, stale, anilist.CreditsPerPage, 10)
		require.NoError(t, err)
		assert.Equal(t, []int32{900}, ids)
	})
}
