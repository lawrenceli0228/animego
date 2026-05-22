package admin

// list_users_test.go — pure unit tests for the users SQL builder.

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestBuildUsersListSQL_NoQuery(t *testing.T) {
	t.Parallel()

	listSQL, countSQL, args := buildUsersListSQL(usersListParams{Page: 1})

	assert.NotContains(t, listSQL, " WHERE ")
	assert.NotContains(t, countSQL, " WHERE ")
	assert.Contains(t, listSQL, "ORDER BY created_at DESC")
	assert.Contains(t, listSQL, "LIMIT 30 OFFSET 0")
	assert.Empty(t, args)
}

func TestBuildUsersListSQL_WithQuery_ILIKEUsernameOrEmail(t *testing.T) {
	t.Parallel()

	listSQL, countSQL, args := buildUsersListSQL(usersListParams{
		Page:  1,
		Query: "alice",
	})

	assert.Contains(t, listSQL, " WHERE username ILIKE $1 OR email ILIKE $1")
	assert.Contains(t, countSQL, " WHERE username ILIKE $1 OR email ILIKE $1")
	require.Len(t, args, 1)
	assert.Equal(t, "%alice%", args[0])
}

func TestBuildUsersListSQL_QueryEscapesWildcards(t *testing.T) {
	t.Parallel()

	_, _, args := buildUsersListSQL(usersListParams{
		Page:  1,
		Query: "a%_b",
	})

	require.Len(t, args, 1)
	assert.Equal(t, `%a\%\_b%`, args[0])
}

func TestBuildUsersListSQL_QueryEmptyAfterTrim(t *testing.T) {
	t.Parallel()

	listSQL, _, args := buildUsersListSQL(usersListParams{
		Page:  1,
		Query: "  \t  ",
	})

	assert.NotContains(t, listSQL, "ILIKE")
	assert.NotContains(t, listSQL, " WHERE ")
	assert.Empty(t, args)
}

func TestBuildUsersListSQL_Pagination(t *testing.T) {
	t.Parallel()

	one, _, _ := buildUsersListSQL(usersListParams{Page: 1})
	two, _, _ := buildUsersListSQL(usersListParams{Page: 2})
	five, _, _ := buildUsersListSQL(usersListParams{Page: 5})

	assert.Contains(t, one, "OFFSET 0")
	assert.Contains(t, two, "OFFSET 30")
	assert.Contains(t, five, "OFFSET 120")
}

func TestBuildUsersListSQL_Projection(t *testing.T) {
	t.Parallel()

	listSQL, _, _ := buildUsersListSQL(usersListParams{Page: 1})

	for _, col := range []string{"id", "username", "email", "role", "created_at"} {
		assert.Contains(t, listSQL, col, "missing %s in projection", col)
	}
}

func TestParsePage(t *testing.T) {
	t.Parallel()

	cases := []struct {
		input string
		want  int
	}{
		{"", 1},
		{"1", 1},
		{"2", 2},
		{"99", 99},
		{"-5", 1},
		{"0", 1},
		{"abc", 1},
		{"1.5", 1},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.input, func(t *testing.T) {
			t.Parallel()
			assert.Equal(t, tc.want, parsePage(tc.input))
		})
	}
}
