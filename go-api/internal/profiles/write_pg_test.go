package profiles

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/anilist"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/testutil"
)

// storedPerson is a people row read back column by column.
type storedPerson struct {
	NameFull, NameNative                 *string
	NameAlternative, PrimaryOccupations  []string
	Language, ImageLarge, ImageMedium    *string
	Description, Gender                  *string
	BirthYear, BirthMonth, BirthDay      *int32
	DeathYear, DeathMonth, DeathDay, Age *int32
	YearsActive                          []int32
	HomeTown, BloodType, SiteURL         *string
	Favourites                           *int32
	FetchedAt, AbsentSince               *time.Time
	CheckedAt                            time.Time
}

func readPerson(t *testing.T, ctx context.Context, pool *pgxpool.Pool, id int32) storedPerson {
	t.Helper()
	var p storedPerson
	require.NoError(t, pool.QueryRow(ctx, `
		SELECT name_full, name_native, name_alternative, language, image_large, image_medium,
		       description, primary_occupations, gender,
		       birth_year, birth_month, birth_day, death_year, death_month, death_day,
		       age, years_active, home_town, blood_type, favourites, site_url,
		       fetched_at, checked_at, absent_since
		FROM people WHERE anilist_id = $1`, id).Scan(
		&p.NameFull, &p.NameNative, &p.NameAlternative, &p.Language, &p.ImageLarge, &p.ImageMedium,
		&p.Description, &p.PrimaryOccupations, &p.Gender,
		&p.BirthYear, &p.BirthMonth, &p.BirthDay, &p.DeathYear, &p.DeathMonth, &p.DeathDay,
		&p.Age, &p.YearsActive, &p.HomeTown, &p.BloodType, &p.Favourites, &p.SiteURL,
		&p.FetchedAt, &p.CheckedAt, &p.AbsentSince))
	return p
}

// storedCharacter is a characters row read back column by column.
type storedCharacter struct {
	NameFull, NameNative                    *string
	NameAlternative, NameAlternativeSpoiler []string
	ImageLarge, ImageMedium, Description    *string
	Gender, Age, BloodType, SiteURL         *string
	BirthYear, BirthMonth, BirthDay         *int32
	Favourites                              *int32
	FetchedAt, AbsentSince                  *time.Time
	CheckedAt                               time.Time
}

func readCharacter(t *testing.T, ctx context.Context, pool *pgxpool.Pool, id int32) storedCharacter {
	t.Helper()
	var c storedCharacter
	require.NoError(t, pool.QueryRow(ctx, `
		SELECT name_full, name_native, name_alternative, name_alternative_spoiler,
		       image_large, image_medium, description, gender,
		       birth_year, birth_month, birth_day, age, blood_type, favourites, site_url,
		       fetched_at, checked_at, absent_since
		FROM characters WHERE anilist_id = $1`, id).Scan(
		&c.NameFull, &c.NameNative, &c.NameAlternative, &c.NameAlternativeSpoiler,
		&c.ImageLarge, &c.ImageMedium, &c.Description, &c.Gender,
		&c.BirthYear, &c.BirthMonth, &c.BirthDay, &c.Age, &c.BloodType, &c.Favourites, &c.SiteURL,
		&c.FetchedAt, &c.CheckedAt, &c.AbsentSince))
	return c
}

