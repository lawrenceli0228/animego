package queue

import (
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// nginxZoneMapSample is the zone map in the form nginx/default.p9.conf
// writes it: one entry per kind of page image, on the cache key in its
// AniList form, AVIF at q=85 only, and everything else to the misc zone.
// TestPageShapes_ReadsTheZoneMap runs the parser on it, so the guard below
// is itself tested whatever the conf in this checkout holds.
const nginxZoneMapSample = `
map "$next_image_key_args|$next_image_fmt" $next_image_zone {
    default next_image_misc;
    "~^url=https%3A%2F%2Fs4\.anilist\.co%2Ffile%2Fanilistcdn%2Fmedia%2F(anime|manga)%2Fcover%2F(large|medium)%2F[A-Za-z0-9_.-]+&w=(64|96|256|384|640)&q=85\|avif$" next_image;
    "~^url=https%3A%2F%2Fs4\.anilist\.co%2Ffile%2Fanilistcdn%2Fmedia%2Fanime%2Fbanner%2F[A-Za-z0-9_.-]+&w=(640|828|1080|1200|1920)&q=85\|avif$" next_image;
    "~^url=https%3A%2F%2Fs4\.anilist\.co%2Ffile%2Fanilistcdn%2Fcharacter%2Fmedium%2F[A-Za-z0-9_.-]+&w=(64|128)&q=85\|avif$" next_image;
    "~^url=https%3A%2F%2Fs4\.anilist\.co%2Ffile%2Fanilistcdn%2Fstaff%2Fmedium%2F[A-Za-z0-9_.-]+&w=(64|96|128)&q=85\|avif$" next_image;
}
`

// TestPageShapes_MatchNginx holds pageShapes to the map in the nginx config
// production runs that sends /_next/image variants to the page zone
// ($next_image_zone in nginx/default.p9.conf).  A kind or width the map has
// and pageShapes lacks is a page variant the job never fills, which readers
// of old shows then wait on; one pageShapes has and the map lacks is a
// variant the job asks for and the internal location refuses (403), which
// stops its passes.  The widths the pages request are held to the same map
// by next-app's own test.
//
// The skip below is for a checkout whose nginx config has no zone split at
// all, the state before the map lands.  It is narrow on purpose: a config
// that mentions next_image_misc but has no map this test can read fails
// here instead of skipping, so a renamed or reshaped map cannot turn the
// guard off.  Once the map is in every branch, the skip can go.
func TestPageShapes_MatchNginx(t *testing.T) {
	t.Parallel()

	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "nginx", "default.p9.conf"))
	require.NoError(t, err)
	conf := string(raw)

	zm, found := readNginxZoneMap(t, conf)
	require.True(t, found, "nginx/default.p9.conf has no $next_image_zone map this test can find")
	assertZoneMapIsPageShapes(t, zm)
}

// TestPageShapes_ReadsTheZoneMap runs the drift guard on the map's expected
// form, and checks that it notices drift.
func TestPageShapes_ReadsTheZoneMap(t *testing.T) {
	t.Parallel()

	zm, found := readNginxZoneMap(t, nginxZoneMapSample)
	require.True(t, found)
	assertZoneMapIsPageShapes(t, zm)

	// And it notices drift, in either direction.  Each edit is to the first
	// place its text appears in the sample.
	for name, edit := range map[string][2]string{
		"a width nginx lacks":       {`&w=(64|96|256|384|640)`, `&w=(64|96|256|384)`},
		"a width the job lacks":     {`&w=(64|128)`, `&w=(64|128|256)`},
		"a kind nginx lacks":        {`%2Fcover%2F(large|medium)`, `%2Fcover%2Flarge`},
		"another format":            {`\|avif$`, `\|webp$`},
		"another quality":           {`&w=(64|128)&q=85`, `&w=(64|128)&q=75`},
		"another default":           {`default next_image_misc;`, `default next_image;`},
		"an entry for another zone": {`&w=(64|96|128)&q=85\|avif$" next_image;`, `&w=(64|96|128)&q=85\|avif$" next_image_misc;`},
	} {
		mutated := strings.Replace(nginxZoneMapSample, edit[0], edit[1], 1)
		require.NotEqual(t, nginxZoneMapSample, mutated, name)
		zm, found := readNginxZoneMap(t, mutated)
		require.True(t, found, name)
		var guard failureRecorder
		assertZoneMapIsPageShapes(&guard, zm)
		assert.True(t, guard.failed, "the guard must fail on %s", name)
	}
}

// guardT is what the guard reports to: a *testing.T, or a failureRecorder
// when a test wants to see the guard fail.
type guardT interface {
	Helper()
	Errorf(format string, args ...any)
}

// failureRecorder notes whether anything was reported to it.
type failureRecorder struct{ failed bool }

func (*failureRecorder) Helper()                 {}
func (r *failureRecorder) Errorf(string, ...any) { r.failed = true }

// nginxZoneMap is the $next_image_zone map as the conf writes it.
type nginxZoneMap struct {
	defaultZone string
	entries     []nginxZoneEntry // in the conf's order, which is nginx's order of matching
}

// nginxZoneEntry is one regex entry: the expression after "~", and the zone.
type nginxZoneEntry struct {
	expr string
	zone string
}

