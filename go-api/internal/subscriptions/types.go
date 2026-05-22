// Package subscriptions owns the /api/subscriptions/* HTTP handlers —
// the five-endpoint surface ported from
// server/controllers/subscription.controller.js + routes/subscription.routes.js.
//
// Endpoints (all behind jwtx.RequireAuth in production wiring):
//
//	GET    /api/subscriptions               → ListSubscriptions
//	GET    /api/subscriptions/:anilistId    → GetSubscription
//	POST   /api/subscriptions               → CreateSubscription
//	PATCH  /api/subscriptions/:anilistId    → UpdateSubscription
//	DELETE /api/subscriptions/:anilistId    → DeleteSubscription
//
// Responses follow the canonical httpx envelope (English messages —
// the frontend i18n layer maps each English string to a localized
// translation, keyed on the English text; see /tmp/i18n-contract.md).
//
// types.go declares the request body shapes + the list-item response
// projection that merges subscription columns with the joined
// anime_cache columns returned by ListUserSubscriptions.
package subscriptions

import (
	"github.com/jackc/pgx/v5/pgtype"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// createSubscriptionReq is the POST /api/subscriptions body shape.
//
// Validation drives the express-validator rules from
// routes/subscription.routes.js:
//
//   - anilistId: int >= 1
//   - status:    one of {watching, completed, plan_to_watch, dropped}
//
// We use go-playground/validator/v10 tags but the per-field error
// messages are mapped manually in validate.go so they exactly match
// the Express messages the frontend i18n layer expects.
type createSubscriptionReq struct {
	AnilistID int32  `json:"anilistId" validate:"required,gte=1"`
	Status    string `json:"status"    validate:"required,oneof=watching completed plan_to_watch dropped"`
}

// updateSubscriptionReq is the PATCH /api/subscriptions/:anilistId body
// shape.  All fields are optional — Express explicitly does not require
// any of them; an empty body returns the row unchanged.
//
// scorePresent discriminates between absent (`{}`) and explicit null
// (`{"score":null}` — Express semantics: clear the column).  It is NOT
// JSON-tagged; the handler populates it after detecting key presence
// in a raw map[string]json.RawMessage pre-pass before binding the
// typed struct.  See parseUpdateBody in handlers.go.
type updateSubscriptionReq struct {
	Status         *string `json:"status,omitempty"         validate:"omitempty,oneof=watching completed plan_to_watch dropped"`
	CurrentEpisode *int32  `json:"currentEpisode,omitempty" validate:"omitempty,gte=0"`
	Score          *int32  `json:"score,omitempty"`
	scorePresent   bool    `json:"-"`
}

// listItem is the merged subscription + anime_cache projection returned
// by GET /api/subscriptions.
//
// Express built this shape via:
//
//	{ ...animeMap[s.anilistId]?.toObject(), subscriptionId, status, ... }
//
// — the anime fields come first, then subscription fields override /
// extend.  We preserve that field-emission order so the byte-diff at
// cutover stays clean.
//
// subscriptionId is emitted as JSON `null` because Postgres has no
// separate row id (composite PK is (user_id, anilist_id)); the frontend
// historically accessed `.subscriptionId` on Mongo's `_id`, so we keep
// the key with a `null` value to avoid undefined-access errors at the
// component layer.  Documented also in handlers.go where the response
// is built.
type listItem struct {
	// Anime fields (LEFT JOIN — all nullable when anime_cache row is
	// missing; ON DELETE CASCADE makes this rare but defensive).
	AnilistID       int32   `json:"anilistId"`
	TitleRomaji     *string `json:"titleRomaji"`
	TitleEnglish    *string `json:"titleEnglish"`
	TitleNative     *string `json:"titleNative"`
	TitleChinese    *string `json:"titleChinese"`
	CoverImageURL   *string `json:"coverImageUrl"`
	CoverImageColor *string `json:"coverImageColor"`
	PosterAccent    *string `json:"posterAccent"`
	Episodes        *int32  `json:"episodes"`
	Season          *string `json:"season"`
	SeasonYear      *int32  `json:"seasonYear"`
	Format          *string `json:"format"`
	AnimeStatus     *string `json:"animeStatus"`

	// Subscription fields.  SubscriptionID is `null` for byte-compat
	// with the legacy Mongo-shaped FE — see package doc above.
	SubscriptionID any                `json:"subscriptionId"`
	Status         string             `json:"status"`
	CurrentEpisode int32              `json:"currentEpisode"`
	Score          *int32             `json:"score"`
	LastWatchedAt  pgtype.Timestamptz `json:"lastWatchedAt"`
	SubscribedAt   pgtype.Timestamptz `json:"subscribedAt"`
}

// toListItem flattens a ListUserSubscriptionsRow into the response
// projection.  Centralised here so handlers.go stays readable and the
// "subscriptionId is null by design" decision lives next to the type
// definition.
func toListItem(row dbgen.ListUserSubscriptionsRow) listItem {
	return listItem{
		AnilistID:       row.AnilistID,
		TitleRomaji:     row.TitleRomaji,
		TitleEnglish:    row.TitleEnglish,
		TitleNative:     row.TitleNative,
		TitleChinese:    row.TitleChinese,
		CoverImageURL:   row.CoverImageUrl,
		CoverImageColor: row.CoverImageColor,
		PosterAccent:    row.PosterAccent,
		Episodes:        row.Episodes,
		Season:          row.Season,
		SeasonYear:      row.SeasonYear,
		Format:          row.Format,
		AnimeStatus:     row.AnimeStatus,

		SubscriptionID: nil,
		Status:         row.Status,
		CurrentEpisode: row.CurrentEpisode,
		Score:          row.Score,
		LastWatchedAt:  row.LastWatchedAt,
		SubscribedAt:   row.SubscribedAt,
	}
}

// deleteResp is the success body for DELETE /api/subscriptions/:anilistId.
// Express returned `{ message: '已删除' }`; we emit English "Deleted" and
// the FE i18n layer maps it back to 已删除 via the dictionary entry.
type deleteResp struct {
	Message string `json:"message"`
}
