package community

import (
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/pii"
)

// The wire shapes.  No user ids go out: whether a row is the reader's own is
// answered as isOwn, and a person is named by their public username, which
// pii.PublicUsername masks when it looks like an email address or a phone
// number.  These responses are server-rendered into /anime/{id}/social, a
// cached and indexed page — the same reason the watchers endpoint masks.

type authorDTO struct {
	Username         string  `json:"username"`
	AvatarURL        *string `json:"avatarUrl"`
	BackdropCoverURL *string `json:"backdropCoverUrl"`
}

func author(username string, avatar, backdrop *string) authorDTO {
	return authorDTO{Username: pii.PublicUsername(username), AvatarURL: avatar, BackdropCoverURL: backdrop}
}

type pageDTO[T any] struct {
	Items    []T   `json:"items"`
	Total    int64 `json:"total"`
	Page     int   `json:"page"`
	HasMore  bool  `json:"hasMore"`
	NextPage *int  `json:"nextPage"`
}

type reviewDTO struct {
	ID        uuid.UUID `json:"id"`
	AnilistID int32     `json:"anilistId"`
	Author    authorDTO `json:"author"`
	Summary   string    `json:"summary"`
	Body      string    `json:"body"`
	// BodyHidden: the list leaves a spoiler review's body out (Body is "")
	// so it is neither shipped nor server-rendered until a reader asks for
	// it through GET /reviews/{id}.
	BodyHidden   bool               `json:"bodyHidden"`
	IsSpoiler    bool               `json:"isSpoiler"`
	IsPrivate    bool               `json:"isPrivate"`
	HelpfulCount int64              `json:"helpfulCount"`
	ViewerVoted  bool               `json:"viewerVoted"`
	IsOwn        bool               `json:"isOwn"`
	CreatedAt    pgtype.Timestamptz `json:"createdAt"`
	UpdatedAt    pgtype.Timestamptz `json:"updatedAt"`
}

// toReview maps a review row.  withSpoilerBody=false is the list's form.
func toReview(row dbgen.QueryAnimeReviewsRow, viewer *uuid.UUID, withSpoilerBody bool) reviewDTO {
	dto := reviewDTO{
		ID:           row.ID,
		AnilistID:    row.AnilistID,
		Author:       author(row.Username, row.AvatarUrl, row.BackdropCoverUrl),
		Summary:      row.Summary,
		Body:         row.Body,
		IsSpoiler:    row.IsSpoiler,
		IsPrivate:    row.IsPrivate,
		HelpfulCount: row.HelpfulCount,
		ViewerVoted:  row.ViewerVoted,
		IsOwn:        viewer != nil && *viewer == row.UserID,
		CreatedAt:    row.CreatedAt,
		UpdatedAt:    row.UpdatedAt,
	}
	if row.IsSpoiler && !withSpoilerBody {
		dto.Body = ""
		dto.BodyHidden = true
	}
	return dto
}

// threadExcerptRunes is how much of a thread's body the list shows.
const threadExcerptRunes = 120

type threadSummaryDTO struct {
	ID        uuid.UUID `json:"id"`
	AnilistID int32     `json:"anilistId"`
	Author    authorDTO `json:"author"`
	Title     string    `json:"title"`
	// Excerpt is the opening of the body on one line; "" for a spoiler
	// thread, whose body only the thread page shows.
	Excerpt        string             `json:"excerpt"`
	IsSpoiler      bool               `json:"isSpoiler"`
	ReplyCount     int64              `json:"replyCount"`
	IsOwn          bool               `json:"isOwn"`
	CreatedAt      pgtype.Timestamptz `json:"createdAt"`
	LastActivityAt pgtype.Timestamptz `json:"lastActivityAt"`
}

func toThreadSummary(row dbgen.ListAnimeThreadsRow, viewer *uuid.UUID) threadSummaryDTO {
	excerpt := ""
	if !row.IsSpoiler {
		excerpt = excerptOf(row.BodyExcerpt, threadExcerptRunes)
	}
	return threadSummaryDTO{
		ID:             row.ID,
		AnilistID:      row.AnilistID,
		Author:         author(row.Username, row.AvatarUrl, row.BackdropCoverUrl),
		Title:          row.Title,
		Excerpt:        excerpt,
		IsSpoiler:      row.IsSpoiler,
		ReplyCount:     row.ReplyCount,
		IsOwn:          viewer != nil && *viewer == row.UserID,
		CreatedAt:      row.CreatedAt,
		LastActivityAt: row.LastActivityAt,
	}
}

