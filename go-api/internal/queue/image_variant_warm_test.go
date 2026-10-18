package queue

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/riverqueue/river"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// ---------------------------------------------------------------------------
// What the job asks for
// ---------------------------------------------------------------------------

// TestVariantWarmList_IsPageShapes holds the warm list inside the page
// shapes: a width the job asks for that nginx does not keep in the page zone
// is an encode stored where no page reads it.
func TestVariantWarmList_IsPageShapes(t *testing.T) {
	t.Parallel()

	roles := make([]string, 0, len(variantWarmList))
	for role, entry := range variantWarmList {
		roles = append(roles, role)
		shape, ok := pageShapes[entry.shape]
		require.True(t, ok, "role %q names shape %q, which is not a page shape", role, entry.shape)
		require.NotEmpty(t, entry.widths, "role %q asks for no width", role)
		for _, w := range entry.widths {
			assert.Contains(t, shape.widths, w,
				"role %q asks for %s at %d, which nginx does not keep in the page zone", role, entry.shape, w)
		}
	}
	slices.Sort(roles)
	assert.Equal(t, []string{"banner", "character", "cover", "recommended", "related", "staff", "voice"}, roles,
		"the roles are the names ListImageVariantWarmTargets gives them: change both together")
	assert.Equal(t, 8, variantWarmCharactersShown, "next-app's DETAIL_CHARACTERS_SHOWN")
	assert.Equal(t, 10, variantWarmStaffShown, "next-app's DETAIL_STAFF_SHOWN")
}

// TestPageShapes_Paths pins which AniList paths each kind of page image
// covers.  They are the sizes the database stores for the pages: a cover is
// AniList's large or medium file, a portrait its medium one.
func TestPageShapes_Paths(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		path string
		want imageShape // "" for none
	}{
		{"media/anime/cover/large/bx154587-qQTzQnEJJ3oB.jpg", shapeCover},
		{"media/anime/cover/medium/bx1-CXtrrkMpJ8Zq.png", shapeCover},
		{"media/manga/cover/medium/bx30002-7EzO7o21jzeF.jpg", shapeCover},
		{"media/anime/banner/154587-ivXNJ23SM1xB.jpg", shapeBanner},
		{"character/medium/b184887-Cr2eDLtk7Eb6.png", shapeCharacter},
		{"character/medium/default.jpg", shapeCharacter},
		{"staff/medium/n95185-XGpGZ8EQjE9O.jpeg", shapeStaff},

		{"media/anime/cover/extraLarge/bx1-CXtrrkMpJ8Zq.png", ""},
		{"media/anime/cover/small/bx1-CXtrrkMpJ8Zq.png", ""},
		{"media/manga/banner/30002-x.jpg", ""},
		{"character/large/b184887-Cr2eDLtk7Eb6.png", ""},
		{"staff/large/n95185-XGpGZ8EQjE9O.jpeg", ""},
		{"user/avatar/large/b5123-x.png", ""},
		{"media/anime/cover/large/sub/bx1.png", ""},
	} {
		for shape, ps := range pageShapes {
			for _, w := range ps.widths {
				assert.Equal(t, shape == tc.want, ps.allows(tc.path, w), "%s as %s at %d", tc.path, shape, w)
			}
			assert.False(t, ps.allows(tc.path, 100), "100 is no page width: %s as %s", tc.path, shape)
		}
	}
}

// TestVariantTargets turns rows into requests: every width any of an
// image's roles asks for, once each, smallest first, and nothing a page
// shape does not have.
func TestVariantTargets(t *testing.T) {
	t.Parallel()

	const cdn = anilistCDNPrefix
	cover := cdn + "media/anime/cover/large/bx1-CXtrrkMpJ8Zq.png"
	person := cdn + "staff/medium/n95185-XGpGZ8EQjE9O.jpeg"
	banner := cdn + "media/anime/banner/154587-ivXNJ23SM1xB.jpg"
	rows := []dbgen.ListImageVariantWarmTargetsRow{
		{Url: cover, Roles: []string{"cover", "related"}},
		{Url: person, Roles: []string{"staff", "voice"}},
		{Url: cdn + "character/large/b1-Cr2eDLtk7Eb6.png", Roles: []string{"character"}}, // an edit naming a size no page uses
		{Url: "https://lain.bgm.tv/pic/crt/l/ab/1.jpg", Roles: []string{"character"}},    // not AniList's
		{Url: cdn + "user/avatar/large/b5123-x.png", Roles: []string{"cover"}},           // outside the allowlist
		{Url: cdn + "staff/medium/n2-XGpGZ8EQjE9O.jpeg", Roles: []string{"character"}},   // a role of another kind
		{Url: banner, Roles: []string{"banner"}},
		{Url: cdn + "media/anime/cover/large/bx2-x.png", Roles: []string{"poster", "hero"}},
	}

	targets, unknown := variantTargets(rows)
	type urlWidth struct {
		url   string
		width int
	}
	var got []urlWidth
	for _, tg := range targets {
		got = append(got, urlWidth{tg.url, tg.width})
		assert.Equal(t, strings.TrimPrefix(tg.url, cdn), tg.path)
		assert.Equal(t, refreshGroup(tg.url), tg.group, "every width of an image is in the image's group")
	}
	assert.Equal(t, []urlWidth{
		{cover, 256}, {cover, 384}, {cover, 640},
		{person, 64}, {person, 96}, {person, 128},
		{banner, 1200}, {banner, 1920},
	}, got, "in the query's order; the cover's 256 and 384 once though two roles ask for them")
	assert.Equal(t, []string{"poster", "hero"}, unknown)
}

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

// The two expressions in nginx/default.p9.conf the job's query string has
// to satisfy, copied here as literals: the map $next_image_args_ok (the only
// query string /_next/image accepts; any other is a 400) and the map
// $next_image_key_args (the rewrite that files a mirror address under its
// AniList address, which is what makes the job's variant the one a page
// reads).  The test checks that the conf still has them as written here.
const (
	nginxNextImageArgsOK = `^url=[^&]+&w=[0-9]+&q=[0-9]+$`
	nginxNextImageKeyArg = `^url=https%3A%2F%2Fanimegoclub\.com%2Fimg%2Fanilist%2F(?<next_image_mirror_rest>(?:[A-Za-z0-9_.-]|%2F)+&w=[0-9]+&q=[0-9]+)$`
	nginxNextImageKeyTo  = `url=https%3A%2F%2Fs4.anilist.co%2Ffile%2Fanilistcdn%2F$next_image_mirror_rest`
)

// pageShapeSamples is one path of each kind of page image, its file name
// using every character the allowlist lets a name have.
var pageShapeSamples = map[imageShape]string{
	shapeCover:     "media/anime/cover/large/bx154587-qQTzQnEJJ3oB.jpg",
	shapeBanner:    "media/anime/banner/154587-ivXNJ23SM1xB.jpg",
	shapeCharacter: "character/medium/b184887-Cr2_Ek7.Eb6.png",
	shapeStaff:     "staff/medium/n95185-XGpGZ8EQjE9O.jpeg",
}

