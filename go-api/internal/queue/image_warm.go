// image_warm.go — the job that has nginx store the original of every AniList
// image the database references.
//
// # What it is for
//
// Every image the site shows is an AniList CDN URL, in one of the columns the
// image_refs view reads (migration 0049).  nginx keeps the originals in a
// cache zone of its own, so a page keeps its images while AniList is slow or
// refuses us.  A public request that misses is proxied to AniList without
// being stored: the only way an original enters that zone is this job asking
// nginx's internal warm endpoint for it, and the job asks only for what the
// database references.
//
//	GET {IMAGE_WARM_BASE_URL}{path}   path: the URL after https://s4.anilist.co/file/anilistcdn/
//
//	200  nginx holds the original (stored now, or already)
//	404  AniList has no such file
//	403  AniList refusing us, or a path nginx's warm server will not fetch
//	429  AniList is throttling us; its Retry-After is passed through
//	5xx  AniList failed, or nginx could not reach it (502, 504)
//
// # One pass
//
//	pass start
//	 ├─ IMAGE_WARM_BASE_URL empty? ─────────────────────── yes ─► INFO, nothing to do
//	 ├─ a throttled row whose next_attempt_at is ahead? ─── yes ─► INFO, skip the pass
//	 ├─ free space on the host disk < 10 GiB? ───────────── yes ─► ERROR (Sentry), skip the pass
//	 └─ batch: never asked, then due retries, then month-old re-checks of
//	    unhashed URLs, then due failures
//	      each URL, about ten a second, while the pass has time left:
//	        outside the allowlist ─► missing, no request sent; WARN
//	        200 ───────────────────► warmed, warmed_at = now
//	        404, 410, other 4xx ───► missing, asked again in 30 days
//	        429 ───────────────────► throttled until Retry-After (1h if absent,
//	                                 24h at most); ERROR; STOP, no further request
//	        5xx, 3xx, 401, 403,
//	        timeout, or a 200
//	        cut short ─────────────► failed, asked again in 1h, 2h, 4h ... as the
//	                                 URL keeps failing, 30 days at most; the
//	                                 pass's 3rd failure in a row ─► ERROR; STOP
//	        cannot connect ────────► row untouched; WARN; STOP (nginx not up yet);
//	                                 the 3rd pass in a row to stop here ─► ERROR
//	        pass cancelled ────────► row untouched; STOP (a deploy)
//	      a 200 or a missing answer ends the pass's run of failures; any
//	      answer but a failure sets the URL's own count of them back to 0
//	 INFO: one summary line, the count of each outcome and why the pass stopped
//
// # Which originals are asked for again
//
// Most AniList file names end in a content hash: a dash, twelve letters and
// digits, then the extension, as in bx154587-qQTzQnEJJ3oB.jpg.  The bytes
// behind such a name never change.  When AniList changes an image it gives
// it a new name, and the new URL reaches us through the database, where the
// next pass finds it never asked about.  Asking for a hashed original again
// would only spend AniList requests, which this job exists to keep few.  So
// a stored original is asked for again, once it is imageWarmRecheckAfter
// old, only when its name carries no hash -- a bare number such as 21.jpg,
// or default.jpg -- and nginx answers that with a conditional request.
//
// The test (ListImageWarmBatch) is narrow on purpose.  A name that only
// nearly matches, with eleven or thirteen characters where the hash would
// be, counts as unhashed and is re-checked, so if AniList changes how it
// names files the job re-checks too much rather than too little.  nginx
// revalidates an expired hashed original by itself when a reader asks for
// it, and serves the stored copy while AniList is in trouble; that needs
// nothing from this job.
//
// # Why a 429 stops everything
//
// What this job exists to guard against is AniList refusing our server, and a
// pass that keeps asking after being told to slow down is how a short
// throttle becomes a block.  So a 429 ends the pass at once, and the window
// it records stops every pass that starts inside it.  Three 5xx answers or
// timeouts in a row end the pass for the same reason: AniList, or the way to
// it, is in trouble, and more requests will not help.  A 401 or 403 counts
// with them rather than as a missing file: AniList answers a file it does not
// have with 404, so a refusal means we are being refused, and recording it as
// missing would hide a month of images while the pass kept asking.  403 is
// also how nginx's warm server answers a path it will not fetch.  The job
// sends only paths its own copy of the allowlist accepts, so that answer
// means IMAGE_WARM_BASE_URL or one of the two allowlists is wrong, and
// stopping is right there too; read as missing, it would put every URL of
// the pass off for a month.  Both stops are ERRORs, which internal/obs
// forwards to Sentry.
//
// A connection that cannot be made at all is different.  That is nginx not
// accepting yet, which is what every deploy looks like for a moment, so it
// ends the pass with a WARN and pages nobody.  The third pass in a row to
// stop that way is no deploy -- a wrong host or port in IMAGE_WARM_BASE_URL,
// or an nginx without the warm server -- and is an ERROR, or the store could
// stop filling for good with nothing anyone reads saying so.
//
// # Why a failure is recorded, and asked for last
//
// A failure is written down as 'failed', with a time to ask again: an hour,
// doubled for each failure of the URL in a row before it, and 30 days at
// most (MarkImageFailed).  Unrecorded, a URL that fails every time would
// stay among the never asked, which head every batch in URL order.  Three
// such URLs sorting together would make every pass three requests and a
// stop, and nothing behind them -- new images, retries, re-checks -- would
// be reached again.  Recorded, it waits for its time, and then it comes
// last: due failures are the batch's final tier, so a run of them that
// stops a pass cuts off only the failures behind it.  The third failure in
// a row stops the pass as the section above says, each of the three
// written down before it does.  The doubling is the URL's own, so one that
// keeps failing is asked less and less often, and an AniList in trouble for
// a day costs each URL a handful of requests rather than one a pass.
//
// What is no answer about the URL is not recorded: a connection to nginx
// that cannot be made, and a pass cancelled.  Both are what a deploy looks
// like, and a deploy must not put any URL off.
//
// # Why it has a queue of its own
//
// Filling an empty zone takes several passes of up to imageWarmPassBudget
// each.  On the ratings queue's one slot, every one of them would hold the
// ratings, facts, credits and profiles sweeps for most of an hour.
// ImageWarmQueueName has one slot of its own: one pass at a time, which is
// also what keeps the request rate at imageWarmRequestGap.
//
// # Why a pass never returns an error for an answer
//
// The rule every sweep here follows: river retries a failed job on a backoff
// that grows to hours, and for an hourly job the next pass is the retry.
// Each answer is written as it arrives, so a pass that stops early, or that
// a deploy kills, loses only the request in flight.  Only a failure to read
// the throttle window or the batch is returned.
//
// # The switch
//
// IMAGE_WARM_BASE_URL, read at work time like PROFILES_SWEEP_ENABLED.  Empty,
// the job does nothing and says so once a pass: that is how dev and CI, which
// have no warm endpoint, stay inert.  A value that is not an http(s) URL is
// an ERROR every pass, and nothing is requested.
package queue

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/riverqueue/river"
	"golang.org/x/time/rate"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

