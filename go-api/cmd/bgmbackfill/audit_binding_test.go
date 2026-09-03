// audit_binding_test.go — the audit's verdict, pinned.
//
// This function's output is a claim about production data that a human will
// act on.  A verdict that is wrong in the lenient direction reports a clean
// batch over a wrong binding, and nobody looks again; wrong in the strict
// direction buries the real problems under noise.  Both failure modes look
// like a working report, which is why the boundaries get cases rather than a
// reading of the code.
package main

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/bangumi"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

type fakeSubjectFetcher struct {
	subj *bangumi.Subject
	err  error
}

func (f *fakeSubjectFetcher) Subject(context.Context, int) (*bangumi.Subject, error) {
	return f.subj, f.err
}

func i32(v int32) *int32  { return &v }
func sp(v string) *string { return &v }

func auditFixture(native *string, year, eps *int32) dbgen.ListRecentIdMapBindingsRow {
	return dbgen.ListRecentIdMapBindingsRow{
		AnilistID: 4242, BgmID: i32(9001),
		TitleNative: native, SeasonYear: year, Episodes: eps,
	}
}

func TestAuditOneBinding(t *testing.T) {
	tests := []struct {
		name     string
		row      dbgen.ListRecentIdMapBindingsRow
		subj     *bangumi.Subject
		fetchErr error
		want     string
	}{
		{
			name: "the same show on both sides passes",
			row:  auditFixture(sp("葬送のフリーレン"), i32(2023), i32(28)),
			subj: &bangumi.Subject{Name: "葬送のフリーレン", Date: "2023-09-29", Eps: 28},
			want: auditOK,
		},
		{
			// AniList files a December start under that year and Bangumi under
			// the next, so one year of drift must not be reported.
			name: "a year of drift across a season boundary is tolerated",
			row:  auditFixture(sp("葬送のフリーレン"), i32(2023), i32(28)),
			subj: &bangumi.Subject{Name: "葬送のフリーレン", Date: "2024-01-05", Eps: 28},
			want: auditOK,
		},
		{
			// The case the title cannot see: a franchise's seasons share a
			// stem, and the year is what tells them apart.
			name: "a matching title from the wrong decade is flagged",
			row:  auditFixture(sp("鋼の錬金術師"), i32(2003), i32(51)),
			subj: &bangumi.Subject{Name: "鋼の錬金術師", Date: "2009-04-05", Eps: 64},
			want: auditYearOff,
		},
		{
			name: "a matching title over twice the episode count is flagged",
			row:  auditFixture(sp("ワンピース"), i32(2020), i32(4)),
			subj: &bangumi.Subject{Name: "ワンピース", Date: "2020-01-01", Eps: 1000},
			want: auditEpsOff,
		},
		{
			name: "two different shows are flagged as weak",
			row:  auditFixture(sp("葬送のフリーレン"), i32(2023), i32(28)),
			subj: &bangumi.Subject{Name: "進撃の巨人", Date: "2023-01-01", Eps: 28},
			want: auditWeak,
		},
		{
			// A row with no Japanese title has nothing to compare like with
			// like, and scoring romaji against an original would manufacture a
			// verdict out of a transliteration.
			name: "a row with no native title is reported as uncheckable",
			row:  auditFixture(nil, i32(2023), i32(28)),
			subj: &bangumi.Subject{Name: "葬送のフリーレン", Date: "2023-09-29", Eps: 28},
			want: auditNoNative,
		},
		{
			name:     "an unreadable subject is reported, not silently passed",
			row:      auditFixture(sp("葬送のフリーレン"), i32(2023), i32(28)),
			fetchErr: errors.New("bangumi 500"),
			want:     auditFetchErr,
		},
		{
			// Bangumi leaves the date empty on a lot of OVA entries.  An
			// absent date cannot disagree with anything, so it must not be
			// read as year 0 and reported as two millennia of drift.
			name: "a subject with no date is not treated as year zero",
			row:  auditFixture(sp("トップをねらえ!"), i32(1988), i32(6)),
			subj: &bangumi.Subject{Name: "トップをねらえ!", Date: "", Eps: 6},
			want: auditOK,
		},
		{
			name: "an unknown episode count on either side is not a mismatch",
			row:  auditFixture(sp("葬送のフリーレン"), i32(2023), nil),
			subj: &bangumi.Subject{Name: "葬送のフリーレン", Date: "2023-09-29", Eps: 999},
			want: auditOK,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := auditOneBinding(context.Background(),
				&fakeSubjectFetcher{subj: tc.subj, err: tc.fetchErr}, tc.row)
			assert.Equal(t, tc.want, got.Verdict,
				"similarity was %.3f", got.Similarity)
		})
	}
}

func TestYearFromBgmDate(t *testing.T) {
	for _, tc := range []struct {
		in   string
		want int
	}{
		{"2023-09-29", 2023},
		{"1988", 1988},
		{"", 0},
		{"n/a", 0},
		{"20", 0},
	} {
		t.Run(tc.in, func(t *testing.T) {
			require.Equal(t, tc.want, yearFromBgmDate(tc.in))
		})
	}
}
