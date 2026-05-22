package subscriptions

// validate.go — validator error → English message mapping.
//
// go-playground/validator/v10 emits library-stock English messages that
// are unstable across upgrades and not friendly to the frontend i18n
// layer.  We translate the first FieldError on a request struct into
// the stable English string the FE dictionary expects.
//
// The strings here mirror routes/subscription.routes.js's three rules:
//
//	body('anilistId').isInt({ min: 1 }).withMessage('无效的番剧 ID')
//	body('status').isIn([...]).withMessage('无效的状态')
//	body('currentEpisode').isInt({ min: 0 }).withMessage('集数必须为非负整数')
//
// Translated to English (FE zh.js maps each English string back to 中文):
//
//	"Invalid anime ID"
//	"Invalid status"
//	"Episode must be a non-negative integer"
//
// Score is NOT validated via struct tags — Express clamps silently to
// [1,10] and accepts `null` to clear.  See parseUpdateBody in handlers.go.

import (
	"errors"

	"github.com/go-playground/validator/v10"
)

// User-facing messages.  Emitted in English; FE zh.js maps each string
// to a localized translation keyed on the English text.
const (
	msgInvalidAnimeID        = "Invalid anime ID"
	msgInvalidStatus         = "Invalid status"
	msgInvalidEpisode        = "Episode must be a non-negative integer"
	msgInvalidRequestBody    = "Invalid request body"
	msgSubscriptionNotFound  = "Subscription not found"
	msgAnimeNotFound         = "Anime not found"
	msgDeletedSuccessMessage = "Deleted"
)

// validationMessage maps the FIRST validator FieldError to an English
// message.  Falls back to msgInvalidRequestBody for unmapped field/tag
// combos so we never leak the stock library English at the API surface.
//
// Field names are the Go struct field names (PascalCase), NOT the JSON
// tags.  The mapping is one-to-one with createSubscriptionReq /
// updateSubscriptionReq.
func validationMessage(err error) string {
	var verrs validator.ValidationErrors
	if !errors.As(err, &verrs) || len(verrs) == 0 {
		return msgInvalidRequestBody
	}
	first := verrs[0]
	switch first.Field() {
	case "AnilistID":
		// required + gte=1 both surface for the create payload.
		return msgInvalidAnimeID
	case "Status":
		// required + oneof both surface for create + update payloads.
		return msgInvalidStatus
	case "CurrentEpisode":
		// gte=0 surfaces when a negative integer is supplied.
		return msgInvalidEpisode
	}
	return msgInvalidRequestBody
}

// clampScore mirrors Express's `Math.min(10, Math.max(1, Math.round(score)))`.
// nil in → nil out (explicit-null clears the column).  Otherwise the
// pointer is bounded to [1,10].
//
// The DB constraint already enforces the same range, but clamping in
// application code keeps the byte-exact Express behaviour: a caller
// sending score=15 sees the row stored at 10, not a 400 error.
func clampScore(in *int32) *int32 {
	if in == nil {
		return nil
	}
	v := *in
	if v > 10 {
		v = 10
	}
	if v < 1 {
		v = 1
	}
	return &v
}