const (
	// imageWarmInterval is how often a pass fires.
	imageWarmInterval = time.Hour

	// imageWarmPassBudget is the wall time a pass may spend asking, checked
	// before every request.
	imageWarmPassBudget = 50 * time.Minute

	// imageWarmTimeout bounds one pass: the budget, a request that starts as
	// it runs out, and the reads around them.  Under imageWarmInterval, and
	// under the hour after which river's rescuer takes a running job for a
	// dead one.
	imageWarmTimeout = 55 * time.Minute

	// imageWarmBatchLimit is the most URLs one pass asks for: what the budget
	// holds at imageWarmRequestGap.
	imageWarmBatchLimit = 30_000

	// imageWarmRequestGap is the pause between two requests: about ten a
	// second.
	imageWarmRequestGap = 100 * time.Millisecond

	// imageWarmRequestTimeout bounds one request, reading the body included.
	imageWarmRequestTimeout = 30 * time.Second

	// imageWarmDialTimeout bounds connecting to nginx.  Well under
	// imageWarmRequestTimeout, so an endpoint that is not accepting reads as
	// unreachable rather than as a slow AniList.
	imageWarmDialTimeout = 5 * time.Second

	// imageWarmFailuresToStop is how many failures in a row (answerFailed:
	// 5xx answers, timeouts, refusals) end a pass.
	imageWarmFailuresToStop = 3

	// imageWarmUnreachablePassesToAlert is the pass, counting those that
	// stopped in a row because the warm endpoint took no connection, at
	// which that is reported as an ERROR rather than a WARN: one is a
	// deploy, three hours of it is not.
	imageWarmUnreachablePassesToAlert = 3

	// imageWarmRecheckAfter is how long a stored original whose file name
	// carries no content hash goes before it is asked for again; a hashed
	// one never is (see the file comment).  nginx answers that with a
	// conditional request, so an image AniList has not changed costs it no
	// body.
	imageWarmRecheckAfter = 30 * 24 * time.Hour

	// imageWarmMissingRetryAfter is how long a URL AniList had no file for
	// waits before it is asked about again, in case the file comes back.
	imageWarmMissingRetryAfter = 30 * 24 * time.Hour

	// imageWarmThrottleDefault is the wait after a 429 that names none, and
	// imageWarmThrottleMax the longest wait a Retry-After is believed for.
	imageWarmThrottleDefault = time.Hour
	imageWarmThrottleMax     = 24 * time.Hour

	// imageWarmMinFreeBytes is the free space below which a pass does not
	// run: originals must never be what fills the disk the database is on.
	imageWarmMinFreeBytes uint64 = 10 << 30

	// imageWarmDiskPath is what the disk guard measures: the container's
	// root, which reports the host disk through the overlay file system.
	imageWarmDiskPath = "/"
)

