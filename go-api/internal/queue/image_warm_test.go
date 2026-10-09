package queue

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

// TestWarmPath_FollowsTheNginxAllowlist pins the paths the job will ask for.
// The regex is a copy of nginx's, so these cases are the contract the two
// copies are held to: the kinds of image the database references are
// allowed, and anything else -- AniList users' uploads above all -- is not.
func TestWarmPath_FollowsTheNginxAllowlist(t *testing.T) {
	t.Parallel()

	const cdn = anilistCDNPrefix
	for _, tc := range []struct {
		url string
		ok  bool
	}{
		{cdn + "media/anime/cover/large/bx154587-qQTzQnEJJ3oB.jpg", true},
		{cdn + "media/anime/cover/medium/bx1-CXtrrkMpJ8Zq.png", true},
		{cdn + "media/anime/cover/extraLarge/bx1-CXtrrkMpJ8Zq.png", true},
		{cdn + "media/anime/cover/small/bx1-CXtrrkMpJ8Zq.gif", true},
		{cdn + "media/manga/cover/large/bx30002-7EzO7o21jzeF.jpg", true},
		{cdn + "media/anime/banner/154587-ivXNJ23SM1xB.jpg", true},
		{cdn + "character/large/b184887-Cr2eDLtk7Eb6.png", true},
		{cdn + "character/medium/default.jpg", true},
		{cdn + "staff/large/n95185-XGpGZ8EQjE9O.jpeg", true},
		{cdn + "staff/medium/n95185-XGpGZ8EQjE9O.webp", true},

		{cdn + "user/avatar/large/b5123-x.png", false},
		{cdn + "user/banner/b5123-x.jpg", false},
		{cdn + "media/anime/cover/huge/bx1-x.png", false},
		{cdn + "media/anime/cover/extralarge/bx1-x.png", false},
		{cdn + "media/anime/cover/large/bx1-x.PNG", false},
		{cdn + "media/anime/cover/large/bx1-x.svg", false},
		{cdn + "media/anime/banner/../../../user/avatar/x.png", false},
		{cdn + "media/anime/cover/large/bx1-x.png?w=1", false},
		{cdn + "media/anime/cover/large/bx%2F1.png", false},
		{cdn + "media/anime/cover/large/bx1-x.png\n", false},
		{cdn, false},
		{"http://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx1-x.png", false},
		{"https://img.example.com/file/anilistcdn/media/anime/cover/large/bx1-x.png", false},
	} {
		path, ok := warmPath(tc.url)
		assert.Equal(t, tc.ok, ok, "%q", tc.url)
		if tc.ok {
			assert.Equal(t, strings.TrimPrefix(tc.url, cdn), path)
		} else {
			assert.Empty(t, path)
		}
	}
}

// TestRetryAfterDelay covers both spellings RFC 9110 allows, and the bounds
// a wait is held to.
func TestRetryAfterDelay(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 10, 10, 12, 0, 0, 0, time.UTC)
	date := func(d time.Duration) string { return now.Add(d).Format(http.TimeFormat) }
	for _, tc := range []struct {
		header string
		want   time.Duration
	}{
		{"", time.Hour},
		{"120", 2 * time.Minute},
		{" 30 ", 30 * time.Second},
		{"0", 0},
		{"86399", 86399 * time.Second},
		{"86400", 24 * time.Hour},
		{"604800", 24 * time.Hour},
		{"99999999999999999999999", 24 * time.Hour},
		{"-5", time.Hour},
		{"1.5", time.Hour},
		{"soon", time.Hour},
		{date(2 * time.Hour), 2 * time.Hour},
		{date(-time.Hour), 0},
		{date(72 * time.Hour), 24 * time.Hour},
	} {
		assert.Equal(t, tc.want, retryAfterDelay(tc.header, now), "Retry-After: %q", tc.header)
	}
}

