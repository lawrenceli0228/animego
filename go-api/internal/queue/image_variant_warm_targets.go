// image_variant_warm_targets.go — what the variant warm job asks for: the
// kinds of image nginx keeps for the pages and the widths of each
// (pageShapes), the widths the job asks each role for (variantWarmList), and
// the request it sends for one image at one width.  See
// image_variant_warm.go.
package queue

import (
	"net/url"
	"regexp"
	"slices"
	"strconv"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// variantWarmMirrorPrefix is the address the pages use for an AniList image
// (next-app's NEXT_PUBLIC_IMAGE_MIRROR_BASE in production), and the one
// nginx's cache key rewrites to the AniList address ($next_image_key_args).
// The job asks in that form so its variants are the pages' variants.
const variantWarmMirrorPrefix = "https://animegoclub.com/img/anilist/"

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
