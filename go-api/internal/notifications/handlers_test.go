package notifications

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/jwtx"
)

type fakeDB struct {
	countFn   func(context.Context, uuid.UUID) (int64, error)
	listFn    func(context.Context, uuid.UUID, int32) ([]dbgen.ListNotificationsRow, error)
	markFn    func(context.Context, uuid.UUID, uuid.UUID) (dbgen.Notification, error)
	markAllFn func(context.Context, uuid.UUID) (int64, error)
}

func (f *fakeDB) CountUnreadNotifications(ctx context.Context, userID uuid.UUID) (int64, error) {
	if f.countFn == nil {
		panic("unexpected CountUnreadNotifications call")
	}
	return f.countFn(ctx, userID)
}

func (f *fakeDB) ListNotifications(ctx context.Context, userID uuid.UUID, limit int32) ([]dbgen.ListNotificationsRow, error) {
	if f.listFn == nil {
		panic("unexpected ListNotifications call")
	}
	return f.listFn(ctx, userID, limit)
}

func (f *fakeDB) MarkNotificationRead(ctx context.Context, notificationID, userID uuid.UUID) (dbgen.Notification, error) {
	if f.markFn == nil {
		panic("unexpected MarkNotificationRead call")
	}
	return f.markFn(ctx, notificationID, userID)
}

func (f *fakeDB) MarkAllNotificationsRead(ctx context.Context, userID uuid.UUID) (int64, error) {
	if f.markAllFn == nil {
		panic("unexpected MarkAllNotificationsRead call")
	}
	return f.markAllFn(ctx, userID)
}

func authenticatedRequest(t *testing.T, method, target string, userID uuid.UUID) *http.Request {
	t.Helper()
	signer, err := jwtx.NewSigner("notifications-access-secret", "notifications-refresh-secret", time.Minute, time.Hour)
	require.NoError(t, err)
	token, err := signer.SignAccess(userID, "viewer", nil)
	require.NoError(t, err)

	req := httptest.NewRequest(method, target, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	var authenticated *http.Request
	jwtx.RequireAuth(signer)(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		authenticated = r
	})).ServeHTTP(httptest.NewRecorder(), req)
	require.NotNil(t, authenticated)
	return authenticated
}

func requestWithNotificationID(t *testing.T, req *http.Request, id uuid.UUID) *http.Request {
	t.Helper()
	routeCtx := chi.NewRouteContext()
	routeCtx.URLParams.Add("id", id.String())
	return req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeCtx))
}

func TestUnreadCountUsesAuthenticatedUser(t *testing.T) {
	viewerID := uuid.New()
	db := &fakeDB{countFn: func(_ context.Context, userID uuid.UUID) (int64, error) {
		assert.Equal(t, viewerID, userID)
		return 7, nil
	}}
	rec := httptest.NewRecorder()
	NewHandlers(db).UnreadCount(rec, authenticatedRequest(t, http.MethodGet, "/api/notifications/unread-count", viewerID))

	require.Equal(t, http.StatusOK, rec.Code)
	assert.JSONEq(t, `{"data":{"unreadCount":7}}`, rec.Body.String())
}

func TestListClampsLimitAndMapsNotification(t *testing.T) {
	viewerID := uuid.New()
	commentID := uuid.New()
	anilistID := int32(101)
	episode := int32(3)
	content := "new reply"
	title := "Example Anime"
	createdAt := pgtype.Timestamptz{Time: time.Date(2026, 8, 15, 1, 2, 3, 0, time.UTC), Valid: true}

	for _, tc := range []struct {
		name      string
		rawLimit  string
		wantLimit int32
	}{
		{name: "default", wantLimit: 20},
		{name: "minimum", rawLimit: "0", wantLimit: 1},
		{name: "maximum", rawLimit: "999", wantLimit: 50},
		{name: "invalid uses default", rawLimit: "not-a-number", wantLimit: 20},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db := &fakeDB{
				countFn: func(_ context.Context, userID uuid.UUID) (int64, error) {
					assert.Equal(t, viewerID, userID)
					return 4, nil
				},
				listFn: func(_ context.Context, userID uuid.UUID, limit int32) ([]dbgen.ListNotificationsRow, error) {
					assert.Equal(t, viewerID, userID)
					assert.Equal(t, tc.wantLimit, limit)
					return []dbgen.ListNotificationsRow{{
						ID:               uuid.New(),
						NotificationType: "reply",
						CommentID:        &commentID,
						CreatedAt:        createdAt,
						ActorID:          uuid.New(),
						ActorUsername:    "alice",
						AnilistID:        &anilistID,
						Episode:          &episode,
						CommentContent:   &content,
						TitleRomaji:      &title,
					}}, nil
				},
			}
			target := "/api/notifications"
			if tc.rawLimit != "" {
				target += "?limit=" + tc.rawLimit
			}
			rec := httptest.NewRecorder()
			NewHandlers(db).List(rec, authenticatedRequest(t, http.MethodGet, target, viewerID))

			require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
			var body struct {
				Data struct {
					UnreadCount int64 `json:"unreadCount"`
					Items       []struct {
						Type      string `json:"type"`
						CommentID string `json:"commentId"`
						Actor     struct {
							Username string `json:"username"`
						} `json:"actor"`
						Anime struct {
							AnilistID int32  `json:"anilistId"`
							Title     string `json:"title"`
						} `json:"anime"`
					} `json:"items"`
				} `json:"data"`
			}
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
			assert.Equal(t, int64(4), body.Data.UnreadCount)
			require.Len(t, body.Data.Items, 1)
			assert.Equal(t, "comment_reply", body.Data.Items[0].Type)
			assert.Equal(t, commentID.String(), body.Data.Items[0].CommentID)
			assert.Equal(t, "alice", body.Data.Items[0].Actor.Username)
			assert.Equal(t, anilistID, body.Data.Items[0].Anime.AnilistID)
			assert.Equal(t, title, body.Data.Items[0].Anime.Title)
		})
	}
}

