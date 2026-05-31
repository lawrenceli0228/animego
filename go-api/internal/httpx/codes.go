// Package httpx is the HTTP envelope + error helper layer shared by every
// chi handler in go-api.
//
// The envelope shape is byte-compatible with the Express server
// (server/controllers/*.js).  Any handler that uses these helpers will
// produce JSON that survives Phase 8.5 shadow-traffic diff against the
// existing Express prod responses.
//
// Three helpers cover all responses:
//
//	httpx.Data(w, 200, payload)        // {"data":{...}}
//	httpx.Page(w, 200, items, p)       // {"data":[...],"total":..,"page":..,"hasMore":..,"nextPage":..}
//	httpx.Fail(w, httpx.NewError(...)) // {"error":{"code":"...","message":"..."}}
//
// See docs/migration/P2.0-DESIGN.md § 1 for the full Express contract.
package httpx

// The fourteen error codes below are the complete set used by the Express
// backend.  Discovered via `grep -h "code: '" server/{controllers,middleware,services}/*.js`.
// Adding a new code requires a design-doc update — handlers must not invent
// codes locally.
const (
	CodeBadRequest         = "BAD_REQUEST"         // 400 — non-validator parameter problem
	CodeValidationError    = "VALIDATION_ERROR"    // 400 — validator output
	CodeInvalidAction      = "INVALID_ACTION"      // 400 — business rule violation
	CodeInvalidCredentials = "INVALID_CREDENTIALS" // 401 — wrong password
	CodeNoToken            = "NO_TOKEN"            // 401 — Authorization header missing
	CodeInvalidToken       = "INVALID_TOKEN"       // 401 — JWT decode failed
	CodeTokenExpired       = "TOKEN_EXPIRED"       // 401 — JWT exp < now
	CodeUnauthorized       = "UNAUTHORIZED"        // 401 — generic auth failure
	CodeForbidden          = "FORBIDDEN"           // 403 — role / permission denied
	CodeNotFound           = "NOT_FOUND"           // 404 — resource missing
	CodeConflict           = "CONFLICT"            // 409 — business conflict
	CodeDuplicate          = "DUPLICATE_ERROR"     // 409 — unique constraint
	CodeTooManyRequests    = "TOO_MANY_REQUESTS"   // 429 — rate limit
	CodeServerError        = "SERVER_ERROR"        // 500 — unclassified
)