// TestImageWarmBaseURL is the switch: empty is off, a usable URL gains the
// slash the path is appended after, and anything else is refused rather
// than glued into request URLs.
//
// NOT t.Parallel: it sets the process environment.
func TestImageWarmBaseURL(t *testing.T) {
	for _, tc := range []struct {
		env     string
		want    string
		wantErr bool
	}{
		{"", "", false},
		{"   ", "", false},
		{"http://nginx:8090/warm/", "http://nginx:8090/warm/", false},
		{"http://nginx:8090/warm", "http://nginx:8090/warm/", false},
		{" https://warm.internal/w/ ", "https://warm.internal/w/", false},
		{"nginx:8090/warm/", "", true},
		{"ftp://nginx/warm/", "", true},
		{"http:///warm/", "", true},
		{"http://nginx:8090/warm/?k=v", "", true},
		{"http://nginx:8090/warm/?", "", true},
		{"http://nginx:8090/warm/#x", "", true},
	} {
		t.Setenv(imageWarmBaseURLEnv, tc.env)
		got, err := imageWarmBaseURL()
		if tc.wantErr {
			assert.Error(t, err, "%q", tc.env)
		} else {
			assert.NoError(t, err, "%q", tc.env)
		}
		assert.Equal(t, tc.want, got, "%q", tc.env)
	}
}

// timeoutError is a net.Error that timed out, as a client timeout is.
type timeoutError struct{}

func (timeoutError) Error() string   { return "i/o timeout" }
func (timeoutError) Timeout() bool   { return true }
func (timeoutError) Temporary() bool { return true }

// TestTransportAnswer pins which failures count towards the three-in-a-row
// stop (AniList's) and which end the pass with a WARN (nginx's).  A connect
// that times out is nginx's, so the dial check must win over the timeout
// check.
func TestTransportAnswer(t *testing.T) {
	t.Parallel()

	dial := func(err error) error {
		return &url.Error{Op: "Get", URL: "http://nginx/warm/x", Err: &net.OpError{Op: "dial", Net: "tcp", Err: err}}
	}
	live := context.Background()
	done, cancel := context.WithCancel(context.Background())
	cancel()

	for _, tc := range []struct {
		name string
		ctx  context.Context
		err  error
		want answerKind
	}{
		{"connection refused", live, dial(errors.New("connect: connection refused")), answerUnreachable},
		{"connect timed out", live, dial(timeoutError{}), answerUnreachable},
		{"name does not resolve", live, dial(&net.DNSError{Err: "no such host", Name: "nginx", IsNotFound: true}), answerUnreachable},
		{"response timed out", live, &url.Error{Op: "Get", URL: "http://nginx/warm/x", Err: timeoutError{}}, answerFailed},
		{"connection reset", live, &url.Error{Op: "Get", URL: "http://nginx/warm/x",
			Err: &net.OpError{Op: "read", Net: "tcp", Err: errors.New("read: connection reset by peer")}}, answerUnreachable},
		{"pass cancelled", done, &url.Error{Op: "Get", URL: "http://nginx/warm/x", Err: context.Canceled}, answerCancelled},
	} {
		assert.Equal(t, tc.want, transportAnswer(tc.ctx, 0, tc.err).kind, tc.name)
	}
}

// TestWarm_ReadsAgainstARealClient runs the classification through the
// production client and real sockets, so the error shapes net/http actually
// produces are the ones the cases above assume.
func TestWarm_ReadsAgainstARealClient(t *testing.T) {
	t.Parallel()

	t.Run("a closed port is unreachable", func(t *testing.T) {
		t.Parallel()
		srv := httptest.NewServer(http.NotFoundHandler())
		base := srv.URL
		srv.Close()

		a := NewImageWarmWorker(nil).warm(context.Background(), base+"/warm/x.png")
		assert.Equal(t, answerUnreachable, a.kind, "%v", a.err)
	})

	t.Run("an answer slower than the request timeout is a failure", func(t *testing.T) {
		t.Parallel()
		release := make(chan struct{})
		srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { <-release }))
		t.Cleanup(srv.Close)
		t.Cleanup(func() { close(release) })

		w := NewImageWarmWorker(nil)
		w.client.Timeout = 50 * time.Millisecond
		a := w.warm(context.Background(), srv.URL+"/warm/x.png")
		assert.Equal(t, answerFailed, a.kind, "%v", a.err)
	})

	t.Run("statuses", func(t *testing.T) {
		t.Parallel()
		for _, tc := range []struct {
			status int
			want   answerKind
		}{
			{http.StatusOK, answerStored},
			{http.StatusNotFound, answerMissing},
			{http.StatusGone, answerMissing},
			{http.StatusBadRequest, answerMissing},
			{http.StatusUnavailableForLegalReasons, answerMissing},
			{http.StatusUnauthorized, answerFailed},
			{http.StatusForbidden, answerFailed},
			{http.StatusTooManyRequests, answerThrottled},
			{http.StatusBadGateway, answerFailed},
			{http.StatusServiceUnavailable, answerFailed},
			{http.StatusGatewayTimeout, answerFailed},
			{http.StatusFound, answerFailed},
			{http.StatusNoContent, answerFailed},
		} {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				if tc.status == http.StatusFound {
					w.Header().Set("Location", "https://s4.anilist.co/")
				}
				w.WriteHeader(tc.status)
			}))
			a := NewImageWarmWorker(nil).warm(context.Background(), srv.URL+"/warm/x.png")
			srv.Close()
			assert.Equal(t, tc.want, a.kind, "status %d", tc.status)
			assert.Equal(t, tc.status, a.status, "status %d", tc.status)
		}
	})
}

