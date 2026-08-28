package db

// Invariant scan over the hand-written .sql sources in queries/.
//
// ── WHY THIS TEST EXISTS AND WHY IT READS TEXT INSTEAD OF RUNNING SQL ──
// The refresh-session state on `users` is THREE columns that only mean
// anything together:
//
//	refresh_token           the currently-valid token
//	previous_refresh_token  honored for refreshGraceWindow (30 s) after a
//	                        rotation, so the losing side of a concurrent
//	                        refresh does not get logged out
//	refresh_rotated_at      when the rotation happened; gates that window
//
// Every statement whose intent is "this session is over" must clear all
// three.  Clearing only refresh_token leaves the grace slot loaded, and the
// Refresh handler will keep honoring the supposedly-revoked cookie for the
// rest of the window — a password reset that does not take effect for 30
// seconds.  That is exactly the bug this file was written after fixing.
//
// The defect class is invisible to every other kind of test we have:
//
//   - Handler tests use a hand-written fake (auth.fakeAuthDB) that captures
//     call arguments.  A fake cannot observe what a SQL string writes, so a
//     statement that clears one column instead of three passes them all.
//   - An integration test pins BEHAVIOUR for the statements it happens to
//     exercise.  It says nothing about the fourth kill-session statement
//     someone adds next year, which is the realistic way this regresses:
//     each new statement looks locally reasonable, and only a whole-file
//     sweep sees that it broke the set.
//
// So this reads the source text.  It needs no database, no build tag, and no
// container, which means it runs in the default `go test ./...` gate where
// the mistake would actually be caught — before review, not after deploy.
//
// It parses rather than greps because substring matching is wrong here:
// "previous_refresh_token = NULL" contains "refresh_token = NULL", and
// RotateRefreshToken legitimately mentions refresh_token in its WHERE clause.
// Both would produce confident, incorrect results.
//
// ── WHAT THIS SCAN DOES NOT COVER, SO NOBODY ASSUMES OTHERWISE ──
// It reads SET clauses only. The WHERE clause is deliberately truncated away,
// which means it says NOTHING about:
//
//   - RotateRefreshToken's compare-and-swap predicate. Deleting
//     `AND refresh_token = @expected_token` — the change that let a logout be
//     overwritten by an in-flight rotation, handing back a live 7-day token —
//     passes every rule here. That predicate is pinned by behaviour instead:
//     TestRotateRefreshToken_ArgumentSwapMatchesNothing and the two race tests
//     in test/integration/user_session_columns_test.go.
//   - Row scoping generally. A kill switch narrowed to `AND is_public = true`
//     would clear all three columns for some users and silently skip the rest,
//     and this file would be satisfied.
//
// A scan over SET clauses cannot grow into a WHERE-clause checker without
// becoming a SQL engine. The division of labour is the point: text scan for
// "every statement of this shape agrees", real database for "this statement
// does what it says".

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// Column names, spelled once.
const (
	colRefreshToken     = "refresh_token"
	colPreviousRefresh  = "previous_refresh_token"
	colRefreshRotatedAt = "refresh_rotated_at"
)

// mustKillSession names the statements that are REQUIRED to clear all three
// columns.  The scan rules below catch a statement that clears some of the
// set; this list catches the other direction — a statement that quietly stops
// revoking anything at all, which no rule about internal consistency can see.
//
// Adding a statement here is a deliberate act.  Removing one means you have
// decided that flow no longer ends a session; say why in the commit.
var mustKillSession = map[string]string{
	"ResetUserPassword":    "self-serve forgot-password: the user is asking us to lock out whoever has the old credential",
	"AdminSetUserPassword": "admin lockout: the operator is usually responding to a suspected compromise",
	"UpdateUserPassword":   "dormant self-serve change-password: ships in the shape its first caller will trust",
	"UpdateUserRefreshToken": "login sets a fresh token and logout NULLs it; either way the old grace slot " +
		"must not survive into the new session",
	"ClearRefreshTokenIfMatches": "logout: ends the presented session, so it must not leave a grace slot " +
		"the Refresh handler would still honour",
}