// imageWarmBaseURLEnv names the switch; see the file comment.
const imageWarmBaseURLEnv = "IMAGE_WARM_BASE_URL"

// anilistCDNPrefix is what every URL image_refs returns starts with; the
// rest is the path the warm endpoint takes.
const anilistCDNPrefix = "https://s4.anilist.co/file/anilistcdn/"

// imageWarmAllowlist is the paths nginx's warm location will store, kept
// identical to the regex there: the kinds of image the database references,
// each ending in a safe file name.  A path it refuses is not requested.
var imageWarmAllowlist = regexp.MustCompile(
	`^(media/(anime|manga)/(cover/(large|medium|extraLarge|small)|banner)|character/(large|medium)|staff/(large|medium))/[A-Za-z0-9_.-]+\.(jpe?g|png|gif|webp)$`)

// ImageWarmStore is the database surface: the throttle window, the batch,
// and one write per kind of answer.  *dbgen.Queries satisfies it.
type ImageWarmStore interface {
	ImageWarmBlocked(ctx context.Context) (bool, error)
	ListImageWarmBatch(ctx context.Context, recheckAfter pgtype.Interval, rowLimit int32) ([]string, error)
	MarkImageWarmed(ctx context.Context, url string) error
	MarkImageMissing(ctx context.Context, url string, retryAfter pgtype.Interval, lastHTTPStatus *int32) error
	MarkImageThrottled(ctx context.Context, url string, retryAfter pgtype.Interval) error
	MarkImageFailed(ctx context.Context, url string, lastHTTPStatus *int32) error
}

// ImageWarmWorker runs the job.
type ImageWarmWorker struct {
	river.WorkerDefaults[ImageWarmArgs]
	store  ImageWarmStore
	client *http.Client
	// freeBytes reports the free space on the file system holding a path
	// (hostFreeBytes); tests replace it.
	freeBytes func(path string) (uint64, error)
	// unreachablePasses counts the passes in a row that stopped because the
	// warm endpoint took no connection; any answer from it resets the count.
	// Held for the life of the process, so a restart (a deploy) starts it
	// again from zero.
	unreachablePasses atomic.Int32
}

// NewImageWarmWorker builds the worker.
func NewImageWarmWorker(store ImageWarmStore) *ImageWarmWorker {
	return &ImageWarmWorker{store: store, client: newImageWarmClient(), freeBytes: hostFreeBytes}
}