// TestVariantRequestURL_MatchesNginx builds the request for a path of each
// page shape at every width the job asks for, and holds it to nginx: it
// passes the args check, the key rewrite turns it into the AniList address a
// page's request is filed under, and nothing but the colon and the slashes
// is escaped, in upper case.
func TestVariantRequestURL_MatchesNginx(t *testing.T) {
	t.Parallel()

	conf, err := os.ReadFile(filepath.Join("..", "..", "..", "nginx", "default.p9.conf"))
	require.NoError(t, err)
	for _, literal := range []string{nginxNextImageArgsOK, nginxNextImageKeyArg, nginxNextImageKeyTo} {
		assert.Contains(t, string(conf), literal,
			"nginx/default.p9.conf no longer has this expression as the job's test copies it")
	}

	argsOK := regexp.MustCompile(nginxNextImageArgsOK)
	keyArg := regexp.MustCompile(nginxNextImageKeyArg)
	onlyColonAndSlashes := regexp.MustCompile(`^https%3A%2F%2Fanimegoclub\.com%2Fimg%2Fanilist%2F(?:[A-Za-z0-9_.-]|%2F)+$`)
	const base = "http://nginx:8090/_next/image"
	for role, entry := range variantWarmList {
		path := pageShapeSamples[entry.shape]
		for _, w := range entry.widths {
			raw := variantRequestURL(base, path, w)
			u, err := url.Parse(raw)
			require.NoError(t, err, raw)
			assert.Equal(t, base, u.Scheme+"://"+u.Host+u.Path, "%s at %d", role, w)

			assert.Regexp(t, argsOK, u.RawQuery, "%s at %d: nginx would answer 400", role, w)
			m := keyArg.FindStringSubmatch(u.RawQuery)
			require.NotNil(t, m, "%s at %d: nginx would not file %q under its AniList address", role, w, u.RawQuery)
			key := strings.Replace(nginxNextImageKeyTo, "$next_image_mirror_rest", m[1], 1)
			assert.Equal(t, "url="+url.QueryEscape(anilistCDNPrefix+path)+"&w="+strconv.Itoa(w)+"&q=85", key,
				"%s at %d: filed under the AniList address a page's request has", role, w)

			encoded, _, _ := strings.Cut(strings.TrimPrefix(u.RawQuery, "url="), "&")
			assert.Regexp(t, onlyColonAndSlashes, encoded, "%s at %d", role, w)
			assert.Equal(t, variantWarmMirrorPrefix+path, u.Query().Get("url"))
			assert.Equal(t, strconv.Itoa(w), u.Query().Get("w"))
			assert.Equal(t, "85", u.Query().Get("q"))
		}
	}
}

// TestImageVariantWarmBaseURL is the switch: empty is off, an internal URL
// is used as it is, and anything the job could not append its query string
// to is refused rather than requested.
//
// NOT t.Parallel: it sets the process environment.
func TestImageVariantWarmBaseURL(t *testing.T) {
	for _, tc := range []struct {
		env     string
		want    string
		wantErr bool
	}{
		{"", "", false},
		{"   ", "", false},
		{"http://nginx:8090/_next/image", "http://nginx:8090/_next/image", false},
		{" https://warm.internal/_next/image ", "https://warm.internal/_next/image", false},
		{"nginx:8090/_next/image", "", true},
		{"ftp://nginx/_next/image", "", true},
		{"http:///_next/image", "", true},
		{"http://nginx:8090", "", true},
		{"http://nginx:8090/", "", true},
		{"http://nginx:8090/_next/image?url=x", "", true},
		{"http://nginx:8090/_next/image?", "", true},
		{"http://nginx:8090/_next/image#x", "", true},
	} {
		t.Setenv(imageVariantWarmBaseURLEnv, tc.env)
		got, err := imageVariantWarmBaseURL()
		if tc.wantErr {
			assert.Error(t, err, "%q", tc.env)
		} else {
			assert.NoError(t, err, "%q", tc.env)
		}
		assert.Equal(t, tc.want, got, "%q", tc.env)
	}
}

// ---------------------------------------------------------------------------
// When, and which group
// ---------------------------------------------------------------------------

// cst is a time of day on an October 2026 date in Asia/Shanghai, as the
// instant a process running in UTC reads from its clock.  The job's
// container sets no TZ, so its clock reads UTC; t.Setenv("TZ") cannot move
// time.Local once the process runs, so the tests hand the job UTC instants
// instead, which is what it gets in production.
func cst(day, hour, minute, second int) time.Time {
	return time.Date(2026, time.October, day, hour, minute, second, 0, variantWarmZone).UTC()
}

// TestInVariantWarmWindow pins the window's edges in Asia/Shanghai, read
// from UTC instants: 01:00 to 07:00, less 03:15 to 04:00.
func TestInVariantWarmWindow(t *testing.T) {
	t.Parallel()

	elsewhere := time.FixedZone("UTC-7", -7*60*60)
	for _, tc := range []struct {
		at   time.Time
		want bool
	}{
		{cst(19, 0, 59, 59), false},
		{cst(19, 1, 0, 0), true},
		{cst(19, 3, 14, 59), true},
		{cst(19, 3, 15, 0), false},
		{cst(19, 3, 59, 59), false},
		{cst(19, 4, 0, 0), true},
		{cst(19, 6, 59, 59), true},
		{cst(19, 7, 0, 0), false},
		{cst(19, 12, 0, 0), false},
		{cst(19, 23, 30, 0), false},
	} {
		local := tc.at.In(variantWarmZone).Format(time.TimeOnly)
		require.Equal(t, time.UTC, tc.at.Location(), "the instant is read as a UTC process reads it")
		assert.Equal(t, tc.want, inVariantWarmWindow(tc.at), "%s Asia/Shanghai (%s UTC)", local, tc.at.Format(time.TimeOnly))
		assert.Equal(t, tc.want, inVariantWarmWindow(tc.at.In(elsewhere)),
			"%s Asia/Shanghai: the answer is the instant's, not the zone it is written in", local)
	}
	// 01:00 in Shanghai is 17:00 the evening before on a UTC clock: a window
	// read in the process zone would be eight hours off.
	assert.Equal(t, "2026-10-18 17:00", cst(19, 1, 0, 0).Format("2006-01-02 15:04"))

	for _, tc := range []struct {
		at, end time.Time
	}{
		{cst(19, 1, 30, 0), cst(19, 3, 15, 0)},
		{cst(19, 3, 14, 59), cst(19, 3, 15, 0)},
		{cst(19, 4, 0, 0), cst(19, 7, 0, 0)},
		{cst(19, 6, 59, 0), cst(19, 7, 0, 0)},
		{cst(19, 3, 30, 0), cst(19, 3, 30, 0)}, // outside: no time left
		{cst(19, 9, 0, 0), cst(19, 9, 0, 0)},
	} {
		got := variantWarmWindowEnd(tc.at)
		assert.True(t, tc.end.Equal(got), "the stretch around %s ends at %s, not %s",
			tc.at.In(variantWarmZone).Format(time.TimeOnly), tc.end.In(variantWarmZone).Format(time.TimeOnly),
			got.In(variantWarmZone).Format(time.TimeOnly))
	}
}