// sqlStatement is one `-- name: X :kind` block, with comments stripped.
type sqlStatement struct {
	name string
	file string
	line int    // 1-indexed line of the `-- name:` marker
	body string // SQL only, comment lines removed
}

// parseStatus distinguishes the three answers the scan can give, because
// collapsing them is how a text scan goes quietly blind.
type parseStatus int

const (
	// parseIrrelevant: not an UPDATE, so there is no SET clause to judge.
	parseIrrelevant parseStatus = iota
	// parseOK: the SET clause was read in full.
	parseOK
	// parseUnsupported: the statement writes, but in a shape this scan does
	// not understand. NEVER treat this as "nothing to see" — if the statement
	// touches a session column, it is a hard failure.
	parseUnsupported
)

// setParse is the result of reading one statement's SET clause.
type setParse struct {
	sets   map[string]string
	status parseStatus
	reason string // populated only for parseUnsupported
}

// setAssignments reads the column → expression map of an UPDATE's SET clause.
//
// ── WHAT IT DELIBERATELY REFUSES TO GUESS ──
// An earlier version returned a bare map and nil, so "I could not read this"
// and "there is nothing to check here" were the same answer. A reviewer
// injected six defects into a copy of queries/ and four of them passed —
// every one of them by being a shape the parser silently skipped. The lesson
// is not "handle more shapes"; the corpus will always outrun the parser. It
// is that an unreadable statement must be loud.
//
// So three shapes return parseUnsupported rather than a partial map:
//
//   - a CTE (`WITH … UPDATE users …`). 19 statements in queries/ already
//     start with WITH, and `…WithActivity` is this codebase's own idiom, so a
//     future ResetUserPasswordWithActivity is a realistic next commit, not a
//     hypothetical.
//   - `UPDATE … SET … FROM (SELECT …)`. Two such statements exist TODAY —
//     ApplyHantTitleBatch and ApplyHantDescriptionBatch in anime_cache.sql —
//     and the previous version mis-parsed both, swallowing `FROM ( SELECT …)`
//     into the last assignment's expression. They survive only because their
//     subqueries happen to contain no WHERE.
//   - no SET keyword at all.
//
// Truncation at WHERE / RETURNING now happens at PAREN DEPTH 0. That is what
// makes a subquery inside the SET clause — `role = (SELECT … WHERE …)` — parse
// correctly instead of truncating at the subquery's WHERE and reporting the
// remaining columns as missing. That false red reads exactly like a product
// bug: the developer stares at a `previous_refresh_token = NULL` the scan
// claims is absent.
func (s sqlStatement) setAssignments() setParse {
	body := strings.TrimSpace(s.body)
	upper := strings.ToUpper(body)

	if !strings.HasPrefix(upper, "UPDATE ") {
		// A CTE wrapping an UPDATE is a write this scan cannot read. Anything
		// else (SELECT, INSERT, a WITH over a SELECT) genuinely has no SET
		// clause to judge.
		if strings.HasPrefix(upper, "WITH ") && findKeyword(body, "UPDATE") >= 0 {
			return setParse{status: parseUnsupported, reason: "CTE-wrapped UPDATE"}
		}
		return setParse{status: parseIrrelevant}
	}

	setIdx := findKeyword(body, "SET")
	if setIdx < 0 {
		return setParse{status: parseUnsupported, reason: "UPDATE with no SET keyword"}
	}
	clause := body[setIdx+len("SET"):]

	// First depth-0 clause terminator wins. FROM means UPDATE … FROM, whose
	// join source this scan does not model.
	end := len(clause)
	for _, kw := range []string{"WHERE", "RETURNING", "FROM"} {
		i := findKeywordDepth0(clause, kw)
		if i < 0 || i >= end {
			continue
		}
		if kw == "FROM" {
			return setParse{status: parseUnsupported, reason: "UPDATE … SET … FROM (join source not modelled)"}
		}
		end = i
	}
	clause = clause[:end]

	out := make(map[string]string)
	for _, assign := range splitTopLevel(clause, ',') {
		eq := strings.Index(assign, "=")
		if eq < 0 {
			continue
		}
		col := strings.TrimSpace(assign[:eq])
		expr := strings.Join(strings.Fields(assign[eq+1:]), " ")
		expr = strings.TrimSuffix(expr, ";")
		out[col] = strings.TrimSpace(expr)
	}
	return setParse{sets: out, status: parseOK}
}