var (
	nginxZoneMapStart = regexp.MustCompile(`(?m)^[ \t]*map[ \t]+"\$next_image_key_args\|\$next_image_fmt"[ \t]+\$next_image_zone[ \t]*\{[ \t]*$`)
	nginxZoneDefault  = regexp.MustCompile(`^default\s+([A-Za-z0-9_]+);$`)
	nginxZoneRegex    = regexp.MustCompile(`^"~([^"]+)"\s+([A-Za-z0-9_]+);$`)
	// nginxPageShapeExpr reads a page-shape entry back into its parts: the
	// path pattern (with %2F for each slash), the widths, the quality and
	// the format.
	nginxPageShapeExpr = regexp.MustCompile(`^\^url=https%3A%2F%2Fs4\\\.anilist\\\.co%2Ffile%2Fanilistcdn%2F(.+)&w=\(([0-9|]+)\)&q=([0-9]+)\\\|([a-z]+)\$$`)
)

// readNginxZoneMap finds the map block and reads its entries; found is
// false when the conf has no such block.  A line in the block that is not
// an entry, a default, a comment or blank fails the test: the guard must
// not pass over what it cannot read.
func readNginxZoneMap(t *testing.T, conf string) (zm nginxZoneMap, found bool) {
	t.Helper()
	loc := nginxZoneMapStart.FindStringIndex(conf)
	if loc == nil {
		return nginxZoneMap{}, false
	}
	for _, line := range strings.Split(conf[loc[1]:], "\n") {
		line = strings.TrimSpace(line)
		switch {
		case line == "" || strings.HasPrefix(line, "#"):
			continue
		case line == "}":
			return zm, true
		}
		if m := nginxZoneDefault.FindStringSubmatch(line); m != nil {
			zm.defaultZone = m[1]
			continue
		}
		m := nginxZoneRegex.FindStringSubmatch(line)
		require.NotNil(t, m, "a line in the $next_image_zone map this test cannot read: %q", line)
		zm.entries = append(zm.entries, nginxZoneEntry{expr: m[1], zone: m[2]})
	}
	t.Fatal("the $next_image_zone map in nginx/default.p9.conf never closes")
	return nginxZoneMap{}, false
}

// assertZoneMapIsPageShapes is the guard: the map's next_image entries, read
// back into kinds and widths, are pageShapes exactly; everything else goes
// to the misc zone; and the keys of the job's own requests land in the page
// zone, while the same image in another format, at another width or at
// another quality does not.
func assertZoneMapIsPageShapes(t guardT, zm nginxZoneMap) {
	t.Helper()
	assert.Equal(t, "next_image_misc", zm.defaultZone, "everything that is not a page shape goes to the misc zone")

	nginx := map[string][]int{}
	for _, e := range zm.entries {
		if !assert.Equal(t, "next_image", e.zone, "an entry routes to %q; the map has two zones and only "+
			"page shapes are listed: %s", e.zone, e.expr) {
			continue
		}
		m := nginxPageShapeExpr.FindStringSubmatch(e.expr)
		if !assert.NotNil(t, m, "a next_image entry this test cannot read as a page shape: %s", e.expr) {
			continue
		}
		pattern := strings.ReplaceAll(m[1], "%2F", "/")
		assert.Equal(t, strconv.Itoa(pageShapeQuality), m[3], "%s: the pages ask for q=%d only", pattern, pageShapeQuality)
		assert.Equal(t, pageShapeFormat, m[4], "%s: the page zone holds %s only", pattern, pageShapeFormat)
		var widths []int
		for _, w := range strings.Split(m[2], "|") {
			n, err := strconv.Atoi(w)
			if assert.NoError(t, err, "%s: width %q", pattern, w) {
				widths = append(widths, n)
			}
		}
		slices.Sort(widths)
		_, dup := nginx[pattern]
		assert.False(t, dup, "%s is listed twice", pattern)
		nginx[pattern] = widths
	}

	want := map[string][]int{}
	for _, s := range pageShapes {
		widths := slices.Clone(s.widths)
		slices.Sort(widths)
		want[s.pattern] = widths
	}
	assert.Equal(t, want, nginx, "pageShapes in image_variant_warm.go and nginx's $next_image_zone map must list "+
		"the same kinds of image at the same widths")

	// The same thing as nginx does it: the first entry that matches the
	// key decides the zone.
	zoneOf := func(key string) string {
		for _, e := range zm.entries {
			re, err := regexp.Compile(e.expr)
			if assert.NoError(t, err, e.expr) && re.MatchString(key) {
				return e.zone
			}
		}
		return zm.defaultZone
	}
	key := func(path string, width, quality int, format string) string {
		return "url=" + url.QueryEscape(anilistCDNPrefix+path) + "&w=" + strconv.Itoa(width) +
			"&q=" + strconv.Itoa(quality) + "|" + format
	}
	for role, entry := range variantWarmList {
		path := pageShapeSamples[entry.shape]
		for _, w := range entry.widths {
			assert.Equal(t, "next_image", zoneOf(key(path, w, pageShapeQuality, pageShapeFormat)),
				"the job's %s at %d must land in the page zone", role, w)
		}
	}
	for shape, path := range pageShapeSamples {
		w := pageShapes[shape].widths[0]
		assert.Equal(t, "next_image_misc", zoneOf(key(path, w, pageShapeQuality, "webp")), "%s as WebP", shape)
		assert.Equal(t, "next_image_misc", zoneOf(key(path, w, pageShapeQuality, "orig")), "%s in its own format", shape)
		assert.Equal(t, "next_image_misc", zoneOf(key(path, w, 75, pageShapeFormat)), "%s at q=75", shape)
		assert.Equal(t, "next_image_misc", zoneOf(key(path, 100, pageShapeQuality, pageShapeFormat)), "%s at 100", shape)
	}
}
