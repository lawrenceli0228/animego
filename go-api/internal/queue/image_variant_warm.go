// image_variant_warm.go — the nightly job that has nginx encode and keep
// every variant of an image the site's pages ask the image optimizer for.
//
// # What it is for
//
// A page never shows an AniList original.  It shows a variant of one, made
// by the image optimizer at the width the page lays it out at --
// /_next/image?url=<the image>&w=<width>&q=85, as AVIF -- and nginx caches
// those variants (location /_next/image).  A variant nobody has asked for in
// a while is not in that cache, and the first reader to need it waits while
// the optimizer encodes it, behind whatever else the optimizer is doing.
// An old show's page, which few readers open, is mostly such variants.
//
// So every night this job asks for every variant the pages show, of every
// show the site lists, and the reader finds them stored.  It asks nginx's
// internal entry to the same cache, under the same key, with HEAD, and in
// the form a page uses:
//
//	HEAD {IMAGE_VARIANT_WARM_BASE_URL}?url=<mirror address>&w=<width>&q=85
//	Accept: image/avif,image/webp,*/*
//	X-Warm-Refresh: 1         (only for tonight's refresh group, below)
//
// A variant already stored costs nginx a cache lookup and no encode, and the
// lookup keeps the entry from aging out.  One that is not stored is fetched
// from the optimizer with GET, encoded once, and stored for every reader
// after.  nginx says which in X-Cache-Status.  The url is the mirror address
// (https://animegoclub.com/img/anilist/<path>) because that is what the
// pages send, so the optimizer reads the original from the mirror and nginx
// files the variant under the AniList address, as it does a page's request
// ($next_image_key_args in nginx/default.p9.conf).
//
// # Which variants
//
// pageShapes is the kinds of image, and the widths of each, that nginx
// keeps in the cache zone the pages read (next_image); everything else the
// optimizer is asked for goes to a zone of its own, where it cannot push
// the pages' variants out.  nginx has its own copy of that list, as a map,
// and image_variant_warm_shapes_test.go holds the two equal.
//
// variantWarmList is what a page shows of one show, and at which widths: the
// cover (detail page and seasonal grid), the banner, the covers of related
// works and recommendations, the first eight characters and their voices,
// and the first ten staff.  Every width it names is a page shape.  Which
// images those are is ListImageVariantWarmTargets, which resolves them the
// way the detail API does (user edits first, the same order, the same
// enrichment of related works), and keeps only images whose original the
// mirror holds.
//
// # One pass
//
//	pass start (hourly)
//	 ├─ IMAGE_VARIANT_WARM_BASE_URL empty? ─────────────── yes ─► INFO, nothing to do
//	 ├─ outside 01:00–07:00 Asia/Shanghai, or inside
//	 │  03:15–04:00 (the nightly database backup)? ─────── yes ─► INFO, nothing to do
//	 ├─ tonight's list already done? ────────────────────── yes ─► INFO, nothing to do
//	 ├─ free space on the host disk < 10 GiB? ───────────── yes ─► ERROR (Sentry), skip the pass
//	 └─ tonight's list, from where tonight's last pass stopped; each variant,
//	    about 200 a second, while the budget and the window last:
//	      200 HIT, STALE, UPDATING, REVALIDATED ─► hit: stored already
//	      200 MISS, EXPIRED ────────────────────► filled: encoded and stored now
//	      200 BYPASS ───────────────────────────► refreshed: encoded again, replacing the entry
//	      503, 429 ─────────────────────────────► the optimizer is busy: pause 10 minutes
//	      404, 410, other 4xx but 400 ──────────► missing; one WARN a pass
//	      400, 401, 403, 3xx, other 5xx,
//	      a timeout, a 200 with no cache
//	      status ───────────────────────────────► failed; the 3rd in a row ─► ERROR; STOP
//	      cannot connect ───────────────────────► WARN; STOP; the 3rd pass in a row to
//	                                              stop here ─► ERROR
//	      pass cancelled ───────────────────────► STOP, quietly (a deploy)
//	    and any answer that took longer than 5 s ─► pause 10 minutes as well
//	 INFO: one summary line
//
// # When
//
// Only at night, Asia/Shanghai, when the site is quietest: 01:00 to 07:00,
// less 03:15 to 04:00, which belongs to the nightly database backup.  A
// pass that starts outside that says so and does nothing; one running when
// the window closes stops there.  The job fires hourly, so a night is a few
// passes of up to imageVariantWarmPassBudget each.
//
// # One list a night
//
// river resets a periodic schedule at every start, so "once a night" cannot
// be river's to keep.  The job keeps it instead, in the process: a cursor
// for tonight's date says how far down the list tonight's passes have got.
// A pass carries on from there, and once the list is done, the passes left
// that night say so and do nothing.  A restart, a deploy above all, loses
// the cursor, and the next pass starts tonight's list from the top: what the
// passes before it asked for are HITs now, which cost a lookup each.
//
// The list is read again by each pass, so the position is approximate when
// it changes in between (a show added, an original newly mirrored, a show's
// popularity moving it up or down).  At most a few variants are asked for
// twice or not reached tonight, and tomorrow's pass asks for every one
// again.
//
// # Refreshing
//
// A variant is valid for 30 days in nginx's cache (proxy_cache_valid), and
// most AniList file names carry a content hash, but not all: an unhashed
// image AniList changes keeps its URL.  So every night one of 25 groups of
// images -- refreshGroup(url), by a hash of the URL, and tonightsGroup, by
// the date -- is asked for with X-Warm-Refresh: 1, which only the internal
// location honours (proxy_cache_bypass): the variant is encoded again from
// the current original and replaces the entry.  Every page variant's group
// comes round once in 25 nights, inside its 30 days of validity, so a
// variant the passes reach never expires while readers are about, and an
// unhashed image follows AniList within 25 days.  (A variant that does
// expire is found EXPIRED by the next pass, and encoded then.)
//
// # Answers
//
// The answers are image_warm.go's (statusAnswer, transportAnswer), read
// through a thin step of this job's own, because two of them mean something
// else here.  A 400 is nginx refusing the query string: it is this job
// building a request nginx does not accept, a bug, and counted as missing --
// as image_warm's statusAnswer counts a 4xx -- it would hide a broken URL
// builder behind a missing count for ever.  So it is a failure, and three in
// a row stop the pass with an ERROR.  (A 403, which statusAnswer already
// counts as a failure, is the internal location refusing what is not a
// page shape at a mirror address: pageShapes and nginx's map disagree, or
// the job built the wrong address.)
//
// A 503 is nginx saying the optimizer is busy (its answer when the
// optimizer is saturated or down), which is not a failure of anything this
// job asked for: the pass pauses and goes on.  A request slower than
// imageVariantWarmSlowAfter says the same thing more quietly -- the
// optimizer is working through other traffic -- and pauses the pass too.
// After a pause the pass moves on to the next variant: the one that met the
// 503 is left for tomorrow's pass, or for a reader, rather than asked again
// into the same queue.  A pause never outlasts the budget or the window.
//
// A 200 without an X-Cache-Status is a failure as well.  It means the
// answer did not come through nginx's cache -- IMAGE_VARIANT_WARM_BASE_URL
// points at the optimizer itself, or at a location without the header -- and
// then every request is an encode that is stored nowhere.
//
// # Why it has a queue of its own
//
// A pass runs for most of an hour, and on any shared queue's one slot it
// would hold every other sweep there for that long.
// ImageVariantWarmQueueName has one slot of its own, which is also what
// keeps the requests one at a time: the optimizer encodes one variant for
// this job at most, and live traffic shares it.
//
// # The switch
//
// IMAGE_VARIANT_WARM_BASE_URL, read at work time like IMAGE_WARM_BASE_URL.
// Empty, the job does nothing and says so once a pass: that is how dev and
// CI, which have no nginx, stay inert.  A value that is not an http(s) URL
// with a host and a path, and no query, is an ERROR every pass, and nothing
// is requested.  In production it is nginx's internal location,
// http://nginx:8090/_next/image.
package queue