// TestRefreshGroups: a night is its Shanghai date, consecutive nights take
// consecutive groups, and so in any 25 nights in a row every image's group
// comes round exactly once.
func TestRefreshGroups(t *testing.T) {
	t.Parallel()

	night := variantWarmNight(cst(19, 1, 30, 0))
	assert.Equal(t, time.Date(2026, time.October, 19, 0, 0, 0, 0, time.UTC).Unix()/86400, night,
		"01:30 on the 19th in Shanghai is the 19th's night, though UTC still reads the 18th")
	assert.Equal(t, night, variantWarmNight(cst(19, 6, 59, 0)), "a night's passes share it")
	assert.Equal(t, night+1, variantWarmNight(cst(20, 1, 0, 0)))

	seen := map[int]int{}
	for n := night; n < night+imageVariantWarmGroups; n++ {
		seen[tonightsGroup(n)]++
	}
	require.Len(t, seen, imageVariantWarmGroups, "25 consecutive nights take 25 different groups")
	for g := 0; g < imageVariantWarmGroups; g++ {
		assert.Equal(t, 1, seen[g], "group %d", g)
	}

	var rows []dbgen.ListImageVariantWarmTargetsRow
	for n := 0; n < 200; n++ {
		rows = append(rows, portraitRow(n))
	}
	targets, _ := variantTargets(rows)
	require.Len(t, targets, 400)
	groups := map[int]bool{}
	for _, tg := range targets {
		require.GreaterOrEqual(t, tg.group, 0)
		require.Less(t, tg.group, imageVariantWarmGroups)
		groups[tg.group] = true
		times := 0
		for n := night + 3; n < night+3+imageVariantWarmGroups; n++ {
			if tonightsGroup(n) == tg.group {
				times++
			}
		}
		assert.Equal(t, 1, times, "%s at %d is refreshed once in any 25 nights", tg.url, tg.width)
	}
	assert.Len(t, groups, imageVariantWarmGroups, "200 images spread over every group")
	assert.Equal(t, refreshGroup(variantPortrait(7)), refreshGroup(variantPortrait(7)), "a URL keeps its group")
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

// TestClassifyVariant_AgainstARealClient reads each answer through the
// production client and a real socket, HEAD and all.
func TestClassifyVariant_AgainstARealClient(t *testing.T) {
	t.Parallel()

	target := variantTarget{path: "character/medium/b1.png", width: 64}
	for _, tc := range []struct {
		status int
		cache  string
		want   variantAnswerKind
	}{
		{http.StatusOK, "HIT", variantHit},
		{http.StatusOK, "STALE", variantHit},
		{http.StatusOK, "UPDATING", variantHit},
		{http.StatusOK, "REVALIDATED", variantHit},
		{http.StatusOK, "hit", variantHit},
		{http.StatusOK, "MISS", variantFilled},
		{http.StatusOK, "EXPIRED", variantFilled},
		{http.StatusOK, "BYPASS", variantRefreshed},
		{http.StatusOK, "", variantFailed},
		{http.StatusOK, "DUNNO", variantFailed},
		{http.StatusServiceUnavailable, "", variantBusy},
		{http.StatusTooManyRequests, "", variantBusy},
		{http.StatusBadRequest, "", variantFailed},
		{http.StatusUnauthorized, "", variantFailed},
		{http.StatusForbidden, "", variantFailed},
		{http.StatusNotFound, "", variantMissing},
		{http.StatusGone, "", variantMissing},
		{http.StatusUnavailableForLegalReasons, "", variantMissing},
		{http.StatusInternalServerError, "", variantFailed},
		{http.StatusBadGateway, "", variantFailed},
		{http.StatusGatewayTimeout, "", variantFailed},
		{http.StatusFound, "", variantFailed},
		{http.StatusNoContent, "", variantFailed},
	} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			assert.Equal(t, http.MethodHead, r.Method)
			if tc.cache != "" {
				w.Header().Set(variantWarmCacheStatusHeader, tc.cache)
			}
			if tc.status == http.StatusFound {
				w.Header().Set("Location", "https://animegoclub.com/")
			}
			w.WriteHeader(tc.status)
		}))
		a := NewImageVariantWarmWorker(nil).ask(context.Background(), srv.URL+"/_next/image", target, false)
		srv.Close()
		assert.Equal(t, tc.want, a.kind, "%d %q", tc.status, tc.cache)
		assert.Equal(t, tc.status, a.status, "%d %q", tc.status, tc.cache)
	}

	t.Run("a closed port is unreachable", func(t *testing.T) {
		t.Parallel()
		srv := httptest.NewServer(http.NotFoundHandler())
		base := srv.URL
		srv.Close()
		a := NewImageVariantWarmWorker(nil).ask(context.Background(), base+"/_next/image", target, false)
		assert.Equal(t, variantUnreachable, a.kind, "%v", a.err)
	})

	t.Run("no answer within the request timeout is a failure", func(t *testing.T) {
		t.Parallel()
		release := make(chan struct{})
		srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { <-release }))
		t.Cleanup(srv.Close)
		t.Cleanup(func() { close(release) })
		w := NewImageVariantWarmWorker(nil)
		w.client.Timeout = 50 * time.Millisecond
		a := w.ask(context.Background(), srv.URL+"/_next/image", target, false)
		assert.Equal(t, variantFailed, a.kind, "%v", a.err)
	})
}

// TestImageVariantWarmTiming pins how the pass's bounds relate, so changing
// one cannot quietly break another.
func TestImageVariantWarmTiming(t *testing.T) {
	t.Parallel()

	assert.Greater(t, imageVariantWarmTimeout, imageVariantWarmPassBudget+imageVariantWarmRequestTimeout,
		"a request that starts as the budget runs out must be allowed to finish")
	assert.Less(t, imageVariantWarmTimeout, imageVariantWarmInterval, "a pass ends before the next one is due")
	assert.Less(t, imageVariantWarmTimeout, time.Hour, "river's rescuer takes a job running an hour for a dead one")
	assert.Greater(t, imageVariantWarmRequestTimeout, 60*time.Second,
		"longer than nginx waits on the optimizer, so nginx answers first")
	assert.Equal(t, imageVariantWarmRequestTimeout, NewImageVariantWarmWorker(nil).client.Timeout)
	assert.Equal(t, 5*time.Millisecond, imageVariantWarmRequestGap, "about 200 requests a second")
	assert.Equal(t, 5*time.Second, imageVariantWarmSlowAfter)
	assert.Equal(t, 10*time.Minute, imageVariantWarmPause)
	assert.Less(t, time.Duration(imageVariantWarmGroups)*24*time.Hour, 30*24*time.Hour,
		"every variant is refreshed inside the 30 days nginx keeps it valid")
}

// ---------------------------------------------------------------------------
// Passes
// ---------------------------------------------------------------------------

