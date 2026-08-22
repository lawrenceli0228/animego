// Package subscriptions owns the /api/subscriptions/* HTTP handlers —
// the five-endpoint surface ported from
// server/controllers/subscription.controller.js + routes/subscription.routes.js.
//
// Endpoints (all behind jwtx.RequireAuth in production wiring):
//
//	GET    /api/subscriptions                            → ListSubscriptions
//	GET    /api/subscriptions/:anilistId                 → GetSubscription
//	POST   /api/subscriptions                            → CreateSubscription
//	PATCH  /api/subscriptions/:anilistId                 → UpdateSubscription
//	DELETE /api/subscriptions/:anilistId                 → DeleteSubscription
//	PUT    /api/subscriptions/:anilistId/episodes        → MarkEpisodesWatched
//	PUT    /api/subscriptions/:anilistId/episodes/:ep    → MarkEpisodeWatched
//	DELETE /api/subscriptions/:anilistId/episodes/:ep    → UnmarkEpisodeWatched
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
	"encoding/json"

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
//
// IfAbsent opts into the idempotent creation path (§4 decision 3): when
// true the handler runs InsertSubscriptionIfAbsent, which leaves an
// existing row — including a `dropped` or `completed` status the user set
// by hand — exactly as it found it.  Absent or false keeps the historical
// UpsertSubscription behaviour byte-for-byte, so the "Subscribe" button
// and every existing caller are unaffected.  A plain bool is enough
// because there is no tri-state here: absent and false mean the same
// thing, unlike updateSubscriptionReq.Score.
type createSubscriptionReq struct {
	AnilistID int32  `json:"anilistId" validate:"required,gte=1"`
	Status    string `json:"status"    validate:"required,oneof=watching completed plan_to_watch dropped"`
	IfAbsent  bool   `json:"ifAbsent,omitempty"`
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
//
// Monotonic no longer selects the progress semantics.  Since migration
// 0024 current_episode is COALESCE(MAX(episode), 0) over episode_watches
// on every path, so no PATCH can lower it whatever this flag says: the
// forward-only guarantee is structural now, not a branch a caller opts
// into (and therefore not one a caller can forget).
//
// Its single remaining reader is the updated_at suppression in
// UpdateSubscriptionWithActivity: a monotonic push that changes nothing
// leaves updated_at alone, so a replay does not jump an untouched show to
// the front of the home page's continue-watching row.
//
// It is kept in the request body rather than removed in the same change
// that demoted it, so the library reconciler (the only sender) keeps
// working untouched and the removal can be judged on its own.
//
// Absent, null, and false all mean false.  Unlike Score there is no
// meaningful third state, so a plain bool beats a *bool here.
type updateSubscriptionReq struct {
	Status         *string `json:"status,omitempty"         validate:"omitempty,oneof=watching completed plan_to_watch dropped"`
	CurrentEpisode *int32  `json:"currentEpisode,omitempty" validate:"omitempty,gte=0"`
	Score          *int32  `json:"score,omitempty"`
	Monotonic      bool    `json:"monotonic,omitempty"`
	scorePresent   bool    `json:"-"`
}

// markEpisodesReq is the PUT /api/subscriptions/:anilistId/episodes body:
//
//	{"episodes": [3, 5, 7, 8, 9]}
//
// The pointer distinguishes an absent key from an explicit empty array.
// Both are refused, and they are refused for the caller's benefit: `{}` is
// a caller that forgot the field, `{"episodes":[]}` is one that computed an
// empty delta and sent it anyway.  Neither has anything to write, and
// answering 200 to either would hide the bug behind a successful-looking
// no-op.
//
// []json.RawMessage, not []int32, and that is the load-bearing choice.
// Binding straight to int32 hands the bounds check to encoding/json, which
// refuses 4294967297 with its own stock English and cannot distinguish it
// from a malformed body.  Keeping each member as its raw token lets every
// one of them go through strconv.ParseInt(.., 10, 32) — the exact call
// parseEpisode makes for the single-episode route, including its ErrRange
// answer to a value that would wrap on a careless cast — so the two routes
// enforce one rule rather than two rules that happen to agree today.
//
// json.Number was the obvious alternative and is subtly wrong here: it
// accepts a QUOTED number, so `{"episodes":["3"]}` would be silently read
// as episode 3 while `{"episodes":["abc"]}` failed as a malformed body.
// One rule answered two ways depending on whether the garbage happened to
// look numeric.  A raw token is uninterpreted until validateEpisodeList
// interprets it, so a member is a JSON integer in range or it is refused,
// with one message.
//
// No `validate` tags for the same reason: every rule here is about the
// contents of the slice, and go-playground's dive would emit stock messages
// for a field the frontend dictionary has never seen.
type markEpisodesReq struct {
	Episodes *[]json.RawMessage `json:"episodes"`
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
	TitleHant       *string `json:"titleHant"`
	TitleHantSource *string `json:"titleHantSource"`
	TitleHantSeo    *string `json:"titleHantSeo"`
	CoverImageURL   *string `json:"coverImageUrl"`
	BannerImageURL  *string `json:"bannerImageUrl"`
	CoverImageColor *string `json:"coverImageColor"`
	PosterAccent    *string `json:"posterAccent"`
	Episodes        *int32  `json:"episodes"`
	// Inferred episode total (anime_cache.episodes_bgm, migration 0023).
	// Separate from Episodes and never merged into it — the card may draw a
	// fraction and a bar from a guess, but only Episodes is a fact.
	EpisodesBgm *int32  `json:"episodesBgm"`
	Season      *string `json:"season"`
	SeasonYear  *int32  `json:"seasonYear"`
	Format      *string `json:"format"`
	AnimeStatus *string `json:"animeStatus"`

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
		TitleHant:       row.TitleHant,
		TitleHantSource: row.TitleHantSource,
		TitleHantSeo:    row.TitleHantSeo,
		CoverImageURL:   row.CoverImageUrl,
		BannerImageURL:  row.BannerImageUrl,
		CoverImageColor: row.CoverImageColor,
		PosterAccent:    row.PosterAccent,
		Episodes:        row.Episodes,
		EpisodesBgm:     row.EpisodesBgm,
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

// episodeWatchResp is the success body for ALL THREE watch-mark writes:
//
//	PUT    /api/subscriptions/:anilistId/episodes
//	PUT    /api/subscriptions/:anilistId/episodes/:episode
//	DELETE /api/subscriptions/:anilistId/episodes/:episode
//
// One type for all of them because the client's job after any of them is
// the same: replace its whole idea of this anime's progress with what came
// back.  Returning the full post-write set (rather than an acknowledgement
// of the single episode that changed) is what lets a grid of thirty
// checkboxes reconcile from one response, with no follow-up read and no
// client-side guess at what the server did.
//
// AnilistID is echoed so a response arriving out of order — the user
// clicked three boxes on two different titles — can be matched to the
// title it describes rather than assumed to be about whatever is on
// screen.  It is the parsed path value, not anything the body supplied.
//
// WatchedEpisodes is always an array, never null; see nonNilEpisodes.
// CurrentEpisode is the value the statement actually stored, read back
// from the UPDATE's RETURNING rather than recomputed here, so the number
// the client draws is the number the row holds.
type episodeWatchResp struct {
	AnilistID       int32   `json:"anilistId"`
	WatchedEpisodes []int32 `json:"watchedEpisodes"`
	CurrentEpisode  int32   `json:"currentEpisode"`
}

// nonNilEpisodes converts a nil slice to an empty one so the JSON emits
// `[]` rather than `null`.
//
// The SQL already COALESCEs an empty aggregate to '{}', so this should
// never fire — but "watchedEpisodes is an array" is a contract the client
// iterates over directly, and a contract that holds only because of how a
// driver happens to decode a zero-length array is one bad upgrade away
// from a TypeError in the grid.  Cheap enough to just guarantee.
func nonNilEpisodes(in []int32) []int32 {
	if in == nil {
		return []int32{}
	}
	return in
}

// deleteResp is the success body for DELETE /api/subscriptions/:anilistId.
// Express returned `{ message: '已删除' }`; we emit English "Deleted" and
// the FE i18n layer maps it back to 已删除 via the dictionary entry.
type deleteResp struct {
	Message string `json:"message"`
}