// mentionsSessionColumn reports whether the statement names any of the three
// columns anywhere in its SQL. It is what turns parseUnsupported from a shrug
// into a failure: a shape we cannot read only matters if it might be writing
// the state this file guards.
func (s sqlStatement) mentionsSessionColumn() bool {
	for _, col := range []string{colRefreshToken, colPreviousRefresh, colRefreshRotatedAt} {
		if strings.Contains(s.body, col) {
			return true
		}
	}
	return false
}

// isLiteralNull reports whether expr is exactly the NULL keyword.
func isLiteralNull(expr string) bool {
	return strings.EqualFold(strings.TrimSpace(expr), "NULL")
}

// describeIndeterminate names WHY a refresh_token write cannot be judged from
// the text, so the failure message tells the reader something they did not
// already know.
//
// Everything that is not a literal NULL lands here. That is deliberately
// aggressive: the scan's job is not to guess whether an expression can produce
// NULL, it is to force a human to say so. Two shapes were each independently
// enough to defeat an earlier, cleverer version of this check —
//
//   - `refresh_token = $2`, which UpdateUserRefreshToken uses for BOTH login
//     (live token) and logout (nil). No reading of the text separates them.
//   - `refresh_token = CASE WHEN … THEN NULL ELSE refresh_token END`, already
//     the house idiom for conditional clears in admin.sql and anime_cache.sql,
//     so it is a shape a future author would reach for naturally.
func describeIndeterminate(expr string) string {
	e := strings.TrimSpace(expr)
	switch {
	case e == "":
		return "empty expression"
	case e[0] == '$' || e[0] == '@' || strings.HasPrefix(strings.ToLower(e), "sqlc.arg("):
		return "bound parameter — may be NULL at runtime"
	case strings.HasPrefix(strings.ToUpper(e), "CASE "):
		return "CASE expression — at least one branch may be NULL"
	default:
		return "expression this scan cannot evaluate"
	}
}

// findKeyword returns the index of kw appearing as a whole word, or -1.
//
// Whitespace boundaries are the whole point: these statements put SET and
// WHERE at the start of a line, so a naive search for " SET " misses every
// one of them and setAssignments quietly returns an empty map.  Every rule
// in this file then passes by examining nothing — the parser self-check test
// exists because that is what actually happened on the first run.
func findKeyword(s, kw string) int {
	upper := strings.ToUpper(s)
	kw = strings.ToUpper(kw)
	for from := 0; ; {
		i := strings.Index(upper[from:], kw)
		if i < 0 {
			return -1
		}
		i += from
		beforeOK := i == 0 || isSQLSpace(upper[i-1])
		after := i + len(kw)
		afterOK := after >= len(upper) || isSQLSpace(upper[after])
		if beforeOK && afterOK {
			return i
		}
		from = i + len(kw)
	}
}

func isSQLSpace(b byte) bool {
	return b == ' ' || b == '\t' || b == '\n' || b == '\r'
}

// findKeywordDepth0 is findKeyword restricted to text outside parentheses.
//
// The distinction is load-bearing, not tidiness: `role = (SELECT … WHERE …)`
// in a SET clause contains a WHERE that is not the statement's WHERE.
// Truncating there drops every assignment after it and reports the dropped
// columns as missing — a red that points at correct code.
func findKeywordDepth0(s, kw string) int {
	upper := strings.ToUpper(s)
	kwU := strings.ToUpper(kw)
	depth := 0
	for i := 0; i < len(upper); i++ {
		switch upper[i] {
		case '(':
			depth++
			continue
		case ')':
			depth--
			continue
		}
		if depth != 0 || !strings.HasPrefix(upper[i:], kwU) {
			continue
		}
		beforeOK := i == 0 || isSQLSpace(upper[i-1])
		after := i + len(kwU)
		afterOK := after >= len(upper) || isSQLSpace(upper[after])
		if beforeOK && afterOK {
			return i
		}
	}
	return -1
}