// TestImageVariantWarm_Pass runs whole passes against a stand-in for nginx's
// internal location, on a clock the test moves.
//
// NOT parallel: the subtests set IMAGE_VARIANT_WARM_BASE_URL and swap
// slog.Default.
func TestImageVariantWarm_Pass(t *testing.T) {
	t.Run("an empty or unusable switch makes no request", func(t *testing.T) {
		logs := captureImageWarmLogs(t)
		clock := newVariantClock(cst(19, 1, 30, 0))
		store := newVariantStore(relatedRow(1))
		stub := newVariantStub(t, clock, always(stubHit))
		w := newTestVariantWorker(store, clock)

		t.Setenv(imageVariantWarmBaseURLEnv, "")
		runVariantPass(t, w)
		assert.Contains(t, logs.messages(slog.LevelInfo), "image variant warm: off, no base URL")

		t.Setenv(imageVariantWarmBaseURLEnv, "nginx:8090/_next/image")
		runVariantPass(t, w)
		assert.Contains(t, logs.messages(slog.LevelError), "image variant warm: base URL not usable, skipping pass")

		assert.Empty(t, stub.requests())
		assert.Zero(t, store.calls(), "nor reads the list")
	})

	t.Run("the window's edges decide whether a pass asks at all", func(t *testing.T) {
		for _, tc := range []struct {
			at  time.Time
			ask bool
		}{
			{cst(19, 0, 59, 0), false},
			{cst(19, 1, 0, 0), true},
			{cst(19, 3, 14, 0), true},
			{cst(19, 3, 15, 0), false},
			{cst(19, 3, 59, 0), false},
			{cst(19, 4, 0, 0), true},
			{cst(19, 6, 59, 0), true},
			{cst(19, 7, 0, 0), false},
		} {
			logs := captureImageWarmLogs(t)
			clock := newVariantClock(tc.at)
			stub := newVariantStub(t, clock, always(stubHit))
			runVariantPass(t, newTestVariantWorker(newVariantStore(relatedRow(1)), clock))
			label := tc.at.In(variantWarmZone).Format("15:04") + " Asia/Shanghai"
			if tc.ask {
				assert.Len(t, stub.requests(), 2, "%s: both widths", label)
				assert.Equal(t, "done", variantSummary(t, logs)["stopped"], label)
			} else {
				assert.Empty(t, stub.requests(), label)
				assert.Contains(t, logs.messages(slog.LevelInfo),
					"image variant warm: outside the night window, skipping pass", label)
			}
			assert.Empty(t, logs.messages(slog.LevelError), label)
		}
	})

	t.Run("a pass stops when the window closes under it", func(t *testing.T) {
		logs := captureImageWarmLogs(t)
		clock := newVariantClock(cst(19, 3, 10, 0))
		stub := newVariantStub(t, clock, func(n int, _ variantStubRequest) variantStubAnswer {
			if n == 2 {
				return variantStubAnswer{status: http.StatusOK, cacheStatus: "HIT", took: 5 * time.Minute}
			}
			return stubHit
		})
		w := newTestVariantWorker(newVariantStore(relatedRow(1), relatedRow(2)), clock)
		w.slowAfter = time.Hour // only the window is under test
		runVariantPass(t, w)
		assert.Len(t, stub.requests(), 2, "the second answer arrives at 03:15, and nothing is sent after it")
		summary := variantSummary(t, logs)
		assert.Equal(t, "window", summary["stopped"])
		assert.EqualValues(t, 2, summary["cursorEnd"])
	})

	t.Run("a host disk under 10 GiB skips the pass without a request", func(t *testing.T) {
		logs := captureImageWarmLogs(t)
		clock := newVariantClock(cst(19, 1, 30, 0))
		store := newVariantStore(relatedRow(1))
		stub := newVariantStub(t, clock, always(stubHit))
		w := newTestVariantWorker(store, clock)

		w.freeBytes = func(path string) (uint64, error) {
			assert.Equal(t, "/", path, "the container root, which is the host disk")
			return imageWarmMinFreeBytes - 1, nil
		}
		runVariantPass(t, w)
		assert.Contains(t, logs.messages(slog.LevelError), "image variant warm: host disk nearly full, skipping pass")

		w.freeBytes = func(string) (uint64, error) { return 0, errors.New("statfs: input/output error") }
		runVariantPass(t, w)
		assert.Contains(t, logs.messages(slog.LevelError), "image variant warm: free disk space unreadable, skipping pass")
		assert.Empty(t, stub.requests())
		assert.Zero(t, store.calls())

		w.freeBytes = func(string) (uint64, error) { return imageWarmMinFreeBytes, nil }
		runVariantPass(t, w)
		assert.Len(t, stub.requests(), 2, "at the floor the pass runs")
	})

	t.Run("each request is a HEAD in the pages' form, and the summary counts every answer", func(t *testing.T) {
		logs := captureImageWarmLogs(t)
		rows := []dbgen.ListImageVariantWarmTargetsRow{relatedRow(1), relatedRow(2), relatedRow(3), relatedRow(4)}
		clock := newVariantClock(nightAvoiding(t, rows).Add(30 * time.Minute))
		statuses := []string{"HIT", "MISS", "BYPASS", "STALE", "EXPIRED", "UPDATING", "REVALIDATED", "HIT"}
		stub := newVariantStub(t, clock, func(n int, _ variantStubRequest) variantStubAnswer {
			return variantStubAnswer{status: http.StatusOK, cacheStatus: statuses[n-1]}
		})
		runVariantPass(t, newTestVariantWorker(newVariantStore(rows...), clock))

		reqs := stub.requests()
		require.Len(t, reqs, 8)
		for i, r := range reqs {
			assert.Equal(t, http.MethodHead, r.method)
			assert.Equal(t, "/_next/image", r.path)
			assert.Equal(t, "image/avif,image/webp,*/*", r.accept)
			assert.Empty(t, r.refresh, "no image is in tonight's group")
			assert.Regexp(t, nginxNextImageArgsOK, r.rawQuery)
			assert.Equal(t, "85", r.quality)
			assert.Equal(t, variantCover(i/2+1), r.anilistURL(), "in the list's order")
			assert.Equal(t, []int{256, 384}[i%2], r.width)
		}
		summary := variantSummary(t, logs)
		for key, want := range map[string]any{
			"targets": 8, "cursorStart": 0, "cursorEnd": 8, "requests": 8,
			"hit": 5, "filled": 2, "refreshed": 1, "missing": 0, "failed": 0, "paused": 0,
			"stopped": "done",
			"night":   clock.started().In(variantWarmZone).Format(time.DateOnly),
			"group":   tonightsGroup(variantWarmNight(clock.started())),
		} {
			assert.EqualValues(t, want, summary[key], key)
		}
		assert.Contains(t, summary, "duration")
		assert.Empty(t, logs.messages(slog.LevelWarn))
		assert.Empty(t, logs.messages(slog.LevelError))
	})

	t.Run("the refresh header goes with exactly tonight's group, and its BYPASS counts as refreshed", func(t *testing.T) {
		logs := captureImageWarmLogs(t)
		var rows []dbgen.ListImageVariantWarmTargetsRow
		for n := 0; n < 60; n++ {
			rows = append(rows, portraitRow(n))
		}
		group := refreshGroup(variantPortrait(0))
		clock := newVariantClock(nightFor(t, group).Add(10 * time.Minute))
		stub := newVariantStub(t, clock, func(_ int, r variantStubRequest) variantStubAnswer {
			if r.refresh == "1" {
				return variantStubAnswer{status: http.StatusOK, cacheStatus: "BYPASS"}
			}
			return stubHit
		})
		runVariantPass(t, newTestVariantWorker(newVariantStore(rows...), clock))

		reqs := stub.requests()
		require.Len(t, reqs, 120)
		inGroup := 0
		for _, r := range reqs {
			want := ""
			if refreshGroup(r.anilistURL()) == group {
				want = "1"
				inGroup++
			}
			assert.Equal(t, want, r.refresh, "%s at %d", r.anilistURL(), r.width)
		}
		require.Positive(t, inGroup)
		require.Less(t, inGroup, 120, "the other groups are asked without it")
		summary := variantSummary(t, logs)
		assert.EqualValues(t, group, summary["group"])
		assert.EqualValues(t, inGroup, summary["refreshed"])
		assert.EqualValues(t, 120-inGroup, summary["hit"])
		assert.Empty(t, logs.messages(slog.LevelWarn))
	})

	t.Run("a refresh nginx did not do is a WARN once a pass", func(t *testing.T) {
		logs := captureImageWarmLogs(t)
		row := relatedRow(1)
		clock := newVariantClock(nightFor(t, refreshGroup(row.Url)).Add(10 * time.Minute))
		stub := newVariantStub(t, clock, always(stubHit))
		runVariantPass(t, newTestVariantWorker(newVariantStore(row), clock))
		require.Len(t, stub.requests(), 2)
		assert.Equal(t, "1", stub.requests()[0].refresh)
		assert.Equal(t, []string{"image variant warm: a refresh was asked for and not done (first of the pass)"},
			logs.messages(slog.LevelWarn), "one WARN for the pass, not one per variant")
		assert.Empty(t, logs.messages(slog.LevelError), "the variants are stored; only the refresh is missing")
		assert.EqualValues(t, 2, variantSummary(t, logs)["hit"])
	})

	t.Run("a 503 pauses the pass ten minutes, is no failure, and the pass moves on", func(t *testing.T) {
		logs := captureImageWarmLogs(t)
		rows := []dbgen.ListImageVariantWarmTargetsRow{relatedRow(1), relatedRow(2), relatedRow(3)}
		clock := newVariantClock(nightAvoiding(t, rows))
		stub := newVariantStub(t, clock, func(n int, _ variantStubRequest) variantStubAnswer {
			if n <= 4 {
				return variantStubAnswer{status: http.StatusServiceUnavailable}
			}
			return stubHit
		})
		runVariantPass(t, newTestVariantWorker(newVariantStore(rows...), clock))

		assert.Equal(t, []string{
			variantCover(1) + " 256", variantCover(1) + " 384", variantCover(2) + " 256",
			variantCover(2) + " 384", variantCover(3) + " 256", variantCover(3) + " 384",
		}, stub.asked(), "each variant once: the one that met a 503 is not asked again tonight")
		assert.Equal(t, []time.Duration{10 * time.Minute, 10 * time.Minute, 10 * time.Minute, 10 * time.Minute},
			clock.pauses(), "four 503s in a row, four pauses, and no stop")
		summary := variantSummary(t, logs)
		assert.EqualValues(t, 4, summary["paused"])
		assert.EqualValues(t, 0, summary["failed"])
		assert.EqualValues(t, 2, summary["hit"])
		assert.Equal(t, "done", summary["stopped"])
		assert.Empty(t, logs.messages(slog.LevelError))
	})

	t.Run("a 429 is the optimizer busy too", func(t *testing.T) {
		logs := captureImageWarmLogs(t)
		row := relatedRow(1)
		clock := newVariantClock(nightAvoiding(t, []dbgen.ListImageVariantWarmTargetsRow{row}))
		newVariantStub(t, clock, func(n int, _ variantStubRequest) variantStubAnswer {
			if n == 1 {
				return variantStubAnswer{status: http.StatusTooManyRequests}
			}
			return stubHit
		})
		runVariantPass(t, newTestVariantWorker(newVariantStore(row), clock))
		assert.Equal(t, []time.Duration{10 * time.Minute}, clock.pauses())
		assert.EqualValues(t, 0, variantSummary(t, logs)["failed"])
	})

	t.Run("an answer slower than the threshold pauses the pass and still counts as what it was", func(t *testing.T) {
		for _, tc := range []struct {
			name      string
			slowAfter time.Duration
			took      time.Duration
			pauses    int
		}{
			{"over the 5 s default", imageVariantWarmSlowAfter, 6 * time.Second, 1},
			{"at the 5 s default", imageVariantWarmSlowAfter, 5 * time.Second, 0},
			{"over a short threshold", 100 * time.Millisecond, 150 * time.Millisecond, 1},
			{"under a short threshold", 100 * time.Millisecond, 50 * time.Millisecond, 0},
		} {
			logs := captureImageWarmLogs(t)
			row := relatedRow(1)
			clock := newVariantClock(nightAvoiding(t, []dbgen.ListImageVariantWarmTargetsRow{row}))
			newVariantStub(t, clock, func(n int, _ variantStubRequest) variantStubAnswer {
				if n == 1 {
					return variantStubAnswer{status: http.StatusOK, cacheStatus: "MISS", took: tc.took}
				}
				return stubHit
			})
			w := newTestVariantWorker(newVariantStore(row), clock)
			w.slowAfter = tc.slowAfter
			runVariantPass(t, w)
			assert.Len(t, clock.pauses(), tc.pauses, tc.name)
			summary := variantSummary(t, logs)
			assert.EqualValues(t, tc.pauses, summary["paused"], tc.name)
			assert.EqualValues(t, 1, summary["filled"], tc.name)
			assert.EqualValues(t, 0, summary["failed"], tc.name)
		}
	})

	t.Run("a pause never outlasts the budget", func(t *testing.T) {
		logs := captureImageWarmLogs(t)
		rows := []dbgen.ListImageVariantWarmTargetsRow{relatedRow(1), relatedRow(2)}
		start := nightAvoiding(t, rows)
		clock := newVariantClock(start)
		stub := newVariantStub(t, clock, func(int, variantStubRequest) variantStubAnswer {
			return variantStubAnswer{status: http.StatusServiceUnavailable, took: 45 * time.Minute}
		})
		runVariantPass(t, newTestVariantWorker(newVariantStore(rows...), clock))
		assert.Len(t, stub.requests(), 1)
		assert.Equal(t, []time.Duration{5 * time.Minute}, clock.pauses(), "the five minutes left of the 50")
		assert.Equal(t, "time", variantSummary(t, logs)["stopped"])
	})

	t.Run("a pause never outlasts the window", func(t *testing.T) {
		logs := captureImageWarmLogs(t)
		clock := newVariantClock(cst(19, 3, 10, 0))
		stub := newVariantStub(t, clock, always(variantStubAnswer{status: http.StatusServiceUnavailable}))
		runVariantPass(t, newTestVariantWorker(newVariantStore(relatedRow(1), relatedRow(2)), clock))
		assert.Len(t, stub.requests(), 1)
		assert.Equal(t, []time.Duration{5 * time.Minute}, clock.pauses(), "until 03:15, when the backup's stretch starts")
		assert.Equal(t, "window", variantSummary(t, logs)["stopped"])
	})

	t.Run("a pause a deploy cuts short ends the pass quietly", func(t *testing.T) {
		logs := captureImageWarmLogs(t)
		row := relatedRow(1)
		clock := newVariantClock(nightAvoiding(t, []dbgen.ListImageVariantWarmTargetsRow{row}))
		newVariantStub(t, clock, always(variantStubAnswer{status: http.StatusServiceUnavailable}))
		w := newTestVariantWorker(newVariantStore(row), clock)
		passCtx, cancel := context.WithCancel(context.Background())
		t.Cleanup(cancel)
		w.sleep = func(ctx context.Context, _ time.Duration) error {
			cancel() // the worker is stopped, as a deploy stops it, during the pause
			return ctx.Err()
		}
		require.NoError(t, w.Work(passCtx, &river.Job[ImageVariantWarmArgs]{}))
		assert.Equal(t, "cancelled", variantSummary(t, logs)["stopped"])
		assert.Empty(t, logs.messages(slog.LevelWarn))
		assert.Empty(t, logs.messages(slog.LevelError))
	})

	t.Run("three 400s in a row stop the pass with an ERROR naming the args check", func(t *testing.T) {
		logs := captureImageWarmLogs(t)
		rows := []dbgen.ListImageVariantWarmTargetsRow{relatedRow(1), relatedRow(2), relatedRow(3)}
		clock := newVariantClock(nightAvoiding(t, rows))
		stub := newVariantStub(t, clock, always(variantStubAnswer{status: http.StatusBadRequest}))
		runVariantPass(t, newTestVariantWorker(newVariantStore(rows...), clock))

		assert.Len(t, stub.requests(), 3, "the third 400 in a row is the last request")
		summary := variantSummary(t, logs)
		assert.EqualValues(t, 3, summary["failed"])
		assert.EqualValues(t, 0, summary["missing"], "a 400 is the job's bug, never an image missing")
		assert.Equal(t, "failures", summary["stopped"])
		stopped := logAttrs(t, logs, "image variant warm: endpoint failing, pass stopped")
		assert.EqualValues(t, http.StatusBadRequest, stopped["status"])
		assert.Contains(t, stopped["hint"], "$next_image_args_ok")
	})

	t.Run("any three failures in a row stop the pass, a refusal and a 200 nginx did not cache among them", func(t *testing.T) {
		logs := captureImageWarmLogs(t)
		rows := []dbgen.ListImageVariantWarmTargetsRow{relatedRow(1), relatedRow(2), relatedRow(3)}
		clock := newVariantClock(nightAvoiding(t, rows))
		answers := []variantStubAnswer{
			{status: http.StatusInternalServerError},
			{status: http.StatusForbidden},
			{status: http.StatusOK}, // no X-Cache-Status
		}
		stub := newVariantStub(t, clock, func(n int, _ variantStubRequest) variantStubAnswer { return answers[n-1] })
		runVariantPass(t, newTestVariantWorker(newVariantStore(rows...), clock))

		assert.Len(t, stub.requests(), 3)
		assert.Equal(t, "failures", variantSummary(t, logs)["stopped"])
		stopped := logAttrs(t, logs, "image variant warm: endpoint failing, pass stopped")
		assert.EqualValues(t, http.StatusOK, stopped["status"])
		assert.Contains(t, stopped["hint"], "X-Cache-Status")
	})

	t.Run("a success between failures starts the run again", func(t *testing.T) {
		logs := captureImageWarmLogs(t)
		rows := []dbgen.ListImageVariantWarmTargetsRow{relatedRow(1), relatedRow(2), relatedRow(3)}
		clock := newVariantClock(nightAvoiding(t, rows))
		stub := newVariantStub(t, clock, func(n int, _ variantStubRequest) variantStubAnswer {
			if n == 3 || n == 6 {
				return stubHit
			}
			return variantStubAnswer{status: http.StatusInternalServerError}
		})
		runVariantPass(t, newTestVariantWorker(newVariantStore(rows...), clock))

		assert.Len(t, stub.requests(), 6, "500, 500, HIT, 500, 500, HIT: never three in a row")
		summary := variantSummary(t, logs)
		assert.EqualValues(t, 4, summary["failed"])
		assert.Equal(t, "done", summary["stopped"])
		assert.Empty(t, logs.messages(slog.LevelError))
	})

	t.Run("a 404 or 410 is missing, one WARN a pass, and no failure", func(t *testing.T) {
		logs := captureImageWarmLogs(t)
		rows := []dbgen.ListImageVariantWarmTargetsRow{relatedRow(1), relatedRow(2)}
		clock := newVariantClock(nightAvoiding(t, rows))
		answers := []int{http.StatusNotFound, http.StatusGone, http.StatusNotFound, http.StatusOK}
		stub := newVariantStub(t, clock, func(n int, _ variantStubRequest) variantStubAnswer {
			return variantStubAnswer{status: answers[n-1], cacheStatus: "HIT"}
		})
		runVariantPass(t, newTestVariantWorker(newVariantStore(rows...), clock))

		assert.Len(t, stub.requests(), 4, "three missing in a row do not stop the pass")
		summary := variantSummary(t, logs)
		assert.EqualValues(t, 3, summary["missing"])
		assert.EqualValues(t, 0, summary["failed"])
		assert.Equal(t, "done", summary["stopped"])
		assert.Equal(t, []string{"image variant warm: no image for a variant, the pass goes on (first of the pass)"},
			logs.messages(slog.LevelWarn))
		assert.Equal(t, variantCover(1), logAttrs(t, logs, logs.messages(slog.LevelWarn)[0])["url"], "the sample")
	})

	t.Run("a request nginx never answers is a failure, and a pause", func(t *testing.T) {
		logs := captureImageWarmLogs(t)
		row := relatedRow(1)
		clock := newVariantClock(nightAvoiding(t, []dbgen.ListImageVariantWarmTargetsRow{row}))
		newVariantStub(t, clock, func(n int, _ variantStubRequest) variantStubAnswer {
			if n == 1 {
				return variantStubAnswer{hang: true, took: 2 * time.Minute}
			}
			return stubHit
		})
		w := newTestVariantWorker(newVariantStore(row), clock)
		w.client.Timeout = 100 * time.Millisecond
		runVariantPass(t, w)
		summary := variantSummary(t, logs)
		assert.EqualValues(t, 1, summary["failed"])
		assert.EqualValues(t, 1, summary["paused"])
		assert.EqualValues(t, 1, summary["hit"])
		assert.Equal(t, "done", summary["stopped"])
	})

	t.Run("an endpoint that takes no connection stops the pass: a WARN, an ERROR from the third pass in a row", func(t *testing.T) {
		rows := []dbgen.ListImageVariantWarmTargetsRow{relatedRow(1)}
		clock := newVariantClock(nightAvoiding(t, rows))
		closed := httptest.NewServer(http.NotFoundHandler())
		closedBase := closed.URL + "/_next/image"
		closed.Close()
		w := newTestVariantWorker(newVariantStore(rows...), clock)

		// Literal counts, not the constant: the third pass is the contract.
		t.Setenv(imageVariantWarmBaseURLEnv, closedBase)
		for pass := 1; pass <= 2; pass++ {
			logs := captureImageWarmLogs(t)
			runVariantPass(t, w)
			assert.Contains(t, logs.messages(slog.LevelWarn), "image variant warm: endpoint not reachable, pass stopped", "pass %d", pass)
			assert.Empty(t, logs.messages(slog.LevelError), "pass %d could still be a deploy", pass)
			summary := variantSummary(t, logs)
			assert.Equal(t, "unreachable", summary["stopped"])
			assert.EqualValues(t, 1, summary["requests"], "it stops at the first")
			assert.EqualValues(t, 0, summary["cursorEnd"], "no answer: the variant is asked again next pass")
		}
		logs := captureImageWarmLogs(t)
		runVariantPass(t, w)
		assert.Contains(t, logs.messages(slog.LevelError), "image variant warm: endpoint not reachable pass after pass")

		// It answers: the list is done, and the count starts again.
		stub := newVariantStub(t, clock, always(stubHit))
		runVariantPass(t, w)
		assert.Len(t, stub.requests(), 2, "from the top: no request before got an answer")

		clock.set(clock.now().Add(24 * time.Hour)) // the next night
		t.Setenv(imageVariantWarmBaseURLEnv, closedBase)
		logs = captureImageWarmLogs(t)
		runVariantPass(t, w)
		assert.Contains(t, logs.messages(slog.LevelWarn), "image variant warm: endpoint not reachable, pass stopped")
		assert.Empty(t, logs.messages(slog.LevelError), "the count started again at the answers")
	})

	t.Run("a pass cancelled with a request in flight stops quietly and leaves the variant for the next pass", func(t *testing.T) {
		logs := captureImageWarmLogs(t)
		rows := []dbgen.ListImageVariantWarmTargetsRow{relatedRow(1), relatedRow(2)}
		clock := newVariantClock(nightAvoiding(t, rows))
		passCtx, cancel := context.WithCancel(context.Background())
		t.Cleanup(cancel)
		stub := newVariantStub(t, clock, func(n int, _ variantStubRequest) variantStubAnswer {
			if n == 2 {
				cancel() // the worker is stopped, as a deploy stops it, while nginx has the request
				return variantStubAnswer{hang: true}
			}
			return stubHit
		})
		w := newTestVariantWorker(newVariantStore(rows...), clock)
		require.NoError(t, w.Work(passCtx, &river.Job[ImageVariantWarmArgs]{}))
		summary := variantSummary(t, logs)
		assert.Equal(t, "cancelled", summary["stopped"])
		assert.EqualValues(t, 1, summary["cursorEnd"])
		assert.Empty(t, logs.messages(slog.LevelWarn))
		assert.Empty(t, logs.messages(slog.LevelError))

		runVariantPass(t, w)
		asked := stub.asked()
		assert.Equal(t, []string{
			variantCover(1) + " 256", variantCover(1) + " 384", // the second got no answer...
			variantCover(1) + " 384", variantCover(2) + " 256", variantCover(2) + " 384", // ...so it is asked again
		}, asked)
	})

	t.Run("tonight's list: a pass resumes where the last stopped, a done list is left alone, a new night starts over", func(t *testing.T) {
		rows := []dbgen.ListImageVariantWarmTargetsRow{relatedRow(1), relatedRow(2), relatedRow(3)}
		night := nightAvoiding(t, rows) // 01:00
		clock := newVariantClock(night.Add(time.Hour + 50*time.Minute))
		store := newVariantStore(rows...)
		stub := newVariantStub(t, clock, func(n int, _ variantStubRequest) variantStubAnswer {
			if n == 2 {
				return variantStubAnswer{status: http.StatusOK, cacheStatus: "HIT", took: 25 * time.Minute} // to 03:15
			}
			return stubHit
		})
		w := newTestVariantWorker(store, clock)
		w.slowAfter = time.Hour // the cursor is under test, not the brakes
		all := []string{
			variantCover(1) + " 256", variantCover(1) + " 384", variantCover(2) + " 256",
			variantCover(2) + " 384", variantCover(3) + " 256", variantCover(3) + " 384",
		}

		// 02:50: two variants, then the window closes.
		logs := captureImageWarmLogs(t)
		runVariantPass(t, w)
		assert.Equal(t, all[:2], stub.asked())
		summary := variantSummary(t, logs)
		assert.Equal(t, "window", summary["stopped"])
		assert.EqualValues(t, 0, summary["cursorStart"])
		assert.EqualValues(t, 2, summary["cursorEnd"])

		// 04:05: the rest, from the third.
		clock.set(night.Add(3*time.Hour + 5*time.Minute))
		logs = captureImageWarmLogs(t)
		runVariantPass(t, w)
		assert.Equal(t, all, stub.asked(), "the first two, then the four after them")
		summary = variantSummary(t, logs)
		assert.Equal(t, "done", summary["stopped"])
		assert.EqualValues(t, 2, summary["cursorStart"])
		assert.EqualValues(t, 6, summary["cursorEnd"])

		// 05:05: done tonight -- no request, and the list is not even read.
		clock.set(night.Add(4*time.Hour + 5*time.Minute))
		calls := store.calls()
		logs = captureImageWarmLogs(t)
		runVariantPass(t, w)
		assert.Len(t, stub.requests(), 6)
		assert.Equal(t, calls, store.calls())
		assert.Contains(t, logs.messages(slog.LevelInfo), "image variant warm: tonight's list is done, skipping pass")

		// A restart (a deploy) that night: a new process starts from the top.
		restarted := newTestVariantWorker(store, clock)
		runVariantPass(t, restarted)
		assert.Equal(t, all, stub.asked()[6:])

		// The next night: from the top again.
		clock.set(night.Add(24*time.Hour + 5*time.Minute))
		logs = captureImageWarmLogs(t)
		runVariantPass(t, w)
		assert.Equal(t, all, stub.asked()[12:])
		assert.EqualValues(t, 0, variantSummary(t, logs)["cursorStart"])
	})

	t.Run("a pass that runs out of budget stops there, and the next pass that night goes on from it", func(t *testing.T) {
		rows := []dbgen.ListImageVariantWarmTargetsRow{relatedRow(1), relatedRow(2)}
		night := nightAvoiding(t, rows)
		clock := newVariantClock(night)
		stub := newVariantStub(t, clock, func(n int, _ variantStubRequest) variantStubAnswer {
			if n == 1 {
				return variantStubAnswer{status: http.StatusOK, cacheStatus: "MISS", took: 51 * time.Minute}
			}
			return stubHit
		})
		w := newTestVariantWorker(newVariantStore(rows...), clock)
		w.slowAfter = time.Hour

		logs := captureImageWarmLogs(t)
		runVariantPass(t, w)
		assert.Len(t, stub.requests(), 1)
		assert.Equal(t, "time", variantSummary(t, logs)["stopped"])

		clock.set(night.Add(time.Hour))
		logs = captureImageWarmLogs(t)
		runVariantPass(t, w)
		assert.Equal(t, []string{
			variantCover(1) + " 256", variantCover(1) + " 384", variantCover(2) + " 256", variantCover(2) + " 384",
		}, stub.asked())
		assert.EqualValues(t, 1, variantSummary(t, logs)["cursorStart"])
	})

	t.Run("an empty list is done at once, and the night's later passes skip", func(t *testing.T) {
		clock := newVariantClock(cst(19, 1, 5, 0))
		store := newVariantStore()
		stub := newVariantStub(t, clock, always(stubHit))
		w := newTestVariantWorker(store, clock)

		logs := captureImageWarmLogs(t)
		runVariantPass(t, w)
		summary := variantSummary(t, logs)
		assert.EqualValues(t, 0, summary["targets"])
		assert.Equal(t, "done", summary["stopped"])

		clock.set(cst(19, 2, 5, 0))
		logs = captureImageWarmLogs(t)
		runVariantPass(t, w)
		assert.Contains(t, logs.messages(slog.LevelInfo), "image variant warm: tonight's list is done, skipping pass")
		assert.Empty(t, stub.requests())
		assert.Equal(t, 1, store.calls())
	})

	t.Run("a list that cannot be read is returned to river, and a role the warm list does not know is an ERROR", func(t *testing.T) {
		clock := newVariantClock(cst(19, 1, 5, 0))
		newVariantStub(t, clock, always(stubHit))

		store := newVariantStore()
		store.err = errors.New("connection reset")
		err := newTestVariantWorker(store, clock).Work(context.Background(), &river.Job[ImageVariantWarmArgs]{})
		require.Error(t, err)
		assert.Contains(t, err.Error(), "image variant warm: list targets")

		logs := captureImageWarmLogs(t)
		odd := newVariantStore(dbgen.ListImageVariantWarmTargetsRow{Url: variantCover(1), Roles: []string{"poster"}})
		runVariantPass(t, newTestVariantWorker(odd, clock))
		assert.Contains(t, logAttrs(t, logs, "image variant warm: the target query names roles the warm list does not know; "+
			"their images are not asked for")["roles"], "poster")
	})
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

// variantCover is a cover URL in the form a related work's row stores it.
func variantCover(n int) string {
	return fmt.Sprintf("%smedia/anime/cover/medium/bx%d-variant.jpg", anilistCDNPrefix, n)
}

// variantPortrait is a character's portrait URL.
func variantPortrait(n int) string {
	return fmt.Sprintf("%scharacter/medium/b%d-variant.png", anilistCDNPrefix, n)
}

// relatedRow is a row for a related work's cover: asked for at 256 and 384.
func relatedRow(n int) dbgen.ListImageVariantWarmTargetsRow {
	return dbgen.ListImageVariantWarmTargetsRow{Url: variantCover(n), Roles: []string{"related"}}
}

// portraitRow is a row for a character's portrait: asked for at 64 and 128.
func portraitRow(n int) dbgen.ListImageVariantWarmTargetsRow {
	return dbgen.ListImageVariantWarmTargetsRow{Url: variantPortrait(n), Roles: []string{"character"}}
}

// nightAvoiding is 01:00 on the first night of October whose refresh group
// none of the rows' images is in, so no request carries the refresh header.
func nightAvoiding(t *testing.T, rows []dbgen.ListImageVariantWarmTargetsRow) time.Time {
	t.Helper()
	groups := map[int]bool{}
	for _, r := range rows {
		groups[refreshGroup(r.Url)] = true
	}
	for day := 1; day <= 31; day++ {
		if at := cst(day, 1, 0, 0); !groups[tonightsGroup(variantWarmNight(at))] {
			return at
		}
	}
	t.Fatal("the rows cover every refresh group")
	return time.Time{}
}

// nightFor is 01:00 on the first night of October whose refresh group is g.
func nightFor(t *testing.T, g int) time.Time {
	t.Helper()
	for day := 1; day <= 31; day++ {
		if at := cst(day, 1, 0, 0); tonightsGroup(variantWarmNight(at)) == g {
			return at
		}
	}
	t.Fatalf("no October night takes group %d", g)
	return time.Time{}
}

// variantClock is the test's clock: it moves only when the test sets it, an
// answer says it took a while, or a pass pauses.
type variantClock struct {
	mu    sync.Mutex
	start time.Time
	t     time.Time
	slept []time.Duration
}

func newVariantClock(at time.Time) *variantClock { return &variantClock{start: at, t: at} }

func (c *variantClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *variantClock) started() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.start
}

