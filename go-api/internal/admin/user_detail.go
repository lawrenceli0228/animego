package admin

// user_detail.go — GET /api/admin/users/{userId}: everything the detail
// drawer shows about one account (users.ts AdminUserDetail).
//
// Five reads: one row of scalars (GetAdminUserDetail, which also decides
// 404), then the 90-day calendar, the newest episode marks, the most
// recently updated subscriptions and the live sessions.  They read the
// account's own tables, not the activity views: this is a description of an
// account, and a deleted account is not one.

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// recentItemsLimit is how many episode marks and subscriptions the drawer
// lists.
const recentItemsLimit = 6

// errUserNotFound is loadUserDetail's answer for an id with no account.
var errUserNotFound = errors.New("admin: user not found")

// userDetailQuerier is the sqlc subset the drawer reads.
type userDetailQuerier interface {
	GetAdminUserDetail(ctx context.Context, id uuid.UUID) (dbgen.GetAdminUserDetailRow, error)
	ListAdminUserActivityDays(ctx context.Context, userID uuid.UUID, today pgtype.Date) ([]dbgen.ListAdminUserActivityDaysRow, error)
	ListAdminUserRecentWatches(ctx context.Context, userID uuid.UUID, rowLimit int32) ([]dbgen.ListAdminUserRecentWatchesRow, error)
	ListAdminUserRecentSubscriptions(ctx context.Context, userID uuid.UUID, rowLimit int32) ([]dbgen.ListAdminUserRecentSubscriptionsRow, error)
	ListAdminUserLiveSessions(ctx context.Context, userID uuid.UUID) ([]dbgen.ListAdminUserLiveSessionsRow, error)
}

// userDetailResponse is AdminUserDetail.  Every list is non-null ([] when
// empty) and every "nothing recorded" is an explicit null.
type userDetailResponse struct {
	Today               string                   `json:"today"`
	InstrumentedSince   *string                  `json:"instrumentedSince"`
	User                userDetailAccount        `json:"user"`
	Activity            userDetailActivity       `json:"activity"`
	Subscriptions       userDetailSubscriptions  `json:"subscriptions"`
	Watches             userDetailWatches        `json:"watches"`
	RecentWatches       []userRecentWatch        `json:"recentWatches"`
	RecentSubscriptions []userRecentSubscription `json:"recentSubscriptions"`
	Sessions            []userSessionView        `json:"sessions"`
	Community           userDetailCommunity      `json:"community"`
}

type userDetailAccount struct {
	ID        uuid.UUID `json:"_id"`
	Username  string    `json:"username"`
	Email     string    `json:"email"`
	Role      *string   `json:"role"`
	CreatedAt time.Time `json:"createdAt"`
	IsPublic  bool      `json:"isPublic"`
	AvatarURL *string   `json:"avatarUrl"`
}

type userDetailActivity struct {
	ActiveDays   int64      `json:"activeDays"`
	RecordedDays int64      `json:"recordedDays"`
	LastSeenAt   *time.Time `json:"lastSeenAt"`
	Logins       int64      `json:"logins"`
	Requests     int64      `json:"requests"`
	// Days90 are the account's recorded days in [today-89, today], ascending.
	Days90 []userActivityDay `json:"days90"`
}

// userActivityDay is one calendar cell.  Recorded is false for a day
// migration 0026 reconstructed from other tables.
type userActivityDay struct {
	Date     string `json:"date"`
	Recorded bool   `json:"recorded"`
}

type userDetailSubscriptions struct {
	Total       int64 `json:"total"`
	Watching    int64 `json:"watching"`
	Completed   int64 `json:"completed"`
	PlanToWatch int64 `json:"planToWatch"`
	Dropped     int64 `json:"dropped"`
	Rated       int64 `json:"rated"`
	// AvgScore is the mean over rated subscriptions; null when none are.
	AvgScore      *float64   `json:"avgScore"`
	LastUpdatedAt *time.Time `json:"lastUpdatedAt"`
}

type userDetailWatches struct {
	Total         int64      `json:"total"`
	LastWatchedAt *time.Time `json:"lastWatchedAt"`
}