// splitTopLevel splits on sep, ignoring separators inside parentheses so a
// call like coalesce(a, b) stays one assignment.
func splitTopLevel(s string, sep rune) []string {
	var (
		parts []string
		cur   strings.Builder
		depth int
	)
	for _, r := range s {
		switch {
		case r == '(':
			depth++
		case r == ')':
			depth--
		case r == sep && depth == 0:
			parts = append(parts, cur.String())
			cur.Reset()
			continue
		}
		cur.WriteRune(r)
	}
	if strings.TrimSpace(cur.String()) != "" {
		parts = append(parts, cur.String())
	}
	return parts
}

// loadStatements parses every .sql file under queries/ into named blocks.
func loadStatements(t *testing.T) []sqlStatement {
	t.Helper()

	files, err := filepath.Glob(filepath.Join("queries", "*.sql"))
	if err != nil {
		t.Fatalf("glob queries/*.sql: %v", err)
	}
	if len(files) == 0 {
		// A rename or a move that silently empties this scan would make the
		// whole file a no-op that reports success.  Fail loudly instead.
		t.Fatal("no .sql files found under queries/ — this scan would pass vacuously")
	}
	sort.Strings(files)

	var stmts []sqlStatement
	for _, f := range files {
		raw, err := os.ReadFile(f)
		if err != nil {
			t.Fatalf("read %s: %v", f, err)
		}

		var cur *sqlStatement
		var sql strings.Builder
		flush := func() {
			if cur != nil {
				cur.body = sql.String()
				stmts = append(stmts, *cur)
			}
			sql.Reset()
		}

		for i, line := range strings.Split(string(raw), "\n") {
			trimmed := strings.TrimSpace(line)
			if name, ok := parseNameMarker(trimmed); ok {
				flush()
				cur = &sqlStatement{name: name, file: f, line: i + 1}
				continue
			}
			if strings.HasPrefix(trimmed, "--") {
				continue // doc comment, not SQL
			}
			if cur != nil {
				sql.WriteString(line)
				sql.WriteString("\n")
			}
		}
		flush()
	}
	return stmts
}

// parseNameMarker recognises `-- name: Foo :exec` and returns "Foo".
func parseNameMarker(trimmed string) (string, bool) {
	const marker = "-- name:"
	if !strings.HasPrefix(trimmed, marker) {
		return "", false
	}
	fields := strings.Fields(strings.TrimPrefix(trimmed, marker))
	if len(fields) == 0 {
		return "", false
	}
	return fields[0], true
}

// TestSessionColumns_KillSwitchClearsAllThree is the core rule: a statement
// that NULLs refresh_token has declared "this session is over", so it must
// also NULL the grace slot and its clock.
func TestSessionColumns_KillSwitchClearsAllThree(t *testing.T) {
	t.Parallel()

	for _, stmt := range loadStatements(t) {
		p := stmt.setAssignments()
		if !assertReadable(t, stmt, p) {
			continue
		}
		if p.status != parseOK {
			continue
		}
		if !strings.EqualFold(p.sets[colRefreshToken], "NULL") {
			continue // not a literal revocation; the bound-param case is rule (d)
		}

		for _, col := range []string{colPreviousRefresh, colRefreshRotatedAt} {
			got, present := p.sets[col]
			if !present {
				t.Errorf(
					"%s:%d %s sets %s = NULL but never writes %s.\n"+
						"  A revoked refresh token stays usable for the rest of the 30s grace window,\n"+
						"  because the Refresh handler falls back to previous_refresh_token.\n"+
						"  Add `%s = NULL` to the SET clause.",
					stmt.file, stmt.line, stmt.name, colRefreshToken, col, col)
				continue
			}
			if !strings.EqualFold(got, "NULL") {
				t.Errorf(
					"%s:%d %s sets %s = NULL but %s = %q (want NULL).\n"+
						"  Leaving a live value here re-arms the grace window the revocation just tried to close.",
					stmt.file, stmt.line, stmt.name, colRefreshToken, col, got)
			}
		}
	}
}

