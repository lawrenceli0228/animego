package queue

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/testutil"
)

// TestImageWarm_PG runs the image warm job on a real Postgres against a stub
// warm endpoint: what image_refs covers and returns, which URLs a pass is
// offered and in what order, and what each kind of answer does to the rows,
// to the pass and to the next pass.
//
// NOT parallel: the subtests set IMAGE_WARM_BASE_URL and swap slog.Default.
func TestImageWarm_PG(t *testing.T) {
	ctx := context.Background()
	uri := testutil.SetupPG(t)
	pool := testutil.NewWebPool(t, ctx, uri)
	q := dbgen.New(pool)
	h := &imageWarmHarness{ctx: ctx, pool: pool, q: q}

	t.Run("image_refs reads every image column in the schema", func(t *testing.T) {
		assert.Empty(t, h.uncoveredImageColumns(t),
			"these columns hold image URLs image_refs does not read, so the warm job never stores "+
				"them: add them to the view (CREATE OR REPLACE VIEW image_refs) in the migration that "+
				"adds them, or name them here if they are not AniList images")

		// The guard sees a column the view does not read.
		h.exec(t, `ALTER TABLE people ADD COLUMN banner_probe_url text`)
		assert.Equal(t, []string{"people.banner_probe_url"}, h.uncoveredImageColumns(t))
		h.exec(t, `ALTER TABLE people DROP COLUMN banner_probe_url`)
	})

	t.Run("image_refs is every distinct AniList URL in the twelve columns and nothing else", func(t *testing.T) {
		h.reset(t)
		u := func(n int) string { return fmt.Sprintf("%scharacter/large/b%02d-ref.png", anilistCDNPrefix, n) }
		h.exec(t, `INSERT INTO anime_cache (anilist_id, title_romaji, cover_image_url, banner_image_url) VALUES
			(1, 'a', $1, $2), (2, 'b', '', NULL), (3, 'c', 'https://example.com/x.png', $1)`, u(1), u(2))
		h.exec(t, `INSERT INTO anime_recommendations (anime_id, anilist_id, cover_image_url) VALUES (1, 2, $1)`, u(3))
		h.exec(t, `INSERT INTO anime_relations (anime_id, anilist_id, cover_image_url) VALUES (1, 3, $1)`, u(4))
		h.exec(t, `INSERT INTO anime_characters (anime_id, display_order, character_id, image_url, voice_actor_image_url)
			VALUES (1, 0, 10, $1, $2)`, u(5), u(6))
		h.exec(t, `INSERT INTO anime_character_voices (anime_id, character_id, staff_id, display_order, image_url)
			VALUES (1, 10, 20, 0, $1)`, u(7))
		h.exec(t, `INSERT INTO anime_staff (anime_id, display_order, staff_id, role, image_url)
			VALUES (1, 0, 21, 'Director', $1)`, u(8))
		h.exec(t, `INSERT INTO characters (anilist_id, checked_at, image_large, image_medium) VALUES (10, now(), $1, $2)`, u(9), u(10))
		h.exec(t, `INSERT INTO people (anilist_id, checked_at, image_large, image_medium) VALUES (20, now(), $1, $2)`, u(11), u(12))

		var want []string
		for n := 1; n <= 12; n++ {
			want = append(want, u(n))
		}
		assert.Equal(t, want, h.strings(t, `SELECT url FROM image_refs ORDER BY url`),
			"one URL from each column, the repeated one once, and no NULL, empty or foreign URL")
	})

	t.Run("the batch: never asked, then due retries, then the oldest re-checks", func(t *testing.T) {
		h.reset(t)
		never1, never2 := cover(1), cover(2)
		missingOlder, missingNewer, throttledDue := cover(3), cover(4), cover(5)
		missingLater, warmedOldest, warmedOld, warmedFresh := cover(6), cover(7), cover(8), cover(9)
		h.seed(t, never1, never2, missingOlder, missingNewer, throttledDue, missingLater, warmedOldest, warmedOld, warmedFresh)
		unreferenced := cover(0)
		h.exec(t, `INSERT INTO image_manager (url, status, warmed_at, next_attempt_at, attempts, last_http_status) VALUES
			($1, 'missing',   NULL,                          now() - interval '2 days', 1, 404),
			($2, 'missing',   NULL,                          now() - interval '1 day',  1, 404),
			($3, 'throttled', NULL,                          now() - interval '1 hour', 1, 429),
			($4, 'missing',   NULL,                          now() + interval '1 day',  1, 404),
			($5, 'warmed',    now() - interval '40 days',    NULL,                      1, 200),
			($6, 'warmed',    now() - interval '31 days',    NULL,                      1, 200),
			($7, 'warmed',    now() - interval '1 day',      NULL,                      1, 200),
			($8, 'warmed',    now() - interval '90 days',    NULL,                      1, 200)`,
			missingOlder, missingNewer, throttledDue, missingLater, warmedOldest, warmedOld, warmedFresh, unreferenced)

		got, err := q.ListImageWarmBatch(ctx, toPgInterval(imageWarmRecheckAfter), 100)
		require.NoError(t, err)
		assert.Equal(t, []string{
			never1, never2, // no row
			missingOlder, missingNewer, throttledDue, // due, longest due first
			warmedOldest, warmedOld, // a month old, oldest first
		}, got, "not due: missingLater and warmedFresh; no longer referenced: unreferenced")

		got, err = q.ListImageWarmBatch(ctx, toPgInterval(imageWarmRecheckAfter), 3)
		require.NoError(t, err)
		assert.Equal(t, []string{never1, never2, missingOlder}, got, "the cap is honoured")
	})

	t.Run("a 200 is warmed and not asked for again until it is a month old", func(t *testing.T) {
		h.reset(t)
		logs := captureImageWarmLogs(t)
		img := cover(1)
		h.seed(t, img)
		stub := newWarmStub(t, func(int, string) warmStubAnswer { return warmStubAnswer{status: http.StatusOK} })
		w := h.worker()

		h.pass(t, w)
		assert.Equal(t, []string{warmPathOf(img)}, stub.requested())
		assert.Equal(t, 1, h.count(t, `SELECT count(*) FROM image_manager WHERE url = $1 AND status = 'warmed'
			AND warmed_at > now() - interval '1 minute' AND next_attempt_at IS NULL
			AND attempts = 1 AND last_http_status = 200`, img))

		h.pass(t, w)
		assert.Len(t, stub.requested(), 1, "a warmed URL younger than the re-check interval is not asked for")

		h.exec(t, `UPDATE image_manager SET warmed_at = now() - interval '31 days' WHERE url = $1`, img)
		h.pass(t, w)
		assert.Equal(t, []string{warmPathOf(img), warmPathOf(img)}, stub.requested(), "a month on, it is asked for again")
		assert.Equal(t, 1, h.count(t, `SELECT count(*) FROM image_manager WHERE url = $1 AND status = 'warmed'
			AND warmed_at > now() - interval '1 minute' AND attempts = 2`, img))
		assert.Empty(t, logs.messages(slog.LevelWarn))
		assert.Empty(t, logs.messages(slog.LevelError))
		assert.Equal(t, "done", logs.summary(t)["stopped"])
	})

	t.Run("a 4xx is missing, skipped for a month, then asked again", func(t *testing.T) {
		h.reset(t)
		captureImageWarmLogs(t) // only to keep the pass's lines out of the test output
		notFound, gone, unavailable := cover(1), cover(2), cover(3)
		h.seed(t, notFound, gone, unavailable)
		stub := newWarmStub(t, func(n int, path string) warmStubAnswer {
			switch {
			case n > 3:
				return warmStubAnswer{status: http.StatusOK} // AniList has the file again
			case path == warmPathOf(gone):
				return warmStubAnswer{status: http.StatusGone}
			case path == warmPathOf(unavailable):
				return warmStubAnswer{status: http.StatusUnavailableForLegalReasons}
			default:
				return warmStubAnswer{status: http.StatusNotFound}
			}
		})
		w := h.worker()

		h.pass(t, w)
		assert.Len(t, stub.requested(), 3)
		for img, status := range map[string]int{notFound: 404, gone: 410, unavailable: 451} {
			assert.Equal(t, 1, h.count(t, `SELECT count(*) FROM image_manager WHERE url = $1 AND status = 'missing'
				AND next_attempt_at BETWEEN now() + interval '29 days 23 hours' AND now() + interval '30 days'
				AND warmed_at IS NULL AND attempts = 1 AND last_http_status = $2`, img, status), img)
		}

		h.pass(t, w)
		assert.Len(t, stub.requested(), 3, "a missing URL is not asked about before next_attempt_at")

		h.exec(t, `UPDATE image_manager SET next_attempt_at = now() - interval '1 second' WHERE url = $1`, notFound)
		h.pass(t, w)
		assert.Equal(t, warmPathOf(notFound), stub.requested()[3], "once due it is asked again")
		assert.Len(t, stub.requested(), 4)
		assert.Equal(t, 1, h.count(t, `SELECT count(*) FROM image_manager WHERE url = $1 AND status = 'warmed'
			AND next_attempt_at IS NULL AND attempts = 2 AND last_http_status = 200`, notFound),
			"and warmed, now that AniList serves it")
	})

	t.Run("a path outside the allowlist is recorded missing and never requested", func(t *testing.T) {
		h.reset(t)
		logs := captureImageWarmLogs(t)
		upload := anilistCDNPrefix + "user/avatar/large/b5123-x.png"
		img := cover(1)
		h.seed(t, upload, img)
		stub := newWarmStub(t, func(int, string) warmStubAnswer { return warmStubAnswer{status: http.StatusOK} })
		w := h.worker()

		h.pass(t, w)
		assert.Equal(t, []string{warmPathOf(img)}, stub.requested())
		assert.Equal(t, 1, h.count(t, `SELECT count(*) FROM image_manager WHERE url = $1 AND status = 'missing'
			AND last_http_status IS NULL AND next_attempt_at > now() + interval '29 days'`, upload),
			"recorded with no status: no request was sent")
		assert.Contains(t, logs.messages(slog.LevelWarn), "image warm: path outside the allowlist, not requested")
		assert.EqualValues(t, 1, logs.summary(t)["refused"])

		h.pass(t, w)
		assert.Len(t, stub.requested(), 1, "and it does not head the next batch")
	})

	t.Run("a 429 stops the pass at once and keeps the next passes out until Retry-After", func(t *testing.T) {
		h.reset(t)
		logs := captureImageWarmLogs(t)
		first, second, third := cover(1), cover(2), cover(3)
		h.seed(t, first, second, third)
		stub := newWarmStub(t, func(n int, _ string) warmStubAnswer {
			if n == 1 {
				return warmStubAnswer{status: http.StatusTooManyRequests, retryAfter: "120"}
			}
			return warmStubAnswer{status: http.StatusOK}
		})
		w := h.worker()

		h.pass(t, w)
		assert.Equal(t, []string{warmPathOf(first)}, stub.requested(), "no request after the 429")
		assert.Equal(t, 1, h.count(t, `SELECT count(*) FROM image_manager WHERE url = $1 AND status = 'throttled'
			AND next_attempt_at BETWEEN now() + interval '100 seconds' AND now() + interval '120 seconds'
			AND attempts = 1 AND last_http_status = 429`, first))
		assert.Equal(t, 1, h.count(t, `SELECT count(*) FROM image_manager`), "the URLs after it are untouched")
		assert.Contains(t, logs.messages(slog.LevelError), "image warm: AniList is throttling, pass stopped")
		assert.Equal(t, "throttled", logs.summary(t)["stopped"])
		blocked, err := q.ImageWarmBlocked(ctx)
		require.NoError(t, err)
		assert.True(t, blocked)

		h.pass(t, w)
		assert.Len(t, stub.requested(), 1, "the next pass sends nothing while the window lasts")
		assert.Contains(t, logs.messages(slog.LevelInfo), "image warm: AniList throttle window still open, skipping pass")

		h.exec(t, `UPDATE image_manager SET next_attempt_at = now() - interval '1 second' WHERE url = $1`, first)
		h.pass(t, w)
		assert.Equal(t, []string{warmPathOf(first), warmPathOf(second), warmPathOf(third), warmPathOf(first)},
			stub.requested(), "after it, the pass runs: the never-asked first, then the throttled URL as a retry")
		assert.Equal(t, 3, h.count(t, `SELECT count(*) FROM image_manager WHERE status = 'warmed'`))
	})

	t.Run("three 5xx in a row stop the pass and leave every row as it was", func(t *testing.T) {
		h.reset(t)
		logs := captureImageWarmLogs(t)
		imgs := []string{cover(1), cover(2), cover(3), cover(4), cover(5)}
		h.seed(t, imgs...)
		stub := newWarmStub(t, func(int, string) warmStubAnswer {
			return warmStubAnswer{status: http.StatusServiceUnavailable}
		})

		h.pass(t, h.worker())
		assert.Equal(t, warmPathsOf(imgs[:3]), stub.requested(), "the third 503 in a row is the last request")
		assert.Zero(t, h.count(t, `SELECT count(*) FROM image_manager`), "a 5xx is not an answer")
		assert.Contains(t, logs.messages(slog.LevelError), "image warm: upstream failing or refusing, pass stopped")
		assert.Equal(t, "failures", logs.summary(t)["stopped"])
	})

	t.Run("three 403s in a row stop the pass too, and mark nothing missing", func(t *testing.T) {
		h.reset(t)
		logs := captureImageWarmLogs(t)
		imgs := []string{cover(1), cover(2), cover(3), cover(4), cover(5)}
		h.seed(t, imgs...)
		stub := newWarmStub(t, func(int, string) warmStubAnswer { return warmStubAnswer{status: http.StatusForbidden} })

		h.pass(t, h.worker())
		assert.Equal(t, warmPathsOf(imgs[:3]), stub.requested(), "a refusal is being blocked, not a missing file")
		assert.Zero(t, h.count(t, `SELECT count(*) FROM image_manager`),
			"nothing is put off for a month because we were refused")
		assert.Contains(t, logs.messages(slog.LevelError), "image warm: upstream failing or refusing, pass stopped")
	})

	t.Run("two 5xx then a 200 do not stop the pass", func(t *testing.T) {
		h.reset(t)
		logs := captureImageWarmLogs(t)
		imgs := []string{cover(1), cover(2), cover(3), cover(4), cover(5)}
		h.seed(t, imgs...)
		stub := newWarmStub(t, func(n int, _ string) warmStubAnswer {
			if n == 3 {
				return warmStubAnswer{status: http.StatusOK}
			}
			return warmStubAnswer{status: http.StatusBadGateway}
		})

		h.pass(t, h.worker())
		assert.Equal(t, warmPathsOf(imgs), stub.requested(), "502, 502, 200, 502, 502: never three in a row")
		assert.Equal(t, []string{imgs[2]}, h.strings(t, `SELECT url FROM image_manager WHERE status = 'warmed'`))
		assert.Equal(t, 1, h.count(t, `SELECT count(*) FROM image_manager`))
		assert.Empty(t, logs.messages(slog.LevelError))
		assert.Equal(t, "done", logs.summary(t)["stopped"])
	})

	t.Run("an endpoint that refuses connections stops the pass with a WARN, not an ERROR", func(t *testing.T) {
		h.reset(t)
		logs := captureImageWarmLogs(t)
		h.seed(t, cover(1), cover(2))
		closed := httptest.NewServer(http.NotFoundHandler())
		base := closed.URL
		closed.Close()
		t.Setenv(imageWarmBaseURLEnv, base+"/warm/")

		h.pass(t, h.worker())
		assert.Zero(t, h.count(t, `SELECT count(*) FROM image_manager`))
		assert.Contains(t, logs.messages(slog.LevelWarn), "image warm: warm endpoint not reachable, pass stopped")
		assert.Empty(t, logs.messages(slog.LevelError), "nginx not accepting is what a deploy looks like: no Sentry")
		summary := logs.summary(t)
		assert.EqualValues(t, 1, summary["requests"], "it stops at the first")
		assert.Equal(t, "unreachable", summary["stopped"])
	})

	t.Run("the disk guard skips the pass without a request", func(t *testing.T) {
		h.reset(t)
		logs := captureImageWarmLogs(t)
		img := cover(1)
		h.seed(t, img)
		stub := newWarmStub(t, func(int, string) warmStubAnswer { return warmStubAnswer{status: http.StatusOK} })
		w := h.worker()

		w.freeBytes = func(path string) (uint64, error) {
			assert.Equal(t, "/", path, "the container root, which is the host disk")
			return imageWarmMinFreeBytes - 1, nil
		}
		h.pass(t, w)
		assert.Empty(t, stub.requested())
		assert.Contains(t, logs.messages(slog.LevelError), "image warm: host disk nearly full, skipping pass")

		w.freeBytes = func(string) (uint64, error) { return 0, errors.New("statfs: input/output error") }
		h.pass(t, w)
		assert.Empty(t, stub.requested(), "a figure it cannot read counts as no room")
		assert.Contains(t, logs.messages(slog.LevelError), "image warm: free disk space unreadable, skipping pass")
		assert.Zero(t, h.count(t, `SELECT count(*) FROM image_manager`))

		w.freeBytes = func(string) (uint64, error) { return imageWarmMinFreeBytes, nil }
		h.pass(t, w)
		assert.Equal(t, []string{warmPathOf(img)}, stub.requested(), "at the floor the pass runs")
	})

	t.Run("an empty IMAGE_WARM_BASE_URL makes no request", func(t *testing.T) {
		h.reset(t)
		logs := captureImageWarmLogs(t)
		h.seed(t, cover(1))
		stub := newWarmStub(t, func(int, string) warmStubAnswer { return warmStubAnswer{status: http.StatusOK} })
		w := h.worker()

		t.Setenv(imageWarmBaseURLEnv, "")
		h.pass(t, w)
		assert.Empty(t, stub.requested())
		assert.Contains(t, logs.messages(slog.LevelInfo), "image warm: off, no base URL")

		t.Setenv(imageWarmBaseURLEnv, "nginx:8090/warm/")
		h.pass(t, w)
		assert.Empty(t, stub.requested(), "nor does one that is not a URL")
		assert.Contains(t, logs.messages(slog.LevelError), "image warm: base URL not usable, skipping pass")
		assert.Zero(t, h.count(t, `SELECT count(*) FROM image_manager`))
	})

	t.Run("down drops the view and the table; up brings them back", func(t *testing.T) {
		objects := `SELECT (SELECT count(*) FROM pg_views WHERE schemaname = 'public' AND viewname = 'image_refs')
			+ (SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename = 'image_manager')`
		testutil.MigrateTo(t, uri, 48)
		assert.Zero(t, h.count(t, objects))
		testutil.MigrateTo(t, uri, testutil.LatestMigrationVersion(t))
		assert.Equal(t, 2, h.count(t, objects))
	})
}