func TestMarkReadScopesWriteToAuthenticatedUser(t *testing.T) {
	viewerID := uuid.New()
	notificationID := uuid.New()
	readAt := pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true}
	db := &fakeDB{markFn: func(_ context.Context, gotNotificationID, gotUserID uuid.UUID) (dbgen.Notification, error) {
		assert.Equal(t, notificationID, gotNotificationID)
		assert.Equal(t, viewerID, gotUserID)
		return dbgen.Notification{ID: notificationID, UserID: viewerID, ReadAt: readAt}, nil
	}}
	req := authenticatedRequest(t, http.MethodPatch, "/api/notifications/"+notificationID.String()+"/read", viewerID)
	req = requestWithNotificationID(t, req, notificationID)
	rec := httptest.NewRecorder()
	NewHandlers(db).MarkRead(rec, req)

	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var body struct {
		Data struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, notificationID.String(), body.Data.ID)
}

func TestMarkReadReturnsNotFoundForNonOwnedNotification(t *testing.T) {
	viewerID := uuid.New()
	notificationID := uuid.New()
	db := &fakeDB{markFn: func(_ context.Context, gotNotificationID, gotUserID uuid.UUID) (dbgen.Notification, error) {
		assert.Equal(t, notificationID, gotNotificationID)
		assert.Equal(t, viewerID, gotUserID)
		return dbgen.Notification{}, pgx.ErrNoRows
	}}
	req := authenticatedRequest(t, http.MethodPatch, "/api/notifications/"+notificationID.String()+"/read", viewerID)
	req = requestWithNotificationID(t, req, notificationID)
	rec := httptest.NewRecorder()
	NewHandlers(db).MarkRead(rec, req)

	require.Equal(t, http.StatusNotFound, rec.Code)
	assert.Contains(t, rec.Body.String(), `"code":"NOT_FOUND"`)
}

func TestMarkAllReadUsesAuthenticatedUser(t *testing.T) {
	viewerID := uuid.New()
	db := &fakeDB{markAllFn: func(_ context.Context, userID uuid.UUID) (int64, error) {
		assert.Equal(t, viewerID, userID)
		return 3, nil
	}}
	rec := httptest.NewRecorder()
	NewHandlers(db).MarkAllRead(rec, authenticatedRequest(t, http.MethodPost, "/api/notifications/read-all", viewerID))

	require.Equal(t, http.StatusOK, rec.Code)
	assert.JSONEq(t, `{"data":{"updated":3}}`, rec.Body.String())
}

func TestHandlersRejectMissingClaimsBeforeDatabaseAccess(t *testing.T) {
	called := false
	db := &fakeDB{
		countFn: func(context.Context, uuid.UUID) (int64, error) { called = true; return 0, nil },
		listFn: func(context.Context, uuid.UUID, int32) ([]dbgen.ListNotificationsRow, error) {
			called = true
			return nil, nil
		},
		markFn: func(context.Context, uuid.UUID, uuid.UUID) (dbgen.Notification, error) {
			called = true
			return dbgen.Notification{}, nil
		},
		markAllFn: func(context.Context, uuid.UUID) (int64, error) { called = true; return 0, nil },
	}
	notificationID := uuid.New()
	tests := []struct {
		name    string
		request *http.Request
		handle  func(*Handlers, http.ResponseWriter, *http.Request)
	}{
		{name: "unread", request: httptest.NewRequest(http.MethodGet, "/api/notifications/unread-count", nil), handle: (*Handlers).UnreadCount},
		{name: "list", request: httptest.NewRequest(http.MethodGet, "/api/notifications", nil), handle: (*Handlers).List},
		{name: "mark read", request: requestWithNotificationID(t, httptest.NewRequest(http.MethodPatch, "/api/notifications/"+notificationID.String()+"/read", nil), notificationID), handle: (*Handlers).MarkRead},
		{name: "read all", request: httptest.NewRequest(http.MethodPost, "/api/notifications/read-all", nil), handle: (*Handlers).MarkAllRead},
	}

	for i, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			called = false
			rec := httptest.NewRecorder()
			tc.handle(NewHandlers(db), rec, tc.request)
			assert.Equal(t, http.StatusUnauthorized, rec.Code)
			assert.Contains(t, rec.Body.String(), `"code":"UNAUTHORIZED"`)
			assert.False(t, called, "case %s accessed the DB", strconv.Itoa(i))
		})
	}
}