// assertReadable fails the calling rule when a statement touches a session
// column in a shape the parser cannot read, and reports whether the caller
// should keep going.
//
// This is the single most valuable line of defence in the file. Without it,
// every rule below silently skips what it cannot parse — so the way to defeat
// the whole scan is to write the next kill switch as a CTE, which is already
// this codebase's house style for anything that also records an activity row.
func assertReadable(t *testing.T, stmt sqlStatement, p setParse) bool {
	t.Helper()
	if p.status != parseUnsupported {
		return true
	}
	if !stmt.mentionsSessionColumn() {
		return false // unreadable but irrelevant — e.g. ApplyHantTitleBatch
	}
	t.Errorf(
		"%s:%d %s touches a refresh-session column in a shape this scan cannot read (%s).\n"+
			"  The scan has NOT checked it — this is a gap, not a pass.\n"+
			"  Either rewrite the statement as a plain UPDATE, or teach setAssignments\n"+
			"  this shape and add a case to TestSessionColumns_ParserSeesTheRealFile.",
		stmt.file, stmt.line, stmt.name, p.reason)
	return false
}

// TestSessionColumns_GraceSlotHasAClock is the mirror rule: loading the grace
// slot must stamp a live clock for it to be judged against.
//
// It checks the VALUE, not merely that the column appears. Requiring only
// presence let `previous_refresh_token = refresh_token, refresh_rotated_at =
// NULL` through — which is RotateRefreshToken's own documented bug regressing.
// That one fails closed rather than open (the grace branch requires
// RefreshRotatedAt.Valid, so it 401s instead of over-honouring), but 401-ing
// the loser of a concurrent refresh is precisely the outcome the grace window
// exists to prevent, so a silently disabled window is not an acceptable pass.
func TestSessionColumns_GraceSlotHasAClock(t *testing.T) {
	t.Parallel()

	for _, stmt := range loadStatements(t) {
		p := stmt.setAssignments()
		if !assertReadable(t, stmt, p) || p.status != parseOK {
			continue
		}
		prev, writesPrev := p.sets[colPreviousRefresh]
		if !writesPrev || strings.EqualFold(prev, "NULL") {
			continue // clearing is covered by the rule above
		}
		clock, ok := p.sets[colRefreshRotatedAt]
		if !ok {
			t.Errorf(
				"%s:%d %s loads %s = %q without writing %s.\n"+
					"  The grace window is judged by time.Since(refresh_rotated_at); a grace token\n"+
					"  whose clock was set by some earlier statement is honored for an arbitrary duration.",
				stmt.file, stmt.line, stmt.name, colPreviousRefresh, prev, colRefreshRotatedAt)
			continue
		}
		if strings.EqualFold(clock, "NULL") {
			t.Errorf(
				"%s:%d %s loads %s = %q but sets %s = NULL.\n"+
					"  A grace slot with no clock is never honored: the handler requires\n"+
					"  RefreshRotatedAt.Valid, so this silently disables the 30s window and 401s\n"+
					"  whichever concurrent refresh lost the race.",
				stmt.file, stmt.line, stmt.name, colPreviousRefresh, prev, colRefreshRotatedAt)
		}
	}
}