// cover is a title's cover URL on AniList's CDN, ordered by n.
func cover(n int) string {
	return fmt.Sprintf("%smedia/anime/cover/large/bx%d-warm.png", anilistCDNPrefix, n)
}

// warmPathOf is the path the warm endpoint is asked for, for an image URL.
func warmPathOf(imageURL string) string { return strings.TrimPrefix(imageURL, anilistCDNPrefix) }

func warmPathsOf(imageURLs []string) []string {
	out := make([]string, len(imageURLs))
	for i, u := range imageURLs {
		out[i] = warmPathOf(u)
	}
	return out
}

// imageWarmHarness is the database side of the tests.
type imageWarmHarness struct {
	ctx  context.Context
	pool *pgxpool.Pool
	q    *dbgen.Queries
}

func (h *imageWarmHarness) exec(t *testing.T, sql string, args ...any) {
	t.Helper()
	_, err := h.pool.Exec(h.ctx, sql, args...)
	require.NoError(t, err, sql)
}

func (h *imageWarmHarness) count(t *testing.T, sql string, args ...any) int {
	t.Helper()
	var n int
	require.NoError(t, h.pool.QueryRow(h.ctx, sql, args...).Scan(&n), sql)
	return n
}

func (h *imageWarmHarness) strings(t *testing.T, sql string, args ...any) []string {
	t.Helper()
	rows, err := h.pool.Query(h.ctx, sql, args...)
	require.NoError(t, err, sql)
	out, err := pgx.CollectRows(rows, pgx.RowTo[string])
	require.NoError(t, err, sql)
	return out
}