func (c *variantClock) set(at time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.start, c.t = at, at
}

func (c *variantClock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

// sleep is the pass's pause: recorded, and the clock moved on by it.
func (c *variantClock) sleep(ctx context.Context, d time.Duration) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.slept = append(c.slept, d)
	c.t = c.t.Add(d)
	return nil
}

func (c *variantClock) pauses() []time.Duration {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]time.Duration{}, c.slept...)
}

// variantStoreFake is the list, as the test sets it.
type variantStoreFake struct {
	mu   sync.Mutex
	rows []dbgen.ListImageVariantWarmTargetsRow
	err  error
	n    int
}

func newVariantStore(rows ...dbgen.ListImageVariantWarmTargetsRow) *variantStoreFake {
	return &variantStoreFake{rows: rows}
}

func (s *variantStoreFake) ListImageVariantWarmTargets(_ context.Context, charactersShown, staffShown int32) ([]dbgen.ListImageVariantWarmTargetsRow, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.n++
	if charactersShown != variantWarmCharactersShown || staffShown != variantWarmStaffShown {
		return nil, fmt.Errorf("asked for the first %d characters and %d staff", charactersShown, staffShown)
	}
	return s.rows, s.err
}

func (s *variantStoreFake) calls() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.n
}

// newTestVariantWorker is the production worker on the test's clock, with no
// pacing, and the disk guard told there is room: the guard has a test of
// its own, and the machine running these may well have less than the floor.
func newTestVariantWorker(store ImageVariantWarmStore, clock *variantClock) *ImageVariantWarmWorker {
	w := NewImageVariantWarmWorker(store)
	w.freeBytes = func(string) (uint64, error) { return 1 << 40, nil }
	w.now = clock.now
	w.sleep = clock.sleep
	w.requestGap = 0
	return w
}