// TestSessionColumns_IndeterminateWritesAreDeclared closes the blind spot
// neither consistency rule can see: a write to refresh_token whose value the
// text does not reveal.
//
// The rule above fires only on a literal NULL, so ANY other way of writing
// NULL slips past it — a bound parameter, a CASE, a coalesce, a function. The
// fix is not a smarter expression evaluator; that race cannot be won against
// SQL. It is to invert the burden: every write this scan cannot prove is a
// live token must be listed by a human, with the reason.
//
// Two statements are listed. Both are safe for the same structural reason —
// they write the other two columns unconditionally in the same statement — so
// whatever the parameter holds at runtime, the three columns cannot disagree.
// That is the bar a third entry has to clear.
func TestSessionColumns_IndeterminateWritesAreDeclared(t *testing.T) {
	t.Parallel()

	declared := map[string]string{
		"UpdateUserRefreshToken": "login passes a token, logout passes nil; both paths NULL the grace slot in the same statement",
		"RotateRefreshToken":     "rotation always writes a live token and re-stamps the clock; the CAS predicate is pinned in test/integration",
	}

	for _, stmt := range loadStatements(t) {
		p := stmt.setAssignments()
		if !assertReadable(t, stmt, p) || p.status != parseOK {
			continue
		}
		expr, writes := p.sets[colRefreshToken]
		if !writes || isLiteralNull(expr) {
			continue // literal NULL is judged by the kill-switch rule
		}
		if _, ok := declared[stmt.name]; ok {
			continue
		}
		t.Errorf(
			"%s:%d %s writes %s = %s (%s).\n"+
				"  This scan cannot tell whether that is a live token or a revocation, so the\n"+
				"  kill-switch rule did NOT check it. If the value can ever be NULL, the statement\n"+
				"  ends a session and must clear previous_refresh_token and refresh_rotated_at too.\n"+
				"  Add it to `declared` here with the reason it is safe.",
			stmt.file, stmt.line, stmt.name, colRefreshToken, expr, describeIndeterminate(expr))
	}
}

// TestSessionColumns_RequiredKillSwitchesStillRevoke catches the failure the
// consistency rules structurally cannot: a statement dropping its revocation
// entirely stays perfectly self-consistent while silently keeping sessions
// alive through a password change.
func TestSessionColumns_RequiredKillSwitchesStillRevoke(t *testing.T) {
	t.Parallel()

	byName := make(map[string]sqlStatement)
	for _, stmt := range loadStatements(t) {
		byName[stmt.name] = stmt
	}

	for name, why := range mustKillSession {
		stmt, ok := byName[name]
		if !ok {
			t.Errorf("query %q not found in queries/*.sql — it is listed as a session kill-switch (%s).\n"+
				"  If it was renamed, update mustKillSession; if it was deleted, say why in the commit.", name, why)
			continue
		}

		p := stmt.setAssignments()
		if p.status != parseOK {
			// Distinguished deliberately. Reporting `got ""` for a statement
			// the parser could not read is the same message as a genuinely
			// missing column, and sends the reader looking for a bug in SQL
			// that may be perfectly correct.
			t.Errorf("%s:%d %s is a declared kill switch but the scan could not read its SET clause (%s).\n"+
				"  No column verdict was computed — this is a scan gap, not a SQL defect.",
				stmt.file, stmt.line, name, p.reason)
			continue
		}
		for _, col := range []string{colPreviousRefresh, colRefreshRotatedAt} {
			if got, ok := p.sets[col]; !ok || !strings.EqualFold(got, "NULL") {
				t.Errorf("%s:%d %s must clear %s (%s), got %q",
					stmt.file, stmt.line, name, col, why, got)
			}
		}
	}
}