// reset empties every table image_refs reads, and image_manager.
func (h *imageWarmHarness) reset(t *testing.T) {
	t.Helper()
	h.exec(t, `TRUNCATE anime_cache, characters, people, image_manager CASCADE`)
}

// seed references each URL as one title's cover.
func (h *imageWarmHarness) seed(t *testing.T, imageURLs ...string) {
	t.Helper()
	for i, u := range imageURLs {
		h.exec(t, `INSERT INTO anime_cache (anilist_id, title_romaji, cover_image_url) VALUES ($1, 'title', $2)`, i+1, u)
	}
}

// worker is the production worker with the disk guard told there is room:
// the guard has a test of its own, and the machine running these may well
// have less than the floor free.
func (h *imageWarmHarness) worker() *ImageWarmWorker {
	w := NewImageWarmWorker(h.q)
	w.freeBytes = func(string) (uint64, error) { return 1 << 40, nil }
	return w
}

// pass runs one pass as river would.
func (h *imageWarmHarness) pass(t *testing.T, w *ImageWarmWorker) {
	t.Helper()
	require.NoError(t, w.Work(h.ctx, &river.Job[ImageWarmArgs]{}))
}

// uncoveredImageColumns is the guard: every text column of a table in the
// public schema whose name says image, cover or banner, less the ones
// image_refs reads.  *_color columns hold a colour, not a URL, and
// users.avatar_url is a member's own photo, not an AniList image.
func (h *imageWarmHarness) uncoveredImageColumns(t *testing.T) []string {
	t.Helper()
	candidates := h.strings(t, `
		SELECT c.table_name || '.' || c.column_name
		FROM information_schema.columns c
		JOIN information_schema.tables tb
		  ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
		WHERE c.table_schema = 'public'
		  AND tb.table_type = 'BASE TABLE'
		  AND c.data_type IN ('text', 'character varying', 'character')
		  AND (c.column_name LIKE '%image%' OR c.column_name LIKE '%cover%' OR c.column_name LIKE '%banner%')
		ORDER BY 1`)
	require.Contains(t, candidates, "anime_cache.cover_image_url",
		"the scan must find the columns it guards, or it would pass by finding none")

	read := map[string]bool{}
	for _, col := range h.strings(t, `
		SELECT table_name || '.' || column_name
		FROM information_schema.view_column_usage
		WHERE view_schema = 'public' AND view_name = 'image_refs'`) {
		read[col] = true
	}
	var uncovered []string
	for _, col := range candidates {
		if strings.HasSuffix(col, "_color") || col == "users.avatar_url" || read[col] {
			continue
		}
		uncovered = append(uncovered, col)
	}
	return uncovered
}