// runVariantPass runs one pass as river would.
func runVariantPass(t *testing.T, w *ImageVariantWarmWorker) {
	t.Helper()
	require.NoError(t, w.Work(context.Background(), &river.Job[ImageVariantWarmArgs]{}))
}

// variantStubAnswer is what the stand-in answers one request with.
type variantStubAnswer struct {
	status      int
	cacheStatus string // X-Cache-Status; "" sends none
	// took moves the test clock on before the answer, as if it had taken
	// that long to arrive.
	took time.Duration
	// hang answers nothing and holds the request until the client lets go:
	// its timeout, or the pass being cancelled.
	hang bool
}

var stubHit = variantStubAnswer{status: http.StatusOK, cacheStatus: "HIT"}

func always(a variantStubAnswer) func(int, variantStubRequest) variantStubAnswer {
	return func(int, variantStubRequest) variantStubAnswer { return a }
}

// variantStubRequest is one request as the stand-in saw it.
type variantStubRequest struct {
	method, path, rawQuery string
	image                  string // the url parameter, decoded: a mirror address
	width                  int
	quality                string
	accept, refresh        string
}

// anilistURL is the AniList URL the request is for.
func (r variantStubRequest) anilistURL() string {
	return anilistCDNPrefix + strings.TrimPrefix(r.image, variantWarmMirrorPrefix)
}

