package community

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
)

// A write that names a row which is gone answers 404, whether the row was
// gone before the statement began (no rows) or went in a concurrent
// transaction while the insert was checking its foreign key — a status card
// replaced by its owner's next status change while someone likes it.
func TestFailLookup(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want int
	}{
		{"no rows", pgx.ErrNoRows, http.StatusNotFound},
		{"wrapped no rows", fmt.Errorf("read: %w", pgx.ErrNoRows), http.StatusNotFound},
		{"foreign key violation", &pgconn.PgError{Code: "23503"}, http.StatusNotFound},
		{"wrapped foreign key violation", fmt.Errorf("insert: %w", &pgconn.PgError{Code: "23503"}), http.StatusNotFound},
		{"unique violation is not a 404", &pgconn.PgError{Code: "23505"}, http.StatusInternalServerError},
		{"anything else", errors.New("connection reset"), http.StatusInternalServerError},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			failLookup(rec, tc.err, "Activity not found")
			assert.Equal(t, tc.want, rec.Code)
		})
	}
}