// excerptOf collapses s onto one line and cuts it to max characters, adding
// an ellipsis when it cut.
func excerptOf(s string, max int) string {
	line := strings.Join(strings.Fields(s), " ")
	runes := []rune(line)
	if len(runes) <= max {
		return line
	}
	return strings.TrimSpace(string(runes[:max])) + "…"
}

type threadDTO struct {
	ID             uuid.UUID          `json:"id"`
	AnilistID      int32              `json:"anilistId"`
	Author         authorDTO          `json:"author"`
	Title          string             `json:"title"`
	Body           string             `json:"body"`
	IsSpoiler      bool               `json:"isSpoiler"`
	IsOwn          bool               `json:"isOwn"`
	CreatedAt      pgtype.Timestamptz `json:"createdAt"`
	UpdatedAt      pgtype.Timestamptz `json:"updatedAt"`
	LastActivityAt pgtype.Timestamptz `json:"lastActivityAt"`
}

type threadViewDTO struct {
	Thread  threadDTO  `json:"thread"`
	Replies []replyDTO `json:"replies"`
}

func toThread(row dbgen.GetAnimeThreadRow, viewer *uuid.UUID) threadDTO {
	return threadDTO{
		ID:             row.ID,
		AnilistID:      row.AnilistID,
		Author:         author(row.Username, row.AvatarUrl, row.BackdropCoverUrl),
		Title:          row.Title,
		Body:           row.Body,
		IsSpoiler:      row.IsSpoiler,
		IsOwn:          viewer != nil && *viewer == row.UserID,
		CreatedAt:      row.CreatedAt,
		UpdatedAt:      row.UpdatedAt,
		LastActivityAt: row.LastActivityAt,
	}
}

type replyDTO struct {
	ID              uuid.UUID          `json:"id"`
	Author          authorDTO          `json:"author"`
	Body            string             `json:"body"`
	IsSpoiler       bool               `json:"isSpoiler"`
	ParentID        *uuid.UUID         `json:"parentId"`
	ReplyToUsername *string            `json:"replyToUsername"`
	IsOwn           bool               `json:"isOwn"`
	CreatedAt       pgtype.Timestamptz `json:"createdAt"`
}

func toThreadReply(row dbgen.ListThreadRepliesRow, viewer *uuid.UUID) replyDTO {
	return replyDTO{
		ID:              row.ID,
		Author:          author(row.Username, row.AvatarUrl, row.BackdropCoverUrl),
		Body:            row.Body,
		IsSpoiler:       row.IsSpoiler,
		ParentID:        row.ParentID,
		ReplyToUsername: pii.PublicUsernamePtr(row.ReplyToUsername),
		IsOwn:           viewer != nil && *viewer == row.UserID,
		CreatedAt:       row.CreatedAt,
	}
}

func toReply(row dbgen.GetCommunityReplyRow, viewer *uuid.UUID) replyDTO {
	return replyDTO{
		ID:              row.ID,
		Author:          author(row.Username, row.AvatarUrl, row.BackdropCoverUrl),
		Body:            row.Body,
		IsSpoiler:       row.IsSpoiler,
		ParentID:        row.ParentID,
		ReplyToUsername: pii.PublicUsernamePtr(row.ReplyToUsername),
		IsOwn:           viewer != nil && *viewer == row.UserID,
		CreatedAt:       row.CreatedAt,
	}
}

func toActivityReply(row dbgen.ListActivityRepliesRow, viewer *uuid.UUID) replyDTO {
	return replyDTO{
		ID:              row.ID,
		Author:          author(row.Username, row.AvatarUrl, row.BackdropCoverUrl),
		Body:            row.Body,
		IsSpoiler:       row.IsSpoiler,
		ParentID:        row.ParentID,
		ReplyToUsername: pii.PublicUsernamePtr(row.ReplyToUsername),
		IsOwn:           viewer != nil && *viewer == row.UserID,
		CreatedAt:       row.CreatedAt,
	}
}

