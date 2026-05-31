// Package comments owns the /api/comments/* HTTP handlers — the
// flat-list episode discussion endpoints ported from
// server/controllers/comment.controller.js.
//
// Three endpoints back this surface (Phase 2.5.1):
//
//	GET    /api/comments/:anilistId/:episode  — ListComments  (public)
//	POST   /api/comments/:anilistId/:episode  — AddComment    (auth required)
//	DELETE /api/comments/:id                  — DeleteComment (auth required, own-row check)
//
// The handler layer talks to Postgres exclusively through the sqlc
// CommentsDB interface defined in handlers.go; tests inject fakes via
// the same interface so the DB-error paths can be exercised without a
// live container.
package comments

// validate.go — English message constants + the content-length helper.
//
// All messages here are emitted verbatim to the client.  The frontend
// i18n layer (zh.js) maps each English string to a localized
// translation keyed on the English text — see /tmp/i18n-contract.md.
//
// Express's controller already used English ("Content is required",
// etc.), so the values below are byte-identical to what the FE expects
// at the cutover point.

import "unicode/utf8"

// User-facing English messages.  Exact strings (case + spacing) must
// match Express so the shadow-traffic diff at cutover passes.  Adding
// a new message here also requires a regression test that asserts the
// literal string.
const (
	msgInvalidParams   = "Invalid params"
	msgContentRequired = "Content is required"
	msgContentTooLong  = "Content too long"
	msgParentNotFound  = "Parent comment not found"
	msgCommentNotFound = "Comment not found"
	msgNotYourComment  = "Not your comment"
	msgLoginAgain      = "Please log in again"
)

// maxContentRunes caps the content payload at 500 Unicode code points
// (runes).  This matches the Postgres CHECK constraint
// `char_length(content) <= 500` exactly — Postgres's char_length
// counts grapheme code points the same way utf8.RuneCountInString does.
//
// Counting runes (not bytes, not UTF-16 code units) avoids two failure
// modes:
//   - Byte counting:  emoji (4-byte UTF-8) would trip the 500-limit at
//     ~125 visible characters — surprises Chinese / emoji-heavy users.
//   - UTF-16 counting (what Express's `String.length` does):  surrogate
//     pairs count as 2, which is closer to the DB limit but still
//     diverges on extended-plane characters.
//
// We intentionally deviate from Express here: Express used
// `content.trim().length` (UTF-16 code units).  Aligning with the DB
// CHECK means a payload that passes our 500-rune validator can never
// fail the DB CHECK later — friendlier error than a 500 from a constraint
// violation, and the per-character semantics matches what most users
// expect from a 500-character limit.
const maxContentRunes = 500

// contentRuneCount returns the rune count of s — equivalent to
// utf8.RuneCountInString but extracted into a named function so test
// coverage hangs on the helper rather than the inline call site.
func contentRuneCount(s string) int {
	return utf8.RuneCountInString(s)
}