// newImageWarmClient is the client for the warm endpoint.  It is on the
// private network, so never through a proxy; it answers and never
// redirects, so a redirect is taken as the answer and not followed.
func newImageWarmClient() *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.DialContext = (&net.Dialer{Timeout: imageWarmDialTimeout, KeepAlive: 30 * time.Second}).DialContext
	return &http.Client{
		Transport: transport,
		Timeout:   imageWarmRequestTimeout,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

// imageWarmBaseURL reads the switch.  "" with no error is off.  A value that
// is not an http(s) URL with a host is an error; a missing trailing slash is
// added, so the path is never glued onto the endpoint's last segment.
func imageWarmBaseURL() (string, error) {
	raw := strings.TrimSpace(os.Getenv(imageWarmBaseURLEnv))
	if raw == "" {
		return "", nil
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("%s: %w", imageWarmBaseURLEnv, err)
	}
	if (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" {
		return "", fmt.Errorf("%s=%q: want an http(s) URL with a host and no query", imageWarmBaseURLEnv, raw)
	}
	if !strings.HasSuffix(raw, "/") {
		raw += "/"
	}
	return raw, nil
}

// Timeout bounds one pass.
func (w *ImageWarmWorker) Timeout(*river.Job[ImageWarmArgs]) time.Duration {
	return imageWarmTimeout
}

// Work runs one pass.
func (w *ImageWarmWorker) Work(ctx context.Context, _ *river.Job[ImageWarmArgs]) error {
	ctx, cancel := context.WithTimeout(ctx, imageWarmTimeout)
	defer cancel()
	base, run, err := w.preflight(ctx)
	if err != nil || !run {
		return err
	}

	start := time.Now()
	urls, err := w.store.ListImageWarmBatch(ctx, toPgInterval(imageWarmRecheckAfter), imageWarmBatchLimit)
	if err != nil {
		return fmt.Errorf("image warm: list batch: %w", err)
	}
	p := &imageWarmPass{
		w:        w,
		base:     base,
		deadline: start.Add(imageWarmPassBudget),
		limiter:  rate.NewLimiter(rate.Every(imageWarmRequestGap), 1),
	}
	p.run(ctx, urls)
	slog.InfoContext(ctx, "image warm pass done",
		"batch", len(urls),
		"requests", p.requests,
		"warmed", p.warmed,
		"missing", p.missing,
		"refused", p.refused,
		"throttled", p.throttled,
		"failed", p.failed,
		"stopped", p.reason,
		"duration", time.Since(start).Round(time.Millisecond))
	return nil
}

// preflight runs what comes before a batch, in order: the switch, the
// throttle window, the disk.  run is false when the pass must not go on;
// only a failure to read the throttle window is an error.
func (w *ImageWarmWorker) preflight(ctx context.Context) (base string, run bool, err error) {
	base, err = imageWarmBaseURL()
	if err != nil {
		slog.ErrorContext(ctx, "image warm: base URL not usable, skipping pass", "err", err)
		return "", false, nil
	}
	if base == "" {
		slog.InfoContext(ctx, "image warm: off, no base URL", "env", imageWarmBaseURLEnv)
		return "", false, nil
	}
	blocked, err := w.store.ImageWarmBlocked(ctx)
	if err != nil {
		return "", false, fmt.Errorf("image warm: read throttle window: %w", err)
	}
	if blocked {
		slog.InfoContext(ctx, "image warm: AniList throttle window still open, skipping pass")
		return "", false, nil
	}
	if !w.diskHasRoom(ctx) {
		return "", false, nil
	}
	return base, true, nil
}

// diskHasRoom is the disk guard.  A free-space figure it cannot read counts
// as no room: the guard exists for the case where nobody is looking.
func (w *ImageWarmWorker) diskHasRoom(ctx context.Context) bool {
	free, err := w.freeBytes(imageWarmDiskPath)
	if err != nil {
		slog.ErrorContext(ctx, "image warm: free disk space unreadable, skipping pass",
			"path", imageWarmDiskPath, "err", err)
		return false
	}
	if free < imageWarmMinFreeBytes {
		slog.ErrorContext(ctx, "image warm: host disk nearly full, skipping pass",
			"path", imageWarmDiskPath, "freeBytes", free, "minFreeBytes", imageWarmMinFreeBytes)
		return false
	}
	return true
}

// imageWarmPass is one pass's state: what it has seen, and whether and why
// it stopped.
type imageWarmPass struct {
	w        *ImageWarmWorker
	base     string
	deadline time.Time
	limiter  *rate.Limiter

	requests, warmed, missing, refused, throttled, failed int
	failuresInARow                                        int
	stopped                                               bool
	reason                                                string
}

// run asks for each URL in turn until the batch, the budget or the pass
// runs out.
func (p *imageWarmPass) run(ctx context.Context, urls []string) {
	for _, imageURL := range urls {
		switch {
		case p.stopped:
			return
		case ctx.Err() != nil:
			p.stop("cancelled")
			return
		case time.Now().After(p.deadline):
			p.stop("time")
			return
		}
		path, ok := warmPath(imageURL)
		if !ok {
			p.refuse(ctx, imageURL)
			continue
		}
		if err := p.limiter.Wait(ctx); err != nil {
			p.stop("cancelled")
			return
		}
		p.requests++
		p.record(ctx, imageURL, p.w.warm(ctx, p.base+path))
	}
	p.stop("done")
}

// stop ends the pass; the first reason given is the one reported.
func (p *imageWarmPass) stop(reason string) {
	if !p.stopped {
		p.stopped, p.reason = true, reason
	}
}

// refuse records a URL whose path nginx would not store as missing, without
// asking: the endpoint would answer it 404 without asking AniList anyway.
// Recording it keeps it out of the next passes' batches until it is due
// again, instead of at the head of every one.
func (p *imageWarmPass) refuse(ctx context.Context, imageURL string) {
	p.refused++
	slog.WarnContext(ctx, "image warm: path outside the allowlist, not requested", "url", imageURL)
	p.write(ctx, imageURL, p.w.store.MarkImageMissing(ctx, imageURL, toPgInterval(imageWarmMissingRetryAfter), nil))
}

// record acts on one answer.
func (p *imageWarmPass) record(ctx context.Context, imageURL string, a warmAnswer) {
	if a.kind != answerUnreachable && a.kind != answerCancelled {
		p.w.unreachablePasses.Store(0)
	}
	switch a.kind {
	case answerStored:
		p.warmed++
		p.failuresInARow = 0
		p.write(ctx, imageURL, p.w.store.MarkImageWarmed(ctx, imageURL))
	case answerMissing:
		p.missing++
		p.failuresInARow = 0
		status := int32(a.status)
		p.write(ctx, imageURL, p.w.store.MarkImageMissing(ctx, imageURL, toPgInterval(imageWarmMissingRetryAfter), &status))
	case answerThrottled:
		p.onThrottled(ctx, imageURL, a)
	case answerFailed:
		p.onFailure(ctx, imageURL, a)
	case answerUnreachable:
		p.stop("unreachable")
		p.onUnreachable(ctx, a)
	default:
		p.stop("cancelled")
	}
}

// onUnreachable reports a pass stopped because the warm endpoint took no
// connection: a WARN while that could be a deploy, an ERROR from the
// imageWarmUnreachablePassesToAlert-th pass in a row (see the file comment).
func (p *imageWarmPass) onUnreachable(ctx context.Context, a warmAnswer) {
	n := p.w.unreachablePasses.Add(1)
	if n < imageWarmUnreachablePassesToAlert {
		slog.WarnContext(ctx, "image warm: warm endpoint not reachable, pass stopped",
			"endpoint", p.base, "passesInARow", n, "err", a.err)
		return
	}
	slog.ErrorContext(ctx, "image warm: warm endpoint not reachable pass after pass",
		"endpoint", p.base, "passesInARow", n, "env", imageWarmBaseURLEnv, "err", a.err)
}

// onThrottled stops the pass before anything else happens, then records the
// window that keeps the next passes from starting inside it.
func (p *imageWarmPass) onThrottled(ctx context.Context, imageURL string, a warmAnswer) {
	p.throttled++
	p.stop("throttled")
	slog.ErrorContext(ctx, "image warm: AniList is throttling, pass stopped",
		"url", imageURL, "retryAfter", a.retryAfter.String(), "until", time.Now().Add(a.retryAfter).UTC())
	p.write(ctx, imageURL, p.w.store.MarkImageThrottled(ctx, imageURL, toPgInterval(a.retryAfter)))
}

// onFailure records a 5xx, a timeout or a refusal as 'failed', which puts
// the URL off by its own backoff and out of the head of the next batches
// (see the file comment).  The third in a row stops the pass, once it too is
// recorded.
func (p *imageWarmPass) onFailure(ctx context.Context, imageURL string, a warmAnswer) {
	p.failed++
	p.failuresInARow++
	p.write(ctx, imageURL, p.w.store.MarkImageFailed(ctx, imageURL, failedStatus(a)))
	if p.failuresInARow < imageWarmFailuresToStop {
		return
	}
	p.stop("failures")
	attrs := []any{"failuresInARow", p.failuresInARow, "url", imageURL, "status", a.status, "err", a.err}
	if a.status == http.StatusForbidden {
		attrs = append(attrs, "hint",
			"AniList refusing us, or nginx's warm server refusing the path: check "+imageWarmBaseURLEnv+
				" and that the allowlists in image_warm.go and nginx/default.p9.conf agree")
	}
	slog.ErrorContext(ctx, "image warm: upstream failing or refusing, pass stopped", attrs...)
}

// failedStatus is the status a failure is recorded with: the HTTP status
// when that is what failed, nil when there was none (a timeout) or the
// failure came after it (a 200 whose body broke off).
func failedStatus(a warmAnswer) *int32 {
	if a.status == 0 || a.status == http.StatusOK {
		return nil
	}
	status := int32(a.status)
	return &status
}

// write checks the write that recorded an answer.  A failed one stops the
// pass: what is not recorded would only be asked again.  A write that failed
// because the pass is being cancelled (a deploy) is not an error.
func (p *imageWarmPass) write(ctx context.Context, imageURL string, err error) {
	if err == nil {
		return
	}
	if ctx.Err() != nil {
		p.stop("cancelled")
		return
	}
	p.stop("database")
	slog.ErrorContext(ctx, "image warm: answer not recorded, pass stopped", "url", imageURL, "err", err)
}

// warmPath returns the path the warm endpoint takes for an image URL, and
// whether it is one nginx will store.
func warmPath(imageURL string) (string, bool) {
	path, ok := strings.CutPrefix(imageURL, anilistCDNPrefix)
	if !ok || !imageWarmAllowlist.MatchString(path) {
		return "", false
	}
	return path, true
}

// answerKind is what one request came to.
type answerKind int

const (
	answerStored      answerKind = iota + 1 // 200, body read to the end
	answerMissing                           // a 4xx other than 401, 403 and 429
	answerThrottled                         // 429
	answerFailed                            // a 5xx, a timeout, a 401 or 403, or a status the endpoint is not meant to send
	answerUnreachable                       // no connection to the endpoint, or it broke off
	answerCancelled                         // the pass's own context ended
)

// warmAnswer is one request's outcome.
type warmAnswer struct {
	kind       answerKind
	status     int           // the HTTP status, 0 when there was no response
	retryAfter time.Duration // for answerThrottled
	err        error         // the transport error, if any
}

// warm asks the endpoint for one path and reads the answer to the end:
// nginx finishes storing an original only once its client has had all of
// it.
func (w *ImageWarmWorker) warm(ctx context.Context, target string) warmAnswer {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return warmAnswer{kind: answerUnreachable, err: err}
	}
	resp, err := w.client.Do(req)
	if err != nil {
		return transportAnswer(ctx, 0, err)
	}
	defer resp.Body.Close()
	_, readErr := io.Copy(io.Discard, resp.Body)
	return statusAnswer(ctx, resp, readErr)
}