import (
	"context"
	"fmt"
	"hash/fnv"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/riverqueue/river"
	"golang.org/x/time/rate"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

const (
	// imageVariantWarmInterval is how often a pass fires.  Most fire
	// outside the window and return at once.
	imageVariantWarmInterval = time.Hour

	// imageVariantWarmPassBudget is the wall time a pass may spend asking,
	// pauses included, checked before every request.
	imageVariantWarmPassBudget = 50 * time.Minute

	// imageVariantWarmTimeout bounds one pass: the budget, a request that
	// starts as it runs out, and the read of the list.  Under
	// imageVariantWarmInterval, and under the hour after which river's
	// rescuer takes a running job for a dead one.
	imageVariantWarmTimeout = 55 * time.Minute

	// imageVariantWarmRequestGap paces the requests: about 200 a second.
	// A HIT costs nginx a lookup, so the rate is what keeps a night's walk
	// of the whole list short; an encode is far slower than the gap, which
	// is what keeps the optimizer to one at a time for this job.
	imageVariantWarmRequestGap = 5 * time.Millisecond

	// imageVariantWarmRequestTimeout bounds one request.  Longer than the
	// 60 s nginx waits on the optimizer, so nginx's own answer (a 503, when
	// the optimizer does not answer in time) arrives first, and an encode in
	// progress is not abandoned by our hanging up.
	imageVariantWarmRequestTimeout = 90 * time.Second

	// imageVariantWarmSlowAfter is the answer time beyond which the
	// optimizer is taken to be busy with other traffic.  A stored variant
	// answers in milliseconds and an idle encode in about a second.
	imageVariantWarmSlowAfter = 5 * time.Second

	// imageVariantWarmPause is how long a pass waits after a busy or slow
	// answer before it asks again.
	imageVariantWarmPause = 10 * time.Minute

	// imageVariantWarmGroups is the refresh cycle in nights: one group of
	// images a night is encoded again (see the file comment).  Under the 30
	// days a variant is valid, so a refresh always comes before expiry.
	imageVariantWarmGroups = 25
)

// imageVariantWarmBaseURLEnv names the switch; see the file comment.
const imageVariantWarmBaseURLEnv = "IMAGE_VARIANT_WARM_BASE_URL"

// variantWarmMirrorPrefix is the address the pages use for an AniList image
// (next-app's NEXT_PUBLIC_IMAGE_MIRROR_BASE in production), and the one
// nginx's cache key rewrites to the AniList address ($next_image_key_args).
// The job asks in that form so its variants are the pages' variants.
const variantWarmMirrorPrefix = "https://animegoclub.com/img/anilist/"

const (
	// variantWarmAccept is what a browser that takes AVIF sends; nginx keys
	// the variant by the format it picks from it ($next_image_fmt).
	variantWarmAccept = "image/avif,image/webp,*/*"

	// variantWarmRefreshHeader asks the internal location to encode the
	// variant again and replace the entry (its proxy_cache_bypass).
	variantWarmRefreshHeader = "X-Warm-Refresh"

	// variantWarmCacheStatusHeader is where the internal location reports
	// $upstream_cache_status.
	variantWarmCacheStatusHeader = "X-Cache-Status"
)

// imageShape names a kind of page image by where AniList keeps it.
type imageShape string

const (
	shapeCover     imageShape = "cover"
	shapeBanner    imageShape = "banner"
	shapeCharacter imageShape = "character"
	shapeStaff     imageShape = "staff"
)

// pageShape is one kind of image nginx keeps in the page zone: the AniList
// paths it covers and the widths it is kept at.
type pageShape struct {
	// pattern matches the part of the URL after anilistCDNPrefix, written
	// as nginx's map writes it once each %2F there is read as a slash.
	pattern string
	widths  []int
	re      *regexp.Regexp
}

func newPageShape(pattern string, widths ...int) pageShape {
	return pageShape{pattern: pattern, widths: widths, re: regexp.MustCompile(`^` + pattern + `$`)}
}

// allows reports whether a page asks for this kind of image, at this width,
// for a path.
func (s pageShape) allows(path string, width int) bool {
	return slices.Contains(s.widths, width) && s.re.MatchString(path)
}

// The format and quality of every page variant.  The pages ask for q=85
// only (next.config.ts allows no other), and the browsers the site serves
// take AVIF; nginx keeps nothing else in the page zone.
const (
	pageShapeQuality = 85
	pageShapeFormat  = "avif"
)

// pageShapes is the variants nginx keeps in the page zone, by kind: the
// widths the pages lay each kind of image out at, at one and two device
// pixels per CSS pixel.  The same list is nginx's map routing
// /_next/image requests to the next_image zone, in nginx/default.p9.conf;
// TestPageShapes_MatchNginx holds the two equal.  A width here and not
// there is one this job fills a zone with that the pages never read; a
// width there and not here is one the job never fills.
var pageShapes = map[imageShape]pageShape{
	shapeCover:     newPageShape(`media/(anime|manga)/cover/(large|medium)/[A-Za-z0-9_.-]+`, 64, 96, 256, 384, 640),
	shapeBanner:    newPageShape(`media/anime/banner/[A-Za-z0-9_.-]+`, 640, 828, 1080, 1200, 1920),
	shapeCharacter: newPageShape(`character/medium/[A-Za-z0-9_.-]+`, 64, 128),
	shapeStaff:     newPageShape(`staff/medium/[A-Za-z0-9_.-]+`, 64, 96, 128),
}

// warmEntry is one role in variantWarmList: the kind of image that plays
// it, and the widths the job asks for.
type warmEntry struct {
	shape  imageShape
	widths []int
}

// variantWarmList is what the job asks for, by the role an image plays on a
// page -- the names ListImageVariantWarmTargets gives the roles.  Every
// width is one the page asks for that image at, on a desktop, a 2x laptop
// screen or a phone, and every one is a page shape
// (TestVariantWarmList_IsPageShapes).
var variantWarmList = map[string]warmEntry{
	// The show's own cover: the detail page's (256 at 1x, 640 at 2x and on
	// phones) and the seasonal grid's (256 at 1x, 384 at 2x).
	"cover": {shapeCover, []int{256, 384, 640}},
	// The detail page's banner: 1920 on desktops, 1200 on phones.
	"banner": {shapeBanner, []int{1200, 1920}},
	// Related works' and recommendations' covers: 256 at 1x, 384 at 2x.
	"related":     {shapeCover, []int{256, 384}},
	"recommended": {shapeCover, []int{256, 384}},
	// The first characters and their voices: 64 at 1x, 128 at 2x.
	"character": {shapeCharacter, []int{64, 128}},
	"voice":     {shapeStaff, []int{64, 128}},
	// The first staff: 64 at 1x, 96 at 2x.
	"staff": {shapeStaff, []int{64, 96}},
}

// How many characters and staff the detail page shows: next-app's
// DETAIL_CHARACTERS_SHOWN and DETAIL_STAFF_SHOWN (detailPeople.ts).  The
// query takes the first this many, in the order the API returns them.
const (
	variantWarmCharactersShown = 8
	variantWarmStaffShown      = 10
)

// The window, as times of day in variantWarmZone.  A pass runs from
// variantWarmWindowOpen to variantWarmWindowClose, less the stretch from
// variantWarmBackupFrom to variantWarmBackupUntil, which the nightly
// database backup has.
const (
	variantWarmWindowOpen  = 1 * time.Hour
	variantWarmBackupFrom  = 3*time.Hour + 15*time.Minute
	variantWarmBackupUntil = 4 * time.Hour
	variantWarmWindowClose = 7 * time.Hour
)

// variantWarmZone is Asia/Shanghai as a fixed +08:00 offset.  China has kept
// no daylight saving since 1991, so the offset is that zone's answer for any
// night this job will see, and a fixed zone needs no tzdata in the image and
// cannot fail to load (activity.reportingZone makes the same choice).  The
// process itself runs in UTC; every time of day here is read in this zone.
var variantWarmZone = time.FixedZone("UTC+8", 8*60*60)

// ImageVariantWarmStore is the database surface: the one read-only list.
// *dbgen.Queries satisfies it.
type ImageVariantWarmStore interface {
	ListImageVariantWarmTargets(ctx context.Context, charactersShown int32, staffShown int32) ([]dbgen.ListImageVariantWarmTargetsRow, error)
}

// ImageVariantWarmWorker runs the job.
type ImageVariantWarmWorker struct {
	river.WorkerDefaults[ImageVariantWarmArgs]
	store  ImageVariantWarmStore
	client *http.Client
	// freeBytes reports the free space on the file system holding a path
	// (hostFreeBytes); tests replace it.
	freeBytes func(path string) (uint64, error)
	// now and sleep are the clock: the window, the budget, an answer's
	// time and the pauses all read it.  Tests replace both.
	now   func() time.Time
	sleep func(context.Context, time.Duration) error
	// The pacing, the slow threshold and the pause: the constants above,
	// held here so tests can shorten them.
	requestGap time.Duration
	slowAfter  time.Duration
	pauseFor   time.Duration
	// unreachablePasses counts the passes in a row that stopped because the
	// endpoint took no connection; any answer from it resets the count.
	// Held for the life of the process, so a restart starts it from zero.
	unreachablePasses atomic.Int32
	// cursor is how far tonight's passes have got (see the file comment).
	cursor variantWarmCursor
}

// NewImageVariantWarmWorker builds the worker.
func NewImageVariantWarmWorker(store ImageVariantWarmStore) *ImageVariantWarmWorker {
	return &ImageVariantWarmWorker{
		store:      store,
		client:     newImageVariantWarmClient(),
		freeBytes:  hostFreeBytes,
		now:        time.Now,
		sleep:      sleepCtx,
		requestGap: imageVariantWarmRequestGap,
		slowAfter:  imageVariantWarmSlowAfter,
		pauseFor:   imageVariantWarmPause,
	}
}

// newImageVariantWarmClient is image_warm's client -- never through a
// proxy, a five-second connect, a redirect taken as the answer -- with a
// timeout long enough to outlast nginx's wait on the optimizer.
func newImageVariantWarmClient() *http.Client {
	c := newImageWarmClient()
	c.Timeout = imageVariantWarmRequestTimeout
	return c
}

// imageVariantWarmBaseURL reads the switch.  "" with no error is off.  A
// value that is not an http(s) URL with a host and a path, and no query or
// fragment, is an error: the query string is the job's to write, and a
// bare host would send every request to a location that is not the
// optimizer's.
func imageVariantWarmBaseURL() (string, error) {
	raw := strings.TrimSpace(os.Getenv(imageVariantWarmBaseURLEnv))
	if raw == "" {
		return "", nil
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("%s: %w", imageVariantWarmBaseURLEnv, err)
	}
	if (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.Path == "" || u.Path == "/" ||
		u.RawQuery != "" || u.ForceQuery || u.Fragment != "" {
		return "", fmt.Errorf("%s=%q: want an http(s) URL with a host and a path, and no query",
			imageVariantWarmBaseURLEnv, raw)
	}
	return raw, nil
}

// variantRequestURL is the request for one variant: the query string
// next/image's loader writes (url, w, q, in that order and nothing else,
// the only shape nginx accepts), with the image's mirror address as url.
// url.QueryEscape writes %3A and %2F in upper case and leaves the
// characters of an allowlisted path as they are, which is the spelling
// nginx's key rewrite matches; TestVariantRequestURL_MatchesNginx holds it
// to nginx's two expressions.
func variantRequestURL(base, path string, width int) string {
	return base + "?url=" + url.QueryEscape(variantWarmMirrorPrefix+path) +
		"&w=" + strconv.Itoa(width) + "&q=" + strconv.Itoa(pageShapeQuality)
}

// variantTarget is one request a pass sends: one image at one width.
type variantTarget struct {
	url   string // the AniList URL, as the database holds it
	path  string // url after anilistCDNPrefix
	width int
	group int // refreshGroup(url)
}

// variantTargets turns the query's rows into tonight's list, in the query's
// order and, within an image, by width.  An image outside the mirror's
// allowlist is dropped, and so is every width the page shapes do not have
// for its path: an overlay can name an image of a kind or size no page
// asks for.  Roles the warm list does not know are returned so the pass can
// report them; the query and variantWarmList must agree on the names.
func variantTargets(rows []dbgen.ListImageVariantWarmTargetsRow) (targets []variantTarget, unknownRoles []string) {
	for _, row := range rows {
		path, ok := warmPath(row.Url)
		if !ok {
			continue
		}
		widths, unknown := variantWidths(path, row.Roles)
		for _, role := range unknown {
			if !slices.Contains(unknownRoles, role) {
				unknownRoles = append(unknownRoles, role)
			}
		}
		group := refreshGroup(row.Url)
		for _, w := range widths {
			targets = append(targets, variantTarget{url: row.Url, path: path, width: w, group: group})
		}
	}
	return targets, unknownRoles
}

// variantWidths is every width the roles ask an image for that its kind of
// path is kept at, each once, smallest first.
func variantWidths(path string, roles []string) (widths []int, unknownRoles []string) {
	for _, role := range roles {
		entry, ok := variantWarmList[role]
		if !ok {
			unknownRoles = append(unknownRoles, role)
			continue
		}
		shape := pageShapes[entry.shape]
		for _, w := range entry.widths {
			if shape.allows(path, w) && !slices.Contains(widths, w) {
				widths = append(widths, w)
			}
		}
	}
	slices.Sort(widths)
	return widths, unknownRoles
}

// refreshGroup is the refresh group of an image: every width of it is in
// the same one.  By its URL, so an image keeps its group however the list
// around it changes.
func refreshGroup(imageURL string) int {
	h := fnv.New32a()
	_, _ = io.WriteString(h, imageURL) // a hash.Hash never fails a write
	return int(h.Sum32() % imageVariantWarmGroups)
}

// variantWarmNight is the night a pass belongs to: its date in
// variantWarmZone, as days since the Unix epoch.  The window lies after
// midnight, so a night's passes all share the date.
func variantWarmNight(t time.Time) int64 {
	y, m, d := t.In(variantWarmZone).Date()
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC).Unix() / (24 * 60 * 60)
}

// tonightsGroup is the refresh group a night asks to be encoded again.
// Consecutive nights take consecutive groups, so 25 nights take every one.
func tonightsGroup(night int64) int {
	return int(night % imageVariantWarmGroups)
}

// variantWarmTimeOfDay is how long after midnight in variantWarmZone t is,
// and that midnight.
func variantWarmTimeOfDay(t time.Time) (time.Duration, time.Time) {
	local := t.In(variantWarmZone)
	y, m, d := local.Date()
	midnight := time.Date(y, m, d, 0, 0, 0, 0, variantWarmZone)
	return local.Sub(midnight), midnight
}

// inVariantWarmWindow reports whether a pass may ask at t.
func inVariantWarmWindow(t time.Time) bool {
	d, _ := variantWarmTimeOfDay(t)
	return d >= variantWarmWindowOpen && d < variantWarmWindowClose &&
		(d < variantWarmBackupFrom || d >= variantWarmBackupUntil)
}

// variantWarmWindowEnd is when the stretch of the window t is in closes:
// the backup's start for a time before it, the window's close for one
// after.  For a time outside the window, t itself.
func variantWarmWindowEnd(t time.Time) time.Time {
	if !inVariantWarmWindow(t) {
		return t
	}
	d, midnight := variantWarmTimeOfDay(t)
	if d < variantWarmBackupFrom {
		return midnight.Add(variantWarmBackupFrom)
	}
	return midnight.Add(variantWarmWindowClose)
}

// variantWarmCursor is how far down tonight's list the passes have got.
// One per process: see the file comment for why a restart starting again
// from the top is the right thing to lose.
type variantWarmCursor struct {
	mu sync.Mutex
	// night is the night the rest is about (variantWarmNight); 0, the
	// epoch's own date, is never one a pass runs on, so a cursor nobody
	// has saved is about no night.
	night int64
	next  int  // the position of the next variant to ask about
	done  bool // the whole list has been asked about tonight
}

// at is where tonight's next pass starts, and whether there is anything
// left: the top of the list on a night no pass has saved.
func (c *variantWarmCursor) at(night int64) (next int, done bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.night != night {
		return 0, false
	}
	return c.next, c.done
}

// save records where a pass stopped.
func (c *variantWarmCursor) save(night int64, next int, done bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.night, c.next, c.done = night, next, done
}

// Timeout bounds one pass.
func (w *ImageVariantWarmWorker) Timeout(*river.Job[ImageVariantWarmArgs]) time.Duration {
	return imageVariantWarmTimeout
}

// Work runs one pass.
func (w *ImageVariantWarmWorker) Work(ctx context.Context, _ *river.Job[ImageVariantWarmArgs]) error {
	ctx, cancel := context.WithTimeout(ctx, imageVariantWarmTimeout)
	defer cancel()
	start := w.clock()
	base, night, from, run := w.preflight(ctx, start)
	if !run {
		return nil
	}

	rows, err := w.store.ListImageVariantWarmTargets(ctx, variantWarmCharactersShown, variantWarmStaffShown)
	if err != nil {
		return fmt.Errorf("image variant warm: list targets: %w", err)
	}
	targets, unknownRoles := variantTargets(rows)
	if len(unknownRoles) > 0 {
		slog.ErrorContext(ctx, "image variant warm: the target query names roles the warm list does not know; "+
			"their images are not asked for", "roles", unknownRoles)
	}

	p := &variantWarmPass{
		w:        w,
		base:     base,
		deadline: start.Add(imageVariantWarmPassBudget),
		group:    tonightsGroup(night),
		limiter:  rate.NewLimiter(rate.Every(w.requestGap), 1),
		next:     from,
	}
	p.run(ctx, targets)
	w.cursor.save(night, p.next, p.reason == "done")
	slog.InfoContext(ctx, "image variant warm pass done",
		"night", start.In(variantWarmZone).Format(time.DateOnly),
		"group", p.group,
		"targets", len(targets),
		"cursorStart", from,
		"cursorEnd", p.next,
		"requests", p.requests,
		"hit", p.hit,
		"filled", p.filled,
		"refreshed", p.refreshed,
		"missing", p.missing,
		"failed", p.failed,
		"paused", p.paused,
		"stopped", p.reason,
		"duration", w.clock().Sub(start).Round(time.Millisecond))
	return nil
}

// preflight runs what comes before the list, in order: the switch, the
// window, tonight's cursor, the disk.  run is false when the pass must not
// go on; nothing here is an error for river.  The window comes before the
// disk so a disk that stays low pages someone once a night, not once an
// hour: the image warm job already reports it around the clock.
func (w *ImageVariantWarmWorker) preflight(ctx context.Context, now time.Time) (base string, night int64, from int, run bool) {
	base, err := imageVariantWarmBaseURL()
	if err != nil {
		slog.ErrorContext(ctx, "image variant warm: base URL not usable, skipping pass", "err", err)
		return "", 0, 0, false
	}
	if base == "" {
		slog.InfoContext(ctx, "image variant warm: off, no base URL", "env", imageVariantWarmBaseURLEnv)
		return "", 0, 0, false
	}
	if !inVariantWarmWindow(now) {
		slog.InfoContext(ctx, "image variant warm: outside the night window, skipping pass",
			"localTime", now.In(variantWarmZone).Format(time.DateTime))
		return "", 0, 0, false
	}
	night = variantWarmNight(now)
	from, done := w.cursor.at(night)
	if done {
		slog.InfoContext(ctx, "image variant warm: tonight's list is done, skipping pass",
			"night", now.In(variantWarmZone).Format(time.DateOnly), "asked", from)
		return "", 0, 0, false
	}
	if !w.diskHasRoom(ctx) {
		return "", 0, 0, false
	}
	return base, night, from, true
}

// diskHasRoom is image_warm's disk guard, on the same disk and floor: the
// variants are written beside the originals, onto the disk the database is
// on.  A free-space figure it cannot read counts as no room.
func (w *ImageVariantWarmWorker) diskHasRoom(ctx context.Context) bool {
	free, err := w.freeBytes(imageWarmDiskPath)
	if err != nil {
		slog.ErrorContext(ctx, "image variant warm: free disk space unreadable, skipping pass",
			"path", imageWarmDiskPath, "err", err)
		return false
	}
	if free < imageWarmMinFreeBytes {
		slog.ErrorContext(ctx, "image variant warm: host disk nearly full, skipping pass",
			"path", imageWarmDiskPath, "freeBytes", free, "minFreeBytes", imageWarmMinFreeBytes)
		return false
	}
	return true
}

// clock reads the injected time source, defaulting to time.Now.
func (w *ImageVariantWarmWorker) clock() time.Time {
	if w.now == nil {
		return time.Now()
	}
	return w.now()
}

// pause sleeps d, or returns early with ctx's error.
func (w *ImageVariantWarmWorker) pause(ctx context.Context, d time.Duration) error {
	if w.sleep == nil {
		return sleepCtx(ctx, d)
	}
	return w.sleep(ctx, d)
}

// variantWarmPass is one pass's state: where it is in the list, what it has
// seen, and whether and why it stopped.
type variantWarmPass struct {
	w        *ImageVariantWarmWorker
	base     string
	deadline time.Time
	group    int // tonight's refresh group
	limiter  *rate.Limiter

	// next is the position of the next variant to ask about.  It moves past
	// a variant once the endpoint has answered about it, whatever the
	// answer; a request that got no answer (no connection, the pass
	// cancelled) leaves it where it is, for the next pass to ask again.
	next int

	requests, hit, filled, refreshed, missing, failed, paused int
	failuresInARow                                            int
	warnedMissing, warnedRefreshIgnored                       bool
	stopped                                                   bool
	reason                                                    string
}

// run asks for each variant in turn, from p.next, until the list, the
// budget, the window or the pass runs out.
func (p *variantWarmPass) run(ctx context.Context, targets []variantTarget) {
	for p.next < len(targets) {
		if p.stopped || !p.mayAsk(ctx) {
			return
		}
		if err := p.limiter.Wait(ctx); err != nil {
			p.stop("cancelled")
			return
		}
		t := targets[p.next]
		p.requests++
		began := p.w.clock()
		a := p.w.ask(ctx, p.base, t, t.group == p.group)
		p.record(ctx, t, a, p.w.clock().Sub(began))
	}
	p.stop("done")
}

// mayAsk checks, before each request, that the pass may still send one.
func (p *variantWarmPass) mayAsk(ctx context.Context) bool {
	now := p.w.clock()
	switch {
	case ctx.Err() != nil:
		p.stop("cancelled")
	case !now.Before(p.deadline):
		p.stop("time")
	case !inVariantWarmWindow(now):
		p.stop("window")
	default:
		return true
	}
	return false
}

// stop ends the pass; the first reason given is the one reported.
func (p *variantWarmPass) stop(reason string) {
	if !p.stopped {
		p.stopped, p.reason = true, reason
	}
}

// record acts on one answer.  took is how long it took to arrive.
func (p *variantWarmPass) record(ctx context.Context, t variantTarget, a variantAnswer, took time.Duration) {
	switch a.kind {
	case variantUnreachable:
		p.stop("unreachable")
		p.onUnreachable(ctx, a)
		return
	case variantCancelled:
		p.stop("cancelled")
		return
	}

	// An answer about this variant: the endpoint is up, and the variant is
	// done with for tonight, whatever the answer was.
	p.w.unreachablePasses.Store(0)
	p.next++
	switch a.kind {
	case variantHit, variantFilled:
		if a.kind == variantHit {
			p.hit++
		} else {
			p.filled++
		}
		p.failuresInARow = 0
		if t.group == p.group {
			p.onRefreshIgnored(ctx, t, a)
		}
	case variantRefreshed:
		p.refreshed++
		p.failuresInARow = 0
	case variantMissing:
		p.missing++
		p.failuresInARow = 0
		p.onMissing(ctx, t, a)
	case variantBusy:
		// Neither a failure nor a success: it says nothing about whether
		// the requests work, only that the optimizer has no room now.
		p.pause(ctx, "busy", t, a, took)
		return
	default:
		p.onFailure(ctx, t, a)
		if p.stopped {
			return
		}
	}
	if took > p.w.slowAfter {
		p.pause(ctx, "slow", t, a, took)
	}
}

// pause waits imageVariantWarmPause, or until the budget or the stretch of
// the window runs out if that is sooner, and then the pass goes on with the
// next variant: the one that met the busy answer is left for tomorrow's
// pass (see the file comment).
func (p *variantWarmPass) pause(ctx context.Context, why string, t variantTarget, a variantAnswer, took time.Duration) {
	p.paused++
	now := p.w.clock()
	until := now.Add(p.w.pauseFor)
	if p.deadline.Before(until) {
		until = p.deadline
	}
	if end := variantWarmWindowEnd(now); end.Before(until) {
		until = end
	}
	wait := max(until.Sub(now), 0)
	slog.InfoContext(ctx, "image variant warm: optimizer busy, pausing",
		"why", why, "status", a.status, "took", took.Round(time.Millisecond),
		"url", t.url, "width", t.width, "pause", wait)
	if wait == 0 {
		return
	}
	if err := p.w.pause(ctx, wait); err != nil {
		p.stop("cancelled")
	}
}

// onMissing reports the first variant of the pass the endpoint had no image
// for.  Not an error: it is an original gone from the mirror since the list
// was read, or one AniList no longer has.  The rest are only counted.
func (p *variantWarmPass) onMissing(ctx context.Context, t variantTarget, a variantAnswer) {
	if p.warnedMissing {
		return
	}
	p.warnedMissing = true
	slog.WarnContext(ctx, "image variant warm: no image for a variant, the pass goes on (first of the pass)",
		"url", t.url, "width", t.width, "status", a.status)
}

// onRefreshIgnored reports the first variant of the pass that was asked to
// be encoded again and was not: the internal location does not honour
// variantWarmRefreshHeader, so tonight's group is not being refreshed.
// Not a failure -- the variant is stored -- but the 25-night refresh is not
// happening, and nothing else would say so.
func (p *variantWarmPass) onRefreshIgnored(ctx context.Context, t variantTarget, a variantAnswer) {
	if p.warnedRefreshIgnored {
		return
	}
	p.warnedRefreshIgnored = true
	slog.WarnContext(ctx, "image variant warm: a refresh was asked for and not done (first of the pass)",
		"url", t.url, "width", t.width, "cacheStatus", a.cacheStatus, "header", variantWarmRefreshHeader,
		"hint", "the location "+imageVariantWarmBaseURLEnv+" names must bypass its cache on this header")
}

// onFailure counts a failure; the third in a row stops the pass with an
// ERROR.  A failed variant is not asked again tonight.
func (p *variantWarmPass) onFailure(ctx context.Context, t variantTarget, a variantAnswer) {
	p.failed++
	p.failuresInARow++
	if p.failuresInARow < imageWarmFailuresToStop {
		return
	}
	p.stop("failures")
	attrs := []any{"failuresInARow", p.failuresInARow, "url", t.url, "width", t.width,
		"status", a.status, "cacheStatus", a.cacheStatus, "err", a.err}
	if hint := variantFailureHint(a); hint != "" {
		attrs = append(attrs, "hint", hint)
	}
	slog.ErrorContext(ctx, "image variant warm: endpoint failing, pass stopped", attrs...)
}

// variantFailureHint is what to check for the failures that are most
// likely the configuration's.
func variantFailureHint(a variantAnswer) string {
	switch {
	case a.status == http.StatusBadRequest:
		return "nginx refused the query string: variantRequestURL in image_variant_warm.go and " +
			"$next_image_args_ok in nginx/default.p9.conf no longer agree"
	case a.status == http.StatusUnauthorized || a.status == http.StatusForbidden:
		return "refused: nginx's internal image location takes only a page shape at a mirror address, so check " +
			imageVariantWarmBaseURLEnv + ", and that pageShapes and $next_image_zone in nginx/default.p9.conf agree"
	case a.status == http.StatusOK && a.cacheStatus == "":
		return "an answer with no " + variantWarmCacheStatusHeader + " did not come through nginx's cache: " +
			imageVariantWarmBaseURLEnv + " must name nginx's internal image location, not the optimizer"
	}
	return ""
}

// onUnreachable reports a pass stopped because the endpoint took no
// connection: a WARN while that could be a deploy, an ERROR from the
// imageWarmUnreachablePassesToAlert-th pass in a row.
func (p *variantWarmPass) onUnreachable(ctx context.Context, a variantAnswer) {
	n := p.w.unreachablePasses.Add(1)
	if n < imageWarmUnreachablePassesToAlert {
		slog.WarnContext(ctx, "image variant warm: endpoint not reachable, pass stopped",
			"endpoint", p.base, "passesInARow", n, "err", a.err)
		return
	}
	slog.ErrorContext(ctx, "image variant warm: endpoint not reachable pass after pass",
		"endpoint", p.base, "passesInARow", n, "env", imageVariantWarmBaseURLEnv, "err", a.err)
}

// variantAnswerKind is what one request came to.
type variantAnswerKind int

const (
	variantHit         variantAnswerKind = iota + 1 // 200: stored already
	variantFilled                                   // 200: encoded and stored now
	variantRefreshed                                // 200: encoded again, replacing the entry
	variantBusy                                     // 503 or 429: the optimizer has no room
	variantMissing                                  // a 4xx other than 400, 401, 403 and 429
	variantFailed                                   // anything that says the requests themselves are not working
	variantUnreachable                              // no connection to the endpoint, or it broke off
	variantCancelled                                // the pass's own context ended
)

// variantAnswer is one request's outcome.
type variantAnswer struct {
	kind        variantAnswerKind
	status      int    // the HTTP status, 0 when there was no response
	cacheStatus string // X-Cache-Status, upper-cased; "" when absent
	err         error  // the transport error, if any
}

// ask sends one HEAD and reads the answer.
func (w *ImageVariantWarmWorker) ask(ctx context.Context, base string, t variantTarget, refresh bool) variantAnswer {
	req, err := http.NewRequestWithContext(ctx, http.MethodHead, variantRequestURL(base, t.path, t.width), nil)
	if err != nil {
		return variantAnswer{kind: variantUnreachable, err: err}
	}
	req.Header.Set("Accept", variantWarmAccept)
	if refresh {
		req.Header.Set(variantWarmRefreshHeader, "1")
	}
	resp, err := w.client.Do(req)
	if err != nil {
		return variantFromTransport(transportAnswer(ctx, 0, err))
	}
	defer resp.Body.Close()
	_, readErr := io.Copy(io.Discard, resp.Body) // a HEAD answer has no body; drained for the connection's sake
	return classifyVariant(ctx, resp, readErr)
}

// classifyVariant is the thin step in front of image_warm's statusAnswer:
// a 503 or a 429 is the optimizer busy, and a 400 is a failure (see the
// file comment); every other status reads as it does there, and a 200 is
// read further by its cache status.
func classifyVariant(ctx context.Context, resp *http.Response, readErr error) variantAnswer {
	code := resp.StatusCode
	cache := strings.ToUpper(strings.TrimSpace(resp.Header.Get(variantWarmCacheStatusHeader)))
	switch code {
	case http.StatusServiceUnavailable, http.StatusTooManyRequests:
		return variantAnswer{kind: variantBusy, status: code, cacheStatus: cache}
	case http.StatusBadRequest:
		return variantAnswer{kind: variantFailed, status: code, cacheStatus: cache}
	}
	a := statusAnswer(ctx, resp, readErr)
	out := variantAnswer{status: a.status, cacheStatus: cache, err: a.err}
	switch a.kind {
	case answerStored:
		out.kind = cacheStatusKind(cache)
	case answerMissing:
		out.kind = variantMissing
	case answerCancelled:
		out.kind = variantCancelled
	default:
		out.kind = variantFailed
	}
	return out
}

// cacheStatusKind reads nginx's $upstream_cache_status on a 200.  Anything
// else, or nothing, is a failure: see the file comment.
func cacheStatusKind(status string) variantAnswerKind {
	switch status {
	case "HIT", "STALE", "UPDATING", "REVALIDATED":
		return variantHit
	case "MISS", "EXPIRED":
		return variantFilled
	case "BYPASS":
		return variantRefreshed
	default:
		return variantFailed
	}
}

// variantFromTransport reads a request that got no answer, through
// image_warm's transportAnswer: a timeout is a failure (the optimizer did
// not answer even nginx), a connection never made or broken off is the
// endpoint unreachable, and a context ended is the pass cancelled.
func variantFromTransport(a warmAnswer) variantAnswer {
	out := variantAnswer{kind: variantFailed, status: a.status, err: a.err}
	switch a.kind {
	case answerUnreachable:
		out.kind = variantUnreachable
	case answerCancelled:
		out.kind = variantCancelled
	}
	return out
}

// AddImageVariantWarmWorker registers the job on an existing bundle.  It
// needs only the database: the endpoint is read from
// IMAGE_VARIANT_WARM_BASE_URL at work time.
func AddImageVariantWarmWorker(w *river.Workers, q *dbgen.Queries) {
	river.AddWorker(w, NewImageVariantWarmWorker(q))
	switch base, err := imageVariantWarmBaseURL(); {
	case err != nil:
		slog.Warn("image variant warm job registered, but every pass will skip", "err", err)
	case base == "":
		slog.Info("image variant warm job registered but inert", "env", imageVariantWarmBaseURLEnv)
	}
}

// Compile-time guards.
var (
	_ river.Worker[ImageVariantWarmArgs] = (*ImageVariantWarmWorker)(nil)
	_ ImageVariantWarmStore              = (*dbgen.Queries)(nil)
)