// inTx runs fn on queries bound to a transaction and commits.
func inTx(t *testing.T, ctx context.Context, pool *pgxpool.Pool, fn func(q *dbgen.Queries) error) error {
	t.Helper()
	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	defer func() { _ = tx.Rollback(ctx) }()
	if err := fn(dbgen.New(pool).WithTx(tx)); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// TestWritePeople_PG runs the people write on a real Postgres: every
// column round-trips, a re-fetch replaces the profile, and the two kinds
// of stamp touch only what they say they touch.
func TestWritePeople_PG(t *testing.T) {
	ctx := context.Background()
	pool := testutil.NewWebPool(t, ctx, testutil.SetupPG(t))
	q := dbgen.New(pool)
	t0 := time.Date(2026, 10, 9, 8, 0, 0, 0, time.UTC)

	t.Run("every column round-trips", func(t *testing.T) {
		require.NoError(t, WritePeople(ctx, q, []dbgen.UpsertPersonParams{PersonRow(fullStaff(), t0)}, nil, t0))

		got := readPerson(t, ctx, pool, 101)
		assert.Equal(t, "Test Person", *got.NameFull)
		assert.Equal(t, "試験 人物", *got.NameNative)
		assert.Equal(t, []string{"T. Person", "Tess"}, got.NameAlternative)
		assert.Equal(t, "Japanese", *got.Language)
		assert.Equal(t, "https://img/large/101.png", *got.ImageLarge)
		assert.Equal(t, "https://img/medium/101.png", *got.ImageMedium)
		assert.Equal(t, "A voice actor.\n\n~!Plays the twist villain.!~", *got.Description)
		assert.Equal(t, []string{"Voice Actor", "Singer"}, got.PrimaryOccupations)
		assert.Equal(t, "Female", *got.Gender)
		assert.Equal(t, []int32{1988, 9, 27}, []int32{*got.BirthYear, *got.BirthMonth, *got.BirthDay})
		assert.Equal(t, []int32{2030, 1, 2}, []int32{*got.DeathYear, *got.DeathMonth, *got.DeathDay})
		assert.Equal(t, int32(38), *got.Age)
		assert.Equal(t, []int32{2009, 2031}, got.YearsActive)
		assert.Equal(t, "Oita, Japan", *got.HomeTown)
		assert.Equal(t, "A", *got.BloodType)
		assert.Equal(t, int32(1234), *got.Favourites)
		assert.Equal(t, "https://anilist.co/staff/101", *got.SiteURL)
		require.NotNil(t, got.FetchedAt)
		assert.True(t, got.FetchedAt.Equal(t0))
		assert.True(t, got.CheckedAt.Equal(t0))
		assert.Nil(t, got.AbsentSince)
	})

	t.Run("a re-fetch replaces the profile, nulls included", func(t *testing.T) {
		t1 := t0.Add(91 * 24 * time.Hour)
		again := fullStaff()
		again.Description = nil
		again.Favourites = ip(2000)
		again.YearsActive = []*int{ip(2009)}
		require.NoError(t, WritePeople(ctx, q, []dbgen.UpsertPersonParams{PersonRow(again, t1)}, nil, t1))

		got := readPerson(t, ctx, pool, 101)
		assert.Nil(t, got.Description, "AniList no longer has one, so neither do we")
		assert.Equal(t, int32(2000), *got.Favourites)
		assert.Equal(t, []int32{2009}, got.YearsActive)
		assert.True(t, got.FetchedAt.Equal(t1))
		assert.True(t, got.CheckedAt.Equal(t1))

		var rows int
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM people WHERE anilist_id = 101`).Scan(&rows))
		assert.Equal(t, 1, rows)
	})

	t.Run("absent: a new id is a stamp-only row, a stored profile is kept", func(t *testing.T) {
		t2 := t0.Add(200 * 24 * time.Hour)
		require.NoError(t, WritePeople(ctx, q, nil, []int32{101, 555}, t2))

		kept := readPerson(t, ctx, pool, 101)
		assert.Equal(t, "Test Person", *kept.NameFull, "a credit that still names the id still needs the name")
		assert.True(t, kept.FetchedAt.Equal(t0.Add(91*24*time.Hour)), "fetched_at says when the profile is from")
		assert.True(t, kept.CheckedAt.Equal(t2))
		require.NotNil(t, kept.AbsentSince)
		assert.True(t, kept.AbsentSince.Equal(t2))

		stub := readPerson(t, ctx, pool, 555)
		assert.Nil(t, stub.FetchedAt, "AniList has never returned it")
		assert.Nil(t, stub.NameFull)
		assert.Empty(t, stub.NameAlternative)
		assert.Empty(t, stub.YearsActive)
		assert.True(t, stub.CheckedAt.Equal(t2))
		assert.True(t, stub.AbsentSince.Equal(t2))

		t3 := t2.Add(90 * 24 * time.Hour)
		require.NoError(t, WritePeople(ctx, q, nil, []int32{555}, t3))
		stub = readPerson(t, ctx, pool, 555)
		assert.True(t, stub.CheckedAt.Equal(t3))
		assert.True(t, stub.AbsentSince.Equal(t2), "absent since the first ask that missed it")

		t4 := t3.Add(time.Hour)
		back := anilist.StaffProfile{ID: 555, Name: &anilist.StaffName{Full: sp("Returned")}}
		require.NoError(t, WritePeople(ctx, q, []dbgen.UpsertPersonParams{PersonRow(back, t4)}, nil, t4))
		stub = readPerson(t, ctx, pool, 555)
		assert.Nil(t, stub.AbsentSince, "returned again, so no longer absent")
		assert.Equal(t, "Returned", *stub.NameFull)
		assert.True(t, stub.FetchedAt.Equal(t4))
	})

	t.Run("a failure stamp moves checked_at and nothing else", func(t *testing.T) {
		before := readPerson(t, ctx, pool, 101)
		backDated := t0.Add(-89 * 24 * time.Hour)
		require.NoError(t, q.StampPeopleChecked(ctx, pgtype.Timestamptz{Time: backDated, Valid: true}, false, []int32{101, 777, 777}))

		after := readPerson(t, ctx, pool, 101)
		assert.True(t, after.CheckedAt.Equal(backDated))
		after.CheckedAt = before.CheckedAt
		assert.Equal(t, before, after, "profile, fetched_at and absent_since untouched")

		stub := readPerson(t, ctx, pool, 777)
		assert.Nil(t, stub.FetchedAt)
		assert.Nil(t, stub.AbsentSince, "a failed ask says nothing about AniList")
		assert.True(t, stub.CheckedAt.Equal(backDated))
	})

	t.Run("an empty list is stored as one, not refused", func(t *testing.T) {
		row := PersonRow(anilist.StaffProfile{ID: 888}, t0)
		row.NameAlternative, row.PrimaryOccupations, row.YearsActive = nil, nil, nil
		require.NoError(t, WritePeople(ctx, q, []dbgen.UpsertPersonParams{row}, nil, t0))
		got := readPerson(t, ctx, pool, 888)
		assert.Equal(t, []string{}, got.NameAlternative)
		assert.Equal(t, []string{}, got.PrimaryOccupations)
		assert.Equal(t, []int32{}, got.YearsActive)
	})

	t.Run("one batch is one transaction", func(t *testing.T) {
		good := PersonRow(anilist.StaffProfile{ID: 901, Name: &anilist.StaffName{Full: sp("Good")}}, t0)
		bad := PersonRow(anilist.StaffProfile{ID: 902}, t0)
		bad.BirthMonth = i32(13) // past the normaliser; the CHECK refuses it
		err := inTx(t, ctx, pool, func(tq *dbgen.Queries) error {
			return WritePeople(ctx, tq, []dbgen.UpsertPersonParams{good, bad}, []int32{903}, t0)
		})
		require.Error(t, err)

		var n int
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM people WHERE anilist_id IN (901, 902, 903)`).Scan(&n))
		assert.Zero(t, n, "neither the row before the failure nor the absent stamp after it")
	})
}