// variantStubMaxRequests is more requests than any test here sends.
const variantStubMaxRequests = 1000

// variantStub stands in for nginx's internal image location: it records
// every request and answers each as the test says, by request number (from
// 1) and request.
type variantStub struct {
	mu   sync.Mutex
	reqs []variantStubRequest
}

// newVariantStub starts the stand-in and points IMAGE_VARIANT_WARM_BASE_URL
// at it for the rest of the test.
func newVariantStub(t *testing.T, clock *variantClock, answer func(n int, r variantStubRequest) variantStubAnswer) *variantStub {
	t.Helper()
	s := &variantStub{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		width, _ := strconv.Atoi(q.Get("w"))
		req := variantStubRequest{
			method: r.Method, path: r.URL.Path, rawQuery: r.URL.RawQuery,
			image: q.Get("url"), width: width, quality: q.Get("q"),
			accept: r.Header.Get("Accept"), refresh: r.Header.Get(variantWarmRefreshHeader),
		}
		s.mu.Lock()
		s.reqs = append(s.reqs, req)
		n := len(s.reqs)
		s.mu.Unlock()
		if n > variantStubMaxRequests {
			// A pass that keeps asking: fail the test now, and answer 400
			// so the pass's own three-failures brake ends it, rather than
			// leave it spinning until the test binary times out.
			t.Errorf("runaway pass: request %d for %s at %d", n, req.anilistURL(), req.width)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		a := answer(n, req)
		if a.took > 0 {
			clock.advance(a.took)
		}
		if a.hang {
			<-r.Context().Done()
			return
		}
		if a.cacheStatus != "" {
			w.Header().Set(variantWarmCacheStatusHeader, a.cacheStatus)
		}
		w.WriteHeader(a.status)
	}))
	t.Cleanup(srv.Close)
	t.Setenv(imageVariantWarmBaseURLEnv, srv.URL+"/_next/image")
	return s
}

func (s *variantStub) requests() []variantStubRequest {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]variantStubRequest{}, s.reqs...)
}

// asked is every request so far as "<AniList URL> <width>", in order.
func (s *variantStub) asked() []string {
	var out []string
	for _, r := range s.requests() {
		out = append(out, r.anilistURL()+" "+strconv.Itoa(r.width))
	}
	return out
}

// variantSummary is the attributes of the last pass's summary line.
func variantSummary(t *testing.T, logs *imageWarmLogs) map[string]any {
	t.Helper()
	return logAttrs(t, logs, "image variant warm pass done")
}

// logAttrs is the attributes of the last line logged with message.
func logAttrs(t *testing.T, logs *imageWarmLogs, message string) map[string]any {
	t.Helper()
	logs.mu.Lock()
	defer logs.mu.Unlock()
	for i := len(logs.records) - 1; i >= 0; i-- {
		r := logs.records[i]
		if r.Message != message {
			continue
		}
		out := map[string]any{}
		r.Attrs(func(a slog.Attr) bool {
			out[a.Key] = a.Value.Any()
			return true
		})
		return out
	}
	t.Fatalf("nothing was logged as %q", message)
	return nil
}