// adminAnimeTitles is the title fields pickTitle() reads, as anime_cache
// holds them (users.ts AdminAnimeTitles).  Embedded, so its fields sit at
// the top level of each item.
type adminAnimeTitles struct {
	AnilistID    int32   `json:"anilistId"`
	TitleChinese *string `json:"titleChinese"`
	TitleRomaji  *string `json:"titleRomaji"`
	TitleEnglish *string `json:"titleEnglish"`
	TitleNative  *string `json:"titleNative"`
	TitleHant    *string `json:"titleHant"`
	Episodes     *int32  `json:"episodes"`
}

type userRecentWatch struct {
	adminAnimeTitles
	Episode   int32     `json:"episode"`
	WatchedAt time.Time `json:"watchedAt"`
}

type userRecentSubscription struct {
	adminAnimeTitles
	Status         string    `json:"status"`
	Score          *int32    `json:"score"`
	CurrentEpisode int32     `json:"currentEpisode"`
	UpdatedAt      time.Time `json:"updatedAt"`
}

// userSessionView is one live session (users.ts AdminUserSession).
type userSessionView struct {
	ID         uuid.UUID `json:"id"`
	Kind       string    `json:"kind"`
	OS         string    `json:"os"`
	Browser    string    `json:"browser"`
	Country    *string   `json:"country"`
	CreatedAt  time.Time `json:"createdAt"`
	LastUsedAt time.Time `json:"lastUsedAt"`
	ExpiresAt  time.Time `json:"expiresAt"`
}

type userDetailCommunity struct {
	Comments        int64 `json:"comments"`
	Replies         int64 `json:"replies"`
	Threads         int64 `json:"threads"`
	Reviews         int64 `json:"reviews"`
	Danmaku         int64 `json:"danmaku"`
	Following       int64 `json:"following"`
	Followers       int64 `json:"followers"`
	ReportsFiled    int64 `json:"reportsFiled"`
	EditSubmissions int64 `json:"editSubmissions"`
}

// loadUserDetail reads one account for the drawer, as of the reporting day
// today.  errUserNotFound when there is no such account.
func loadUserDetail(ctx context.Context, q userDetailQuerier, id uuid.UUID, today time.Time) (userDetailResponse, error) {
	row, err := q.GetAdminUserDetail(ctx, id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return userDetailResponse{}, errUserNotFound
		}
		return userDetailResponse{}, fmt.Errorf("user detail: %w", err)
	}
	days, err := q.ListAdminUserActivityDays(ctx, id, reportingDate(today))
	if err != nil {
		return userDetailResponse{}, fmt.Errorf("user detail days: %w", err)
	}
	watches, err := q.ListAdminUserRecentWatches(ctx, id, recentItemsLimit)
	if err != nil {
		return userDetailResponse{}, fmt.Errorf("user detail watches: %w", err)
	}
	subs, err := q.ListAdminUserRecentSubscriptions(ctx, id, recentItemsLimit)
	if err != nil {
		return userDetailResponse{}, fmt.Errorf("user detail subscriptions: %w", err)
	}
	sessions, err := q.ListAdminUserLiveSessions(ctx, id)
	if err != nil {
		return userDetailResponse{}, fmt.Errorf("user detail sessions: %w", err)
	}

	return userDetailResponse{
		Today:             today.Format(userDayLayout),
		InstrumentedSince: datePtr(row.InstrumentedSince),
		User: userDetailAccount{
			ID:        row.ID,
			Username:  row.Username,
			Email:     row.Email,
			Role:      row.Role,
			CreatedAt: row.CreatedAt.Time.UTC(),
			IsPublic:  row.IsPublic,
			AvatarURL: row.AvatarUrl,
		},
		Activity: userDetailActivity{
			ActiveDays:   row.ActiveDays,
			RecordedDays: row.RecordedDays,
			LastSeenAt:   timePtr(row.LastSeenAt),
			Logins:       row.Logins,
			Requests:     row.Requests,
			Days90:       activityDays(days),
		},
		Subscriptions: userDetailSubscriptions{
			Total:         row.SubsTotal,
			Watching:      row.SubsWatching,
			Completed:     row.SubsCompleted,
			PlanToWatch:   row.SubsPlanToWatch,
			Dropped:       row.SubsDropped,
			Rated:         row.SubsRated,
			AvgScore:      meanScore(row.SubsScoreSum, row.SubsRated),
			LastUpdatedAt: timePtr(row.SubsLastUpdatedAt),
		},
		Watches: userDetailWatches{
			Total:         row.WatchesTotal,
			LastWatchedAt: timePtr(row.LastWatchedAt),
		},
		RecentWatches:       recentWatches(watches),
		RecentSubscriptions: recentSubscriptions(subs),
		Sessions:            sessionViews(sessions),
		Community: userDetailCommunity{
			Comments:        row.Comments,
			Replies:         row.Replies,
			Threads:         row.Threads,
			Reviews:         row.Reviews,
			Danmaku:         row.Danmaku,
			Following:       row.Following,
			Followers:       row.Followers,
			ReportsFiled:    row.ReportsFiled,
			EditSubmissions: row.EditSubmissions,
		},
	}, nil
}