// statusAnswer reads an HTTP answer.
func statusAnswer(ctx context.Context, resp *http.Response, readErr error) warmAnswer {
	code := resp.StatusCode
	switch {
	case code == http.StatusOK && readErr != nil:
		// nginx answered, so it was reachable; a body that breaks off is the
		// fetch behind it failing, and counts like a 5xx.  Read as
		// unreachable, it would end the pass with a WARN and an AniList in
		// trouble would page nobody.
		if ctx.Err() != nil {
			return warmAnswer{kind: answerCancelled, status: code, err: readErr}
		}
		return warmAnswer{kind: answerFailed, status: code, err: readErr}
	case code == http.StatusOK:
		return warmAnswer{kind: answerStored, status: code}
	case code == http.StatusTooManyRequests:
		return warmAnswer{kind: answerThrottled, status: code,
			retryAfter: retryAfterDelay(resp.Header.Get("Retry-After"), time.Now())}
	case code == http.StatusUnauthorized || code == http.StatusForbidden:
		// A refusal, not an absence: AniList answers a file it does not
		// have with 404, and a 403 is how a CDN says it is blocking us (or
		// how nginx says it is refusing the job).  Recorded as missing it
		// would put a month on every URL the pass reaches while the pass
		// kept asking; counted as a failure, the third in a row stops it.
		return warmAnswer{kind: answerFailed, status: code}
	case code >= 400 && code < 500:
		return warmAnswer{kind: answerMissing, status: code}
	default:
		return warmAnswer{kind: answerFailed, status: code}
	}
}