// TestSessionColumns_ParserSeesTheRealFile guards the scan itself.  A parser
// that silently matches nothing turns every rule above into a test that passes
// without checking anything — the failure mode where the suite is green
// precisely because it went blind.  That is not hypothetical: the first run of
// this file was green on two rules because `SET` sits at the start of a line
// and the parser was looking for `" SET "` with a leading space.
func TestSessionColumns_ParserSeesTheRealFile(t *testing.T) {
	t.Parallel()

	stmts := loadStatements(t)

	// Floors, not smoke tests.  The corpus is ~174 statements of which ~34 are
	// readable UPDATEs; the earlier `< 20` bound would have been satisfied by
	// 154 of them vanishing.  Both numbers are deliberately a little below the
	// real count so ordinary additions do not trip them, and far enough above
	// zero that a broken glob or marker format cannot pass.
	if len(stmts) < 150 {
		t.Fatalf("parsed only %d statements from queries/*.sql (expected ~174); "+
			"the glob or the `-- name:` marker format likely changed", len(stmts))
	}

	// The marker count above measures the CHEAP half of the parser. This
	// measures the fragile half: if setAssignments regresses, the count of
	// statements it can actually read collapses while the marker count stays
	// put, and every rule goes quiet without a single failure.
	readable := 0
	for _, s := range stmts {
		if s.setAssignments().status == parseOK {
			readable++
		}
	}
	if readable < 25 {
		t.Fatalf("setAssignments could read only %d SET clauses (expected ~34); "+
			"the rules above are running against almost nothing", readable)
	}

	// RotateRefreshToken is the sharpest case in the tree: it mentions
	// refresh_token in both the SET clause and the WHERE clause, with
	// different meanings.  If the parser ever conflates them, this fails.
	var rotate *sqlStatement
	for i := range stmts {
		if stmts[i].name == "RotateRefreshToken" {
			rotate = &stmts[i]
			break
		}
	}
	if rotate == nil {
		t.Fatal("RotateRefreshToken not found; the parser self-check has nothing to verify against")
	}

	p := rotate.setAssignments()
	if p.status != parseOK {
		t.Fatalf("RotateRefreshToken did not parse (%s); the self-check has nothing to verify", p.reason)
	}
	if got := p.sets[colPreviousRefresh]; got != colRefreshToken {
		t.Errorf("RotateRefreshToken SET %s = %q, want %q — parser is misreading the SET clause",
			colPreviousRefresh, got, colRefreshToken)
	}
	if got, ok := p.sets[colRefreshToken]; !ok || strings.EqualFold(got, "NULL") {
		t.Errorf("RotateRefreshToken SET %s = %q; a rotation writes a new token, never NULL — "+
			"parser is probably reading the WHERE clause", colRefreshToken, got)
	}
	if _, leaked := p.sets["id"]; leaked {
		t.Error("parser pulled `id` out of the WHERE clause into the SET map; the truncation is broken")
	}

	// A subquery in the SET clause must not truncate the clause at ITS where.
	// Synthetic rather than drawn from the corpus because no statement has this
	// shape today — which is exactly why the parser regressed here unnoticed
	// until someone injected one.
	sub := sqlStatement{name: "synthetic", file: "synthetic", body: `
UPDATE users
SET role                   = (SELECT role FROM users u2 WHERE u2.id = $1),
    refresh_token          = NULL,
    previous_refresh_token = NULL,
    refresh_rotated_at     = NULL
WHERE id = $1;`}
	sp := sub.setAssignments()
	if sp.status != parseOK {
		t.Fatalf("a SET clause containing a subquery must parse, got %v (%s)", sp.status, sp.reason)
	}
	for _, col := range []string{colRefreshToken, colPreviousRefresh, colRefreshRotatedAt} {
		if got, ok := sp.sets[col]; !ok || !strings.EqualFold(got, "NULL") {
			t.Errorf("subquery case: %s = %q (present=%v); truncating at the SUBQUERY's WHERE "+
				"drops every later assignment and produces a red that points at correct SQL",
				col, got, ok)
		}
	}

	// The two shapes the scan refuses to guess at must report themselves as
	// unsupported rather than as "nothing to check".
	for _, tc := range []struct{ name, body string }{
		{"cte", "WITH logged AS (INSERT INTO activity_events (kind) VALUES ('x') RETURNING 1)\n" +
			"UPDATE users SET refresh_token = NULL WHERE id = $1;"},
		{"update-from", "UPDATE users SET refresh_token = v.tok FROM (SELECT unnest($1::text[]) AS tok) AS v WHERE id = $2;"},
	} {
		got := sqlStatement{name: tc.name, body: tc.body}.setAssignments()
		if got.status != parseUnsupported {
			t.Errorf("%s: status = %v, want parseUnsupported — an unreadable write must be loud, "+
				"not silently skipped", tc.name, got.status)
		}
	}
}
