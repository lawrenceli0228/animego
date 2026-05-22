// Package social owns the /api/users/:username/* and /api/feed HTTP
// handlers — public profile, follow CRUD, follower / following lists,
// and the activity feed.
//
// Five endpoints back this surface (Phase 2.4.2):
//
//	GET    /api/users/:username                    — getProfile  (optional auth)
//	POST   /api/users/:username/follow             — follow      (auth required)
//	DELETE /api/users/:username/follow             — unfollow    (auth required)
//	GET    /api/users/:username/followers          — followers   (public, paginated)
//	GET    /api/users/:username/following          — following   (public, paginated)
//	GET    /api/feed                                — feed        (auth required)
//
// None of these endpoints fetches data from AniList or any other
// external service; they're pure Postgres reads/writes through the
// sqlc-generated layer in internal/db/gen.
package social

import (
	"github.com/jackc/pgx/v5/pgtype"
)

// profileResponse is the JSON shape for GET /api/users/:username.
//
// Express envelope (server/controllers/profile.controller.js:36-45):
//
//	{
//	  "data": {
//	    "username":       string,
//	    "createdAt":      ISO8601,
//	    "followerCount":  int,
//	    "followingCount": int,
//	    "isFollowing":    bool | null,     // null when caller is anon
//	    "watching":       [...watchingItem]
//	  }
//	}
//
// IsFollowing is a *bool with no omitempty tag so anon callers receive
// JSON `null` (Express emits `null` via `isFollowing !== null ? !!isFollowing : null`).
// Auth'd callers get true/false based on the FollowExists query.
type profileResponse struct {
	Username       string             `json:"username"`
	CreatedAt      pgtype.Timestamptz `json:"createdAt"`
	FollowerCount  int64              `json:"followerCount"`
	FollowingCount int64              `json:"followingCount"`
	IsFollowing    *bool              `json:"isFollowing"`
	Watching       []watchingItem     `json:"watching"`
}

// watchingItem is one entry in the profile's watching list.  Mirrors
// the Express projection (profile.controller.js:29-34) — the anime
// metadata fields come from anime_cache, the three subscription fields
// come from subscriptions.
//
// All anime metadata fields are nullable because ListProfileWatching
// LEFT JOINs anime_cache — a subscription pointing at an anime no
// longer in cache produces NULLs for everything except anilist_id.
//
// `subscriptionStatus` (not `status`) matches Express's spread pattern:
// the anime row may also have an anime.status column, so the
// subscription's status is renamed in the response to avoid collision.
type watchingItem struct {
	AnilistID          int32   `json:"anilistId"`
	TitleRomaji        *string `json:"titleRomaji"`
	TitleEnglish       *string `json:"titleEnglish"`
	TitleNative        *string `json:"titleNative"`
	TitleChinese       *string `json:"titleChinese"`
	CoverImageUrl      *string `json:"coverImageUrl"`
	CoverImageColor    *string `json:"coverImageColor"`
	PosterAccent       *string `json:"posterAccent"`
	Episodes           *int32  `json:"episodes"`
	Season             *string `json:"season"`
	SeasonYear         *int32  `json:"seasonYear"`
	Format             *string `json:"format"`
	// Anime's own status field (FINISHED / RELEASING / ...).  Kept
	// separate from subscriptionStatus to match Express's spread of
	// `...(animeMap[s.anilistId])` which preserves the anime.status
	// alongside the renamed subscriptionStatus below.
	Status             *string            `json:"status"`
	SubscriptionStatus string             `json:"subscriptionStatus"`
	CurrentEpisode     int32              `json:"currentEpisode"`
	LastWatchedAt      pgtype.Timestamptz `json:"lastWatchedAt"`
}

// followToggleResponse is the response body for follow / unfollow.
// Express emits `{ data: { following: true|false } }` so we mirror it
// via the standard httpx.Data envelope wrapping a single bool field.
type followToggleResponse struct {
	Following bool `json:"following"`
}

// followListItem is one entry in the followers / following responses.
// Express returns `{ username }` only (no _id / email PII — matches the
// .select() projection in follow.controller.js paginateFollows).
type followListItem struct {
	Username string `json:"username"`
}

// feedItem is one row in the GET /api/feed response.  Field naming
// mirrors Express byte-for-byte (profile.controller.js:85-94):
//
//	{
//	  "username":      string,    // s.userId.username
//	  "anilistId":     int,       // s.anilistId
//	  "title":         string,    // anime.titleRomaji || `Anime #${anilistId}`
//	  "titleChinese":  string|null,
//	  "coverImageUrl": string|null,
//	  "episode":       int,       // s.currentEpisode  (renamed from currentEpisode)
//	  "status":        string,    // s.status          (subscription status, not anime status)
//	  "lastWatchedAt": ISO8601
//	}
//
// TitleChinese and CoverImageUrl are *string (no omitempty) so absent
// fields emit JSON `null` matching Express's `|| null` fallback.
// Title is non-pointer because the handler always assigns it (either
// the real TitleRomaji or the `Anime #N` fallback).
type feedItem struct {
	Username      string             `json:"username"`
	AnilistID     int32              `json:"anilistId"`
	Title         string             `json:"title"`
	TitleChinese  *string            `json:"titleChinese"`
	CoverImageUrl *string            `json:"coverImageUrl"`
	Episode       int32              `json:"episode"`
	Status        string             `json:"status"`
	LastWatchedAt pgtype.Timestamptz `json:"lastWatchedAt"`
}

// feedResponse is the top-level envelope for GET /api/feed.
//
// Express shape: `{ data, hasMore, nextPage }` — note the absence of
// `total`.  We can't reuse httpx.Page (which always emits total) so
// this struct is written directly via writeJSON in feed.go.
//
// NextPage is `*int` so nil serialises to JSON `null`, matching
// Express's `hasMore ? page + 1 : null`.
type feedResponse struct {
	Data     []feedItem `json:"data"`
	HasMore  bool       `json:"hasMore"`
	NextPage *int       `json:"nextPage"`
}
