package admin

// Drift guard for the one number the /admin backfill panel cannot derive
// from a single source.
//
// GetDescriptionCnStats' "pending" count reproduces the WHERE clause of
// ListDescriptionCnCandidates so an operator can read "how far behind is the
// sweep" off the dashboard.  The candidate query takes its cooldown as a bound
// parameter driven by descriptionBackfillRetryDays (a Go const in
// internal/queue); the stats query cannot, because it has no caller to pass one
// and sqlc cannot read a Go const — so it carries a hand-written `interval '30
// days'` instead.
//
// Two hand-kept copies of a number drift.  When these two do, nothing breaks
// loudly:  the panel keeps rendering a confident figure that counts a different
// set of rows than the sweep will actually pick up.  Too small a literal and
// the panel shows work that never gets scheduled; too large and it hides work
// already queued.  Either way the dashboard's core promise — every number is
// reproducible and means what it says — is quietly gone.
//
// Importing internal/queue to read the constant directly is deliberately not
// the fix:  that package pulls in river, and internal/admin is kept free of it
// on purpose (see the QueueStatusFn indirection in handlers.go).  Reading both
// files as text costs nothing and keeps the dependency boundary intact.

import (
	"os"
	"regexp"
	"testing"

	"github.com/stretchr/testify/require"
)

const (
	backfillSourcePath = "../queue/description_backfill.go"
	adminQueryPath     = "../db/queries/admin.sql"
)

var (
	retryDaysConstRe = regexp.MustCompile(`descriptionBackfillRetryDays\s*=\s*(\d+)`)
	retryDaysSQLRe   = regexp.MustCompile(`description_cn_attempted_at\s*<\s*now\(\)\s*-\s*interval\s*'(\d+) days'`)
)

func TestDescriptionCnCooldownMatchesSweepConstant(t *testing.T) {
	goSrc, err := os.ReadFile(backfillSourcePath)
	require.NoError(t, err, "cannot read the sweep source; if it moved, update backfillSourcePath rather than deleting this guard")

	sqlSrc, err := os.ReadFile(adminQueryPath)
	require.NoError(t, err, "cannot read admin.sql")

	goMatch := retryDaysConstRe.FindSubmatch(goSrc)
	require.Len(t, goMatch, 2,
		"descriptionBackfillRetryDays not found in %s — the stats query mirrors it, so it must stay greppable",
		backfillSourcePath)

	sqlMatches := retryDaysSQLRe.FindAllSubmatch(sqlSrc, -1)
	require.Len(t, sqlMatches, 1,
		"expected exactly one description_cn cooldown literal in %s, found %d",
		adminQueryPath, len(sqlMatches))

	require.Equal(t, string(goMatch[1]), string(sqlMatches[0][1]),
		"cooldown drift: descriptionBackfillRetryDays is %s days but admin.sql's pending count uses interval '%s days'. "+
			"The dashboard would report a backlog the sweep does not actually work through. Change both.",
		goMatch[1], sqlMatches[0][1])
}