// TestWarm_ReadsTheBodyToTheEnd: nginx stores an original only once its
// client has taken all of it, so a 200 is not done until the body is.  A
// body several times any socket buffer cannot be written in full unless the
// client reads it.
func TestWarm_ReadsTheBodyToTheEnd(t *testing.T) {
	t.Parallel()

	const size = 8 << 20
	written := make(chan error, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, err := w.Write(make([]byte, size))
		written <- err
	}))
	t.Cleanup(srv.Close)

	a := NewImageWarmWorker(nil).warm(context.Background(), srv.URL+"/warm/x.png")
	assert.Equal(t, answerStored, a.kind, "%v", a.err)
	select {
	case err := <-written:
		assert.NoError(t, err, "the server could not write the whole body")
	case <-time.After(5 * time.Second):
		t.Fatal("the server never finished writing the body")
	}
}

// TestWarm_ABodyCutShortIsAFailure: once nginx has answered, the connection
// to it was made, so a 200 whose body breaks off is the fetch behind it
// failing.  It must count towards the three-in-a-row stop, an ERROR, and not
// end the pass as unreachable with a WARN that pages nobody.
func TestWarm_ABodyCutShortIsAFailure(t *testing.T) {
	t.Parallel()

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		_, _ = conn.Read(make([]byte, 4096))
		// A megabyte promised, a kilobyte sent, and the connection closed.
		_, _ = conn.Write([]byte("HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: 1048576\r\n\r\n"))
		_, _ = conn.Write(make([]byte, 1024))
	}()

	a := NewImageWarmWorker(nil).warm(context.Background(), "http://"+ln.Addr().String()+"/warm/x.png")
	assert.Equal(t, answerFailed, a.kind, "%v", a.err)
	assert.Equal(t, http.StatusOK, a.status)
	assert.Error(t, a.err)
}

// TestImageWarmTiming pins how the pass's bounds relate, so changing one
// cannot quietly break another.
func TestImageWarmTiming(t *testing.T) {
	t.Parallel()

	assert.Greater(t, imageWarmTimeout, imageWarmPassBudget+imageWarmRequestTimeout,
		"a request that starts as the budget runs out must be allowed to finish")
	assert.Less(t, imageWarmTimeout, imageWarmInterval, "a pass ends before the next one is due")
	assert.Less(t, imageWarmTimeout, time.Hour,
		"river's rescuer takes a job that has been running an hour for a dead one")
	assert.Less(t, imageWarmDialTimeout, imageWarmRequestTimeout,
		"a connect that hangs must read as unreachable, not as a slow AniList")
	assert.LessOrEqual(t, time.Duration(imageWarmBatchLimit)*imageWarmRequestGap, imageWarmPassBudget,
		"a whole batch fits the budget at the paced rate")
	assert.Equal(t, 30*24*time.Hour, imageWarmRecheckAfter)
	assert.Equal(t, 30*24*time.Hour, imageWarmMissingRetryAfter)
}