type activityDTO struct {
	ID          uuid.UUID          `json:"id"`
	AnilistID   int32              `json:"anilistId"`
	Author      authorDTO          `json:"author"`
	Type        string             `json:"type"`
	Status      string             `json:"status"`
	LikeCount   int64              `json:"likeCount"`
	ViewerLiked bool               `json:"viewerLiked"`
	ReplyCount  int64              `json:"replyCount"`
	Replies     []replyDTO         `json:"replies"`
	IsOwn       bool               `json:"isOwn"`
	CreatedAt   pgtype.Timestamptz `json:"createdAt"`
}

func toActivity(row dbgen.QueryAnimeActivityRow, anilistID int32, viewer *uuid.UUID) activityDTO {
	return activityDTO{
		ID:          row.ID,
		AnilistID:   anilistID,
		Author:      author(row.Username, row.AvatarUrl, row.BackdropCoverUrl),
		Type:        "status",
		Status:      row.Status,
		LikeCount:   row.LikeCount,
		ViewerLiked: row.ViewerLiked,
		ReplyCount:  row.ReplyCount,
		Replies:     []replyDTO{},
		IsOwn:       viewer != nil && *viewer == row.UserID,
		CreatedAt:   row.CreatedAt,
	}
}

type watcherDTO struct {
	Username         string             `json:"username"`
	AvatarURL        *string            `json:"avatarUrl"`
	BackdropCoverURL *string            `json:"backdropCoverUrl"`
	Status           string             `json:"status"`
	CurrentEpisode   int32              `json:"currentEpisode"`
	Since            pgtype.Timestamptz `json:"since"`
}

type watcherCountsDTO struct {
	Watching    int64 `json:"watching"`
	Completed   int64 `json:"completed"`
	PlanToWatch int64 `json:"planToWatch"`
	Dropped     int64 `json:"dropped"`
}

type watchersDTO struct {
	Items  []watcherDTO     `json:"items"`
	Total  int64            `json:"total"`
	Counts watcherCountsDTO `json:"counts"`
}

func toWatchers(rows []dbgen.ListAnimeFollowersRow, counts dbgen.CountAnimeFollowersRow) watchersDTO {
	items := make([]watcherDTO, 0, len(rows))
	for _, row := range rows {
		items = append(items, watcherDTO{
			Username:         pii.PublicUsername(row.Username),
			AvatarURL:        row.AvatarUrl,
			BackdropCoverURL: row.BackdropCoverUrl,
			Status:           row.Status,
			CurrentEpisode:   row.CurrentEpisode,
			Since:            row.Since,
		})
	}
	return watchersDTO{
		Items: items,
		Total: counts.Watching + counts.Completed + counts.PlanToWatch + counts.Dropped,
		Counts: watcherCountsDTO{
			Watching:    counts.Watching,
			Completed:   counts.Completed,
			PlanToWatch: counts.PlanToWatch,
			Dropped:     counts.Dropped,
		},
	}
}

// viewerDTO is what the summary tells a signed-in reader about themselves:
// their own status for the anime (null when it is not on their list) and
// their live review, if they wrote one.
type viewerDTO struct {
	Status   *string    `json:"status"`
	ReviewID *uuid.UUID `json:"reviewId"`
}

type summaryDTO struct {
	Reviews  pageDTO[reviewDTO]        `json:"reviews"`
	Threads  pageDTO[threadSummaryDTO] `json:"threads"`
	Activity pageDTO[activityDTO]      `json:"activity"`
	Watchers watchersDTO               `json:"watchers"`
	Viewer   *viewerDTO                `json:"viewer"`
}

// voteDTO / likeDTO answer the toggles with the state they left behind.
type voteDTO struct {
	Voted        bool  `json:"voted"`
	HelpfulCount int64 `json:"helpfulCount"`
}

type likeDTO struct {
	Liked     bool  `json:"liked"`
	LikeCount int64 `json:"likeCount"`
}

type deletedDTO struct {
	Deleted bool `json:"deleted"`
}
