// legacy_binding_decision_test.go — the pure decision behind the legacy
// binding check, one guard per test case.
//
// Every guard case starts from the Black Clover row (a binding the check must
// withdraw) and changes exactly one input, so each case shows that one input,
// on its own, is enough to stand the check down.  A table of unrelated rows
// would let a guard pass by accident of some other field.
package queue

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/bangumi"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

func TestLegacyBindingNamesAnotherWork_ProductionRows(t *testing.T) {
	t.Parallel()
	for _, tc := range fall2026TopSix() {
		got, reason := legacyBindingNamesAnotherWork(tc.identity, int32(tc.subject.ID), tc.subject)
		assert.Equal(t, tc.anotherWork, got, "%s (reason %q)", tc.name, reason)
		if got {
			assert.NotEmpty(t, reason, "a withdrawal must say why, for the log line")
		}
	}
}

func TestLegacyBindingNamesAnotherWork_Guards(t *testing.T) {
	t.Parallel()

	base := func() (dbgen.GetBangumiBindingIdentityRow, *bangumi.Subject) {
		tc := fall2026TopSix()[0] // 195604 -> 75989
		return tc.identity, tc.subject
	}
	str := func(s string) *string { return &s }
	i32 := func(n int32) *int32 { return &n }
	date := func(y int, m time.Month, d int) pgtype.Date {
		return pgtype.Date{Time: time.Date(y, m, d, 0, 0, 0, 0, time.UTC), Valid: true}
	}

	cases := []struct {
		name   string
		mutate func(id *dbgen.GetBangumiBindingIdentityRow, s *bangumi.Subject, bgmID *int32)
		want   bool
	}{
		{"the unmodified production row is withdrawn", func(*dbgen.GetBangumiBindingIdentityRow, *bangumi.Subject, *int32) {}, true},

		// Bindings something has vouched for.
		{"a source recorded by the V1 scorer", func(id *dbgen.GetBangumiBindingIdentityRow, _ *bangumi.Subject, _ *int32) {
			id.BgmMatchSource = str("fuzzy_high")
		}, false},
		{"a source recorded by the id map", func(id *dbgen.GetBangumiBindingIdentityRow, _ *bangumi.Subject, _ *int32) {
			id.BgmMatchSource = str("id_map")
		}, false},
		{"a manual source", func(id *dbgen.GetBangumiBindingIdentityRow, _ *bangumi.Subject, _ *int32) {
			id.BgmMatchSource = str("manual")
		}, false},
		{"an admin correction", func(id *dbgen.GetBangumiBindingIdentityRow, _ *bangumi.Subject, _ *int32) {
			id.AdminFlag = str("manually-corrected")
		}, false},
		{"the id map names this pair", func(id *dbgen.GetBangumiBindingIdentityRow, _ *bangumi.Subject, _ *int32) {
			id.IDMapAgrees = true
		}, false},

		// A verdict about a subject the row does not hold is no verdict.
		{"the binding moved since the subject was fetched", func(_ *dbgen.GetBangumiBindingIdentityRow, _ *bangumi.Subject, bgmID *int32) {
			*bgmID = 12345
		}, false},
		{"the row holds no binding at all", func(id *dbgen.GetBangumiBindingIdentityRow, _ *bangumi.Subject, _ *int32) {
			id.BgmID = nil
		}, false},

		// Missing evidence is not evidence.
		{"the subject has no name", func(_ *dbgen.GetBangumiBindingIdentityRow, s *bangumi.Subject, _ *int32) {
			s.Name = "   "
		}, false},
		{"the row has no AniList title", func(id *dbgen.GetBangumiBindingIdentityRow, _ *bangumi.Subject, _ *int32) {
			id.TitleNative, id.TitleRomaji, id.TitleEnglish = nil, str(""), nil
		}, false},
		{"the AniList year is unknown", func(id *dbgen.GetBangumiBindingIdentityRow, _ *bangumi.Subject, _ *int32) {
			id.SeasonYear = nil
			id.StartDate = pgtype.Date{}
		}, false},
		{"the subject has no air date", func(_ *dbgen.GetBangumiBindingIdentityRow, s *bangumi.Subject, _ *int32) {
			s.Date = ""
		}, false},
		{"the subject's air date is Bangumi's zero date", func(_ *dbgen.GetBangumiBindingIdentityRow, s *bangumi.Subject, _ *int32) {
			s.Date = "0000-00-00"
		}, false},
		{"the subject's air date is not a date", func(_ *dbgen.GetBangumiBindingIdentityRow, s *bangumi.Subject, _ *int32) {
			s.Date = "TBA"
		}, false},

		// The year signal: start_date stands in for season_year, and the
		// boundary is exactly two years.
		{"start_date stands in for a missing season_year", func(id *dbgen.GetBangumiBindingIdentityRow, _ *bangumi.Subject, _ *int32) {
			id.SeasonYear = nil
			id.StartDate = date(2026, time.October, 3)
		}, true},
		{"one year apart is a boundary-season slip, not another show", func(_ *dbgen.GetBangumiBindingIdentityRow, s *bangumi.Subject, _ *int32) {
			s.Date = "2025-12-28"
		}, false},
		{"two years apart counts", func(_ *dbgen.GetBangumiBindingIdentityRow, s *bangumi.Subject, _ *int32) {
			s.Date = "2024-04-06"
		}, true},
		{"a subject dated after the AniList year counts too", func(_ *dbgen.GetBangumiBindingIdentityRow, s *bangumi.Subject, _ *int32) {
			s.Date = "2028-01-01"
		}, true},

		// The title signal, over every AniList title.
		{"the subject is named like the native title", func(_ *dbgen.GetBangumiBindingIdentityRow, s *bangumi.Subject, _ *int32) {
			s.Name = "ブラッククローバー"
		}, false},
		{"the subject is named like the romaji title", func(_ *dbgen.GetBangumiBindingIdentityRow, s *bangumi.Subject, _ *int32) {
			s.Name = "Black Clover"
		}, false},
		{"the subject is named like the English title", func(id *dbgen.GetBangumiBindingIdentityRow, s *bangumi.Subject, _ *int32) {
			id.TitleRomaji = str("Burakku Kurōbā")
			s.Name = "Black Clover Season 2"
		}, false},
		{"the Chinese title is never a comparison input", func(_ *dbgen.GetBangumiBindingIdentityRow, s *bangumi.Subject, _ *int32) {
			// title_chinese is not even in the identity row; a subject whose
			// name_cn matches what the row displays proves nothing.
			s.NameCN = "黑色五叶草 第二季"
		}, true},
		{"a row with only a romaji title is still decidable", func(id *dbgen.GetBangumiBindingIdentityRow, _ *bangumi.Subject, _ *int32) {
			id.TitleNative, id.TitleEnglish = nil, nil
		}, true},
	}

	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			id, s := base()
			bgmID := *id.BgmID
			// Fresh pointers so one case's mutation cannot leak into another.
			id.BgmID = i32(bgmID)
			c.mutate(&id, s, &bgmID)
			got, reason := legacyBindingNamesAnotherWork(id, bgmID, s)
			assert.Equal(t, c.want, got, "reason %q", reason)
		})
	}

	t.Run("a nil subject", func(t *testing.T) {
		t.Parallel()
		id, _ := base()
		got, _ := legacyBindingNamesAnotherWork(id, *id.BgmID, nil)
		assert.False(t, got)
	})
}