// transportAnswer reads a request that got no answer.  A timeout is
// AniList's (nginx waits on it while we wait on nginx); a connection that
// cannot be made, or that breaks before nginx answers, is nginx's.  (A 200
// whose body breaks off is statusAnswer's.)
func transportAnswer(ctx context.Context, status int, err error) warmAnswer {
	kind := answerUnreachable
	switch {
	case ctx.Err() != nil:
		kind = answerCancelled
	case isDialError(err):
		kind = answerUnreachable
	case isTimeout(err):
		kind = answerFailed
	}
	return warmAnswer{kind: kind, status: status, err: err}
}

// isDialError reports a failure to connect at all: refused, unroutable, a
// name that does not resolve, or a connect that timed out.
func isDialError(err error) bool {
	var opErr *net.OpError
	if errors.As(err, &opErr) && opErr.Op == "dial" {
		return true
	}
	var dnsErr *net.DNSError
	return errors.As(err, &dnsErr)
}

// isTimeout reports a request that ran out of time once connected.
func isTimeout(err error) bool {
	var netErr net.Error
	return errors.As(err, &netErr) && netErr.Timeout()
}

// retryAfterDelay reads a Retry-After header: delay-seconds or an HTTP date.
// Absent or unreadable, imageWarmThrottleDefault; never more than
// imageWarmThrottleMax; a date already past is no wait at all.
func retryAfterDelay(header string, now time.Time) time.Duration {
	v := strings.TrimSpace(header)
	if v == "" {
		return imageWarmThrottleDefault
	}
	// A number too large for int64 parses as the largest one, with ErrRange:
	// still a request to wait as long as we ever will.
	if secs, err := strconv.ParseInt(v, 10, 64); err == nil || errors.Is(err, strconv.ErrRange) {
		switch {
		case secs < 0:
			return imageWarmThrottleDefault
		case secs >= int64(imageWarmThrottleMax/time.Second):
			return imageWarmThrottleMax
		default:
			return time.Duration(secs) * time.Second
		}
	}
	if at, err := http.ParseTime(v); err == nil {
		return min(max(at.Sub(now), 0), imageWarmThrottleMax)
	}
	return imageWarmThrottleDefault
}

// toPgInterval converts a duration for the queries' interval arguments.
func toPgInterval(d time.Duration) pgtype.Interval {
	return pgtype.Interval{Microseconds: d.Microseconds(), Valid: true}
}

// AddImageWarmWorker registers the job on an existing bundle.  It needs only
// the database: the endpoint is read from IMAGE_WARM_BASE_URL at work time.
func AddImageWarmWorker(w *river.Workers, q *dbgen.Queries) {
	river.AddWorker(w, NewImageWarmWorker(q))
	switch base, err := imageWarmBaseURL(); {
	case err != nil:
		slog.Warn("image warm job registered, but every pass will skip", "err", err)
	case base == "":
		slog.Info("image warm job registered but inert", "env", imageWarmBaseURLEnv)
	}
}

// Compile-time guards.
var (
	_ river.Worker[ImageWarmArgs] = (*ImageWarmWorker)(nil)
	_ ImageWarmStore              = (*dbgen.Queries)(nil)
)