// warmStubAnswer is what the stub endpoint answers one request with.
type warmStubAnswer struct {
	status     int
	retryAfter string
}

// warmStub stands in for nginx's warm location: it records every path asked
// for and answers each as the test says, by request number (from 1) and
// path.
type warmStub struct {
	mu     sync.Mutex
	paths  []string
	answer func(n int, path string) warmStubAnswer
}

// newWarmStub starts the stub and points IMAGE_WARM_BASE_URL at it for the
// rest of the test.
func newWarmStub(t *testing.T, answer func(n int, path string) warmStubAnswer) *warmStub {
	t.Helper()
	s := &warmStub{answer: answer}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path, ok := strings.CutPrefix(r.URL.Path, "/warm/")
		s.mu.Lock()
		s.paths = append(s.paths, path)
		n := len(s.paths)
		s.mu.Unlock()
		if !ok {
			http.NotFound(w, r)
			return
		}
		a := s.answer(n, path)
		if a.retryAfter != "" {
			w.Header().Set("Retry-After", a.retryAfter)
		}
		w.WriteHeader(a.status)
		_, _ = w.Write([]byte("original"))
	}))
	t.Cleanup(srv.Close)
	t.Setenv(imageWarmBaseURLEnv, srv.URL+"/warm/")
	return s
}

