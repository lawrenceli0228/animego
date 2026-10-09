package community

// Shared fixtures for the package's tests.
//
// Everything that touches the database goes through a real chi router with
// the real middleware (RequireAuth / OptionalAuth / RequireAdmin) and a
// real Postgres (one testcontainer for the package, a fresh truncate per
// test).  The visibility rules — private reviews, blocks, public profiles,
// soft deletes — live in SQL, and only a real database can say whether they
// hold; the routing lives in Mount, and only the real router can say
// whether a URL reaches the handler it should.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/jwtx"
	"github.com/lawrenceli0228/animego/go-api/internal/testutil"
)

var pgURI string

func TestMain(m *testing.M) {
	ctx := context.Background()
	uri, cleanup, err := testutil.SetupPGForMain(ctx)
	if err != nil {
		fmt.Fprintf(os.Stderr, "community tests: setup postgres: %v\n", err)
		os.Exit(1)
	}
	pgURI = uri
	code := m.Run()
	cleanup()
	os.Exit(code)
}

// generous keeps every limit far out of reach, for the tests that are not
// about rate limiting.
func generous() Limits {
	big := Limit{Max: 10_000, Window: time.Hour}
	return Limits{Reviews: big, Threads: big, Replies: big, Reactions: big}
}

type env struct {
	t      *testing.T
	pool   *pgxpool.Pool
	router http.Handler
	signer *jwtx.Signer
}

// newEnv truncates the database and mounts the package on a fresh router,
// laid out as cmd/server lays it out.
func newEnv(t *testing.T, limits Limits) *env {
	t.Helper()
	ctx := context.Background()
	pool := testutil.NewWebPool(t, ctx, pgURI)
	testutil.TruncateAll(t, ctx, pool)
	signer, err := jwtx.NewSigner("community-test-access", "community-test-refresh", 15*time.Minute, time.Hour)
	require.NoError(t, err)
	h := NewHandlers(dbgen.New(pool), limits)
	t.Cleanup(h.Stop)
	r := chi.NewRouter()
	r.Route("/api/anime", func(r chi.Router) {
		h.Mount(r, signer)
		// A sibling route of the real router, to prove the mount does not
		// shadow the detail endpoint.
		r.Get("/{anilistId}", func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusTeapot)
		})
	})
	r.Route("/api/admin", func(r chi.Router) {
		r.Use(jwtx.RequireAuth(signer))
		r.Use(jwtx.RequireAdmin())
		h.MountAdmin(r)
	})
	return &env{t: t, pool: pool, router: r, signer: signer}
}

type user struct {
	ID    uuid.UUID
	Name  string
	token string
}

func (e *env) user(name string) user { return e.userWith(name, true, nil) }

func (e *env) privateUser(name string) user { return e.userWith(name, false, nil) }

func (e *env) admin(name string) user {
	role := "admin"
	return e.userWith(name, true, &role)
}

func (e *env) userWith(name string, public bool, role *string) user {
	e.t.Helper()
	var id uuid.UUID
	require.NoError(e.t, e.pool.QueryRow(context.Background(), `
		INSERT INTO users (username, email, password, is_public, role)
		VALUES ($1, $1 || '@example.test', 'hash', $2, $3)
		RETURNING id`, name, public, role).Scan(&id))
	tok, err := e.signer.SignAccess(id, name, role)
	require.NoError(e.t, err)
	return user{ID: id, Name: name, token: tok}
}

var anonymous = user{}

func (e *env) anime(id int32) {
	e.t.Helper()
	_, err := e.pool.Exec(context.Background(),
		`INSERT INTO anime_cache (anilist_id, title_romaji, cached_at) VALUES ($1, $2, now())`, id, fmt.Sprintf("Anime %d", id))
	require.NoError(e.t, err)
}

func (e *env) block(blocker, blocked user) {
	e.t.Helper()
	_, err := e.pool.Exec(context.Background(),
		`INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2)`, blocker.ID, blocked.ID)
	require.NoError(e.t, err)
}

// statusEvent writes a status event the way the subscription writes do, at a
// chosen moment so ordering is deterministic.
func (e *env) statusEvent(u user, anilistID int32, status string, at time.Time) uuid.UUID {
	e.t.Helper()
	var id uuid.UUID
	require.NoError(e.t, e.pool.QueryRow(context.Background(), `
		INSERT INTO activity_events (user_id, event_type, anilist_id, status, created_at)
		VALUES ($1, 'status', $2, $3, $4)
		RETURNING id`, u.ID, anilistID, status, at).Scan(&id))
	return id
}

func (e *env) subscribe(u user, anilistID int32, status string) {
	e.t.Helper()
	_, err := e.pool.Exec(context.Background(), `
		INSERT INTO subscriptions (user_id, anilist_id, status) VALUES ($1, $2, $3)`, u.ID, anilistID, status)
	require.NoError(e.t, err)
}