// meanScore is sum/count, or nil when nothing is rated.
func meanScore(sum, rated int64) *float64 {
	if rated <= 0 {
		return nil
	}
	mean := float64(sum) / float64(rated)
	return &mean
}

// datePtr is a nullable date as a JSON-nullable YYYY-MM-DD.
func datePtr(d pgtype.Date) *string {
	if !d.Valid {
		return nil
	}
	s := d.Time.Format(userDayLayout)
	return &s
}

func activityDays(rows []dbgen.ListAdminUserActivityDaysRow) []userActivityDay {
	out := make([]userActivityDay, 0, len(rows))
	for _, r := range rows {
		if !r.ActivityDate.Valid {
			continue
		}
		out = append(out, userActivityDay{Date: r.ActivityDate.Time.Format(userDayLayout), Recorded: r.Recorded})
	}
	return out
}

// animeTitles gathers one anime_cache row's title fields.
func animeTitles(id int32, chinese, romaji, english, native, hant *string, episodes *int32) adminAnimeTitles {
	return adminAnimeTitles{
		AnilistID:    id,
		TitleChinese: chinese,
		TitleRomaji:  romaji,
		TitleEnglish: english,
		TitleNative:  native,
		TitleHant:    hant,
		Episodes:     episodes,
	}
}

func recentWatches(rows []dbgen.ListAdminUserRecentWatchesRow) []userRecentWatch {
	out := make([]userRecentWatch, 0, len(rows))
	for _, r := range rows {
		out = append(out, userRecentWatch{
			adminAnimeTitles: animeTitles(r.AnilistID, r.TitleChinese, r.TitleRomaji, r.TitleEnglish,
				r.TitleNative, r.TitleHant, r.Episodes),
			Episode:   r.Episode,
			WatchedAt: r.WatchedAt.Time.UTC(),
		})
	}
	return out
}

func recentSubscriptions(rows []dbgen.ListAdminUserRecentSubscriptionsRow) []userRecentSubscription {
	out := make([]userRecentSubscription, 0, len(rows))
	for _, r := range rows {
		out = append(out, userRecentSubscription{
			adminAnimeTitles: animeTitles(r.AnilistID, r.TitleChinese, r.TitleRomaji, r.TitleEnglish,
				r.TitleNative, r.TitleHant, r.Episodes),
			Status:         r.Status,
			Score:          r.Score,
			CurrentEpisode: r.CurrentEpisode,
			UpdatedAt:      r.UpdatedAt.Time.UTC(),
		})
	}
	return out
}

func sessionViews(rows []dbgen.ListAdminUserLiveSessionsRow) []userSessionView {
	out := make([]userSessionView, 0, len(rows))
	for _, r := range rows {
		dev := describeDevice(r.UserAgent)
		out = append(out, userSessionView{
			ID:         r.ID,
			Kind:       dev.Kind,
			OS:         dev.OS,
			Browser:    dev.Browser,
			Country:    r.Country,
			CreatedAt:  r.CreatedAt.Time.UTC(),
			LastUsedAt: r.LastUsedAt.Time.UTC(),
			ExpiresAt:  r.ExpiresAt.Time.UTC(),
		})
	}
	return out
}