// TestWriteCharacters_PG is TestWritePeople_PG for characters.
func TestWriteCharacters_PG(t *testing.T) {
	ctx := context.Background()
	pool := testutil.NewWebPool(t, ctx, testutil.SetupPG(t))
	q := dbgen.New(pool)
	t0 := time.Date(2026, 10, 9, 8, 0, 0, 0, time.UTC)

	hero := anilist.CharacterProfile{
		ID: 201,
		Name: &anilist.CharacterName{
			Full: sp("Test Hero"), Native: sp("テスト"),
			Alternative: []*string{sp("The Hero")}, AlternativeSpoiler: []*string{sp("The Demon King")},
		},
		Image:       &anilist.Image{Large: sp("https://img/large/201.png"), Medium: sp("https://img/medium/201.png")},
		Description: sp("~!Was the king all along.!~"),
		Gender:      sp("Male"),
		DateOfBirth: &anilist.FuzzyDate{Month: ip(12), Day: ip(24)},
		Age:         sp("16-17"),
		BloodType:   sp("O"),
		Favourites:  ip(42),
		SiteURL:     sp("https://anilist.co/character/201"),
	}

	t.Run("every column round-trips", func(t *testing.T) {
		require.NoError(t, WriteCharacters(ctx, q, []dbgen.UpsertCharacterParams{CharacterRow(hero, t0)}, nil, t0))

		got := readCharacter(t, ctx, pool, 201)
		assert.Equal(t, "Test Hero", *got.NameFull)
		assert.Equal(t, "テスト", *got.NameNative)
		assert.Equal(t, []string{"The Hero"}, got.NameAlternative)
		assert.Equal(t, []string{"The Demon King"}, got.NameAlternativeSpoiler)
		assert.Equal(t, "https://img/large/201.png", *got.ImageLarge)
		assert.Equal(t, "https://img/medium/201.png", *got.ImageMedium)
		assert.Equal(t, "~!Was the king all along.!~", *got.Description)
		assert.Equal(t, "Male", *got.Gender)
		assert.Nil(t, got.BirthYear)
		assert.Equal(t, int32(12), *got.BirthMonth)
		assert.Equal(t, int32(24), *got.BirthDay)
		assert.Equal(t, "16-17", *got.Age)
		assert.Equal(t, "O", *got.BloodType)
		assert.Equal(t, int32(42), *got.Favourites)
		assert.Equal(t, "https://anilist.co/character/201", *got.SiteURL)
		assert.True(t, got.FetchedAt.Equal(t0))
		assert.True(t, got.CheckedAt.Equal(t0))
		assert.Nil(t, got.AbsentSince)
	})

	t.Run("absent and failure stamps", func(t *testing.T) {
		t1 := t0.Add(100 * 24 * time.Hour)
		require.NoError(t, WriteCharacters(ctx, q, nil, []int32{201, 301}, t1))
		kept := readCharacter(t, ctx, pool, 201)
		assert.Equal(t, "Test Hero", *kept.NameFull)
		assert.True(t, kept.FetchedAt.Equal(t0))
		assert.True(t, kept.AbsentSince.Equal(t1))
		stub := readCharacter(t, ctx, pool, 301)
		assert.Nil(t, stub.FetchedAt)
		assert.True(t, stub.AbsentSince.Equal(t1))
		assert.Empty(t, stub.NameAlternativeSpoiler)

		backDated := t1.Add(-89 * 24 * time.Hour)
		require.NoError(t, q.StampCharactersChecked(ctx, pgtype.Timestamptz{Time: backDated, Valid: true}, false, []int32{301, 302}))
		stub = readCharacter(t, ctx, pool, 301)
		assert.True(t, stub.CheckedAt.Equal(backDated))
		assert.True(t, stub.AbsentSince.Equal(t1), "a failed ask does not clear an absence either")
		assert.Nil(t, readCharacter(t, ctx, pool, 302).AbsentSince)

		t2 := t1.Add(time.Hour)
		require.NoError(t, WriteCharacters(ctx, q, []dbgen.UpsertCharacterParams{CharacterRow(hero, t2)}, nil, t2))
		assert.Nil(t, readCharacter(t, ctx, pool, 201).AbsentSince)
	})
}