// TestWithdrawIfAnotherWork covers the plumbing around the decision: what a
// missing row, a failed read and a failed withdrawal each mean to the caller.
func TestWithdrawIfAnotherWork(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	wrong := fall2026TopSix()[0]
	right := fall2026TopSix()[3]

	t.Run("a row that is gone has nothing to protect", func(t *testing.T) {
		t.Parallel()
		db := &fakeLegacyBindingDB{}
		withdrawn, err := withdrawIfAnotherWork(ctx, db, "test", wrong.anilistID, int32(wrong.subject.ID), wrong.subject)
		require.NoError(t, err)
		assert.False(t, withdrawn)
		assert.Empty(t, db.snapshotRepudiations())
	})

	t.Run("a failed read is an error, never a licence to publish", func(t *testing.T) {
		t.Parallel()
		db := &fakeLegacyBindingDB{identityErr: assert.AnError}
		_, err := withdrawIfAnotherWork(ctx, db, "test", wrong.anilistID, int32(wrong.subject.ID), wrong.subject)
		require.ErrorIs(t, err, assert.AnError)
		assert.NotErrorIs(t, err, pgx.ErrNoRows)
		assert.Empty(t, db.snapshotRepudiations())
	})

	t.Run("a correct binding is left alone", func(t *testing.T) {
		t.Parallel()
		db := &fakeLegacyBindingDB{}
		db.setIdentity(right.anilistID, right.identity)
		withdrawn, err := withdrawIfAnotherWork(ctx, db, "test", right.anilistID, int32(right.subject.ID), right.subject)
		require.NoError(t, err)
		assert.False(t, withdrawn)
		assert.Empty(t, db.snapshotRepudiations())
	})

	t.Run("a wrong binding is withdrawn", func(t *testing.T) {
		t.Parallel()
		db := &fakeLegacyBindingDB{}
		db.setIdentity(wrong.anilistID, wrong.identity)
		withdrawn, err := withdrawIfAnotherWork(ctx, db, "test", wrong.anilistID, int32(wrong.subject.ID), wrong.subject)
		require.NoError(t, err)
		assert.True(t, withdrawn)
		assert.Equal(t, []legacyRepudiateCall{{anilistID: wrong.anilistID, bgmID: int32(wrong.subject.ID)}}, db.snapshotRepudiations())
	})

	t.Run("a failed withdrawal still forbids publishing, and is retried", func(t *testing.T) {
		t.Parallel()
		db := &fakeLegacyBindingDB{repudiateErr: assert.AnError}
		db.setIdentity(wrong.anilistID, wrong.identity)
		withdrawn, err := withdrawIfAnotherWork(ctx, db, "test", wrong.anilistID, int32(wrong.subject.ID), wrong.subject)
		require.ErrorIs(t, err, assert.AnError)
		assert.True(t, withdrawn, "the verdict stands even though the write failed")
	})

	t.Run("a withdrawal that matched no row is not an error", func(t *testing.T) {
		t.Parallel()
		zero := int64(0)
		db := &fakeLegacyBindingDB{repudiateRows: &zero}
		db.setIdentity(wrong.anilistID, wrong.identity)
		withdrawn, err := withdrawIfAnotherWork(ctx, db, "test", wrong.anilistID, int32(wrong.subject.ID), wrong.subject)
		require.NoError(t, err)
		assert.True(t, withdrawn, "the row moved under us; publishing this subject is still wrong")
	})
}