func (e *env) count(sql string, args ...any) int {
	e.t.Helper()
	var n int
	require.NoError(e.t, e.pool.QueryRow(context.Background(), sql, args...).Scan(&n))
	return n
}

// call sends one request through the router.  body may be nil, a string
// (sent verbatim) or anything json.Marshal accepts.
func (e *env) call(u user, method, path string, body any) *httptest.ResponseRecorder {
	e.t.Helper()
	var reader *bytes.Reader
	switch b := body.(type) {
	case nil:
		reader = bytes.NewReader(nil)
	case string:
		reader = bytes.NewReader([]byte(b))
	default:
		raw, err := json.Marshal(b)
		require.NoError(e.t, err)
		reader = bytes.NewReader(raw)
	}
	req := httptest.NewRequest(method, path, reader)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if u.token != "" {
		req.Header.Set("Authorization", "Bearer "+u.token)
	}
	rec := httptest.NewRecorder()
	e.router.ServeHTTP(rec, req)
	return rec
}

// data decodes the {data: …} envelope of a 2xx response into out.
func data[T any](t *testing.T, rec *httptest.ResponseRecorder, wantStatus int) T {
	t.Helper()
	require.Equal(t, wantStatus, rec.Code, "body=%s", rec.Body.String())
	var env struct {
		Data T `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &env), rec.Body.String())
	return env.Data
}

// failure asserts an error envelope's status, code and message.
func failure(t *testing.T, rec *httptest.ResponseRecorder, wantStatus int, wantCode, wantMessage string) {
	t.Helper()
	require.Equal(t, wantStatus, rec.Code, "body=%s", rec.Body.String())
	var env struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &env), rec.Body.String())
	require.Equal(t, wantCode, env.Error.Code, rec.Body.String())
	if wantMessage != "" {
		require.Equal(t, wantMessage, env.Error.Message)
	}
}

// longText is n characters of CJK, the case the limits are written for.
func longText(n int) string { return strings.Repeat("芙", n) }

func reviewBody(summary string, bodyLen int, spoiler, private bool) map[string]any {
	return map[string]any{
		"summary":   summary,
		"body":      longText(bodyLen),
		"isSpoiler": spoiler,
		"isPrivate": private,
	}
}

const base = "/api/anime/154587/community"

// Wire-shape mirrors, decoded from the JSON the API answers with.
type wireAuthor struct {
	Username string `json:"username"`
}

type wireReview struct {
	ID           uuid.UUID  `json:"id"`
	Author       wireAuthor `json:"author"`
	Summary      string     `json:"summary"`
	Body         string     `json:"body"`
	BodyHidden   bool       `json:"bodyHidden"`
	IsSpoiler    bool       `json:"isSpoiler"`
	IsPrivate    bool       `json:"isPrivate"`
	HelpfulCount int64      `json:"helpfulCount"`
	ViewerVoted  bool       `json:"viewerVoted"`
	IsOwn        bool       `json:"isOwn"`
}

type wirePage[T any] struct {
	Items    []T   `json:"items"`
	Total    int64 `json:"total"`
	Page     int   `json:"page"`
	HasMore  bool  `json:"hasMore"`
	NextPage *int  `json:"nextPage"`
}

type wireReply struct {
	ID              uuid.UUID  `json:"id"`
	Author          wireAuthor `json:"author"`
	Body            string     `json:"body"`
	IsSpoiler       bool       `json:"isSpoiler"`
	ParentID        *uuid.UUID `json:"parentId"`
	ReplyToUsername *string    `json:"replyToUsername"`
	IsOwn           bool       `json:"isOwn"`
}

type wireThreadSummary struct {
	ID         uuid.UUID  `json:"id"`
	Author     wireAuthor `json:"author"`
	Title      string     `json:"title"`
	Excerpt    string     `json:"excerpt"`
	IsSpoiler  bool       `json:"isSpoiler"`
	ReplyCount int64      `json:"replyCount"`
	IsOwn      bool       `json:"isOwn"`
}

type wireThreadView struct {
	Thread struct {
		ID     uuid.UUID  `json:"id"`
		Author wireAuthor `json:"author"`
		Title  string     `json:"title"`
		Body   string     `json:"body"`
		IsOwn  bool       `json:"isOwn"`
	} `json:"thread"`
	Replies []wireReply `json:"replies"`
}

type wireActivity struct {
	ID          uuid.UUID   `json:"id"`
	Author      wireAuthor  `json:"author"`
	Type        string      `json:"type"`
	Status      string      `json:"status"`
	LikeCount   int64       `json:"likeCount"`
	ViewerLiked bool        `json:"viewerLiked"`
	ReplyCount  int64       `json:"replyCount"`
	Replies     []wireReply `json:"replies"`
	IsOwn       bool        `json:"isOwn"`
}