// requested is every path asked for so far, in order.
func (s *warmStub) requested() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string{}, s.paths...)
}

// imageWarmLogs records what the job logs, by level, so a test can say an
// outcome is an ERROR (which reaches Sentry) or only a WARN.
type imageWarmLogs struct {
	mu      sync.Mutex
	records []slog.Record
}

// captureImageWarmLogs routes slog.Default to a recorder for the rest of the
// test.
func captureImageWarmLogs(t *testing.T) *imageWarmLogs {
	t.Helper()
	prev := slog.Default()
	logs := &imageWarmLogs{}
	slog.SetDefault(slog.New(imageWarmLogHandler{logs}))
	t.Cleanup(func() { slog.SetDefault(prev) })
	return logs
}

// messages is every message logged at exactly level, in order.
func (l *imageWarmLogs) messages(level slog.Level) []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	var out []string
	for _, r := range l.records {
		if r.Level == level {
			out = append(out, r.Message)
		}
	}
	return out
}

// summary is the attributes of the last pass's summary line.
func (l *imageWarmLogs) summary(t *testing.T) map[string]any {
	t.Helper()
	l.mu.Lock()
	defer l.mu.Unlock()
	for i := len(l.records) - 1; i >= 0; i-- {
		r := l.records[i]
		if r.Message != "image warm pass done" {
			continue
		}
		out := map[string]any{}
		r.Attrs(func(a slog.Attr) bool {
			out[a.Key] = a.Value.Any()
			return true
		})
		return out
	}
	t.Fatal("no pass summary was logged")
	return nil
}

type imageWarmLogHandler struct{ logs *imageWarmLogs }

func (imageWarmLogHandler) Enabled(context.Context, slog.Level) bool { return true }

func (h imageWarmLogHandler) Handle(_ context.Context, r slog.Record) error {
	h.logs.mu.Lock()
	defer h.logs.mu.Unlock()
	h.logs.records = append(h.logs.records, r.Clone())
	return nil
}

func (h imageWarmLogHandler) WithAttrs([]slog.Attr) slog.Handler { return h }
func (h imageWarmLogHandler) WithGroup(string) slog.Handler      { return h }
