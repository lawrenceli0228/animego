package queue

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/testutil"
)

// TestImageVariantWarm_PG runs ListImageVariantWarmTargets on a real
// Postgres: which images it returns for a page, resolved how, in what
// order, and what a pass then asks nginx for.  The images are the detail
// API's, so each case is a rule of internal/anime/detail.go or of the
// detail queries (GetAnimeCharactersByID, GetAnimeStaffByID,
// GetRelationEnrichmentByIDs) seen from this query's side.
//
// NOT parallel: the last subtest runs a pass, which sets
// IMAGE_VARIANT_WARM_BASE_URL and swaps slog.Default.
func TestImageVariantWarm_PG(t *testing.T) {
	ctx := context.Background()
	uri := testutil.SetupPG(t)
	pool := testutil.NewWebPool(t, ctx, uri)
	q := dbgen.New(pool)
	h := &variantPGHarness{imageWarmHarness: &imageWarmHarness{ctx: ctx, pool: pool, q: q}}

	t.Run("shows the site lists, most popular first, each with its cover and then its banner", func(t *testing.T) {
		h.reset(t)
		h.show(t, 1, 100, false, pvCover(1), pvBanner(1))
		h.show(t, 2, 500, false, pvCover(2), nil)
		h.show(t, 3, nil, false, pvCover(3), pvBanner(3))
		h.show(t, 4, 300, true, pvCover(4), pvBanner(4))
		h.show(t, 5, 100, false, pvCover(5), "")
		h.warm(t, pvCover(1), pvBanner(1), pvCover(2), pvCover(3), pvBanner(3), pvCover(4), pvBanner(4), pvCover(5))

		assert.Equal(t, []string{
			"media/anime/cover/large/bx2-pv.jpg cover", // the most popular
			"media/anime/cover/large/bx1-pv.jpg cover", // a tie at 100: the lower id first
			"media/anime/banner/1-pv.jpg banner",
			"media/anime/cover/large/bx5-pv.jpg cover", // no banner, nor an empty one
			"media/anime/cover/large/bx3-pv.jpg cover", // no popularity: last
			"media/anime/banner/3-pv.jpg banner",
		}, h.list(t), "the adult show, 4, is not there at all")
	})

	t.Run("related works as the detail API enriches them, and every recommendation", func(t *testing.T) {
		h.reset(t)
		h.show(t, 10, 50, false, pvCover(10), nil)
		h.show(t, 11, 40, false, pvCover(11), nil)
		h.show(t, 12, 30, false, pvCover(12), nil)
		h.show(t, 15, 20, true, pvCover(15), nil)
		h.relation(t, 10, 11, pvRelated(11)) // its own cover: kept, though 11 has another
		h.relation(t, 10, 12, nil)           // none of its own: 12's, as enrichRelations falls back
		h.relation(t, 10, 13, nil)           // none, and 13 is not in anime_cache: nothing
		h.relation(t, 10, 14, "")            // empty: the API keeps "", which is no image
		h.relation(t, 10, 15, nil)           // an adult show's cover still shows here
		var recommended []string
		for n := 101; n <= 112; n++ {
			h.recommendation(t, 10, n, pvRelated(n))
			recommended = append(recommended, pvRelated(n))
		}
		h.warm(t, append([]string{pvCover(10), pvCover(11), pvCover(12), pvCover(15), pvRelated(11)}, recommended...)...)

		want := []string{"media/anime/cover/large/bx10-pv.jpg cover"}
		want = append(want, sorted(
			"media/anime/cover/large/bx12-pv.jpg cover,related", // 12's own row comes later; the first need places it
			"media/anime/cover/large/bx15-pv.jpg related",
			"media/anime/cover/medium/bx11-pv.jpg related",
		)...)
		for _, u := range recommended {
			want = append(want, strings.TrimPrefix(u, anilistCDNPrefix)+" recommended")
		}
		want = append(want, "media/anime/cover/large/bx11-pv.jpg cover")
		assert.Equal(t, want, h.list(t), "all twelve recommendations: the page shows the first ten of an unordered list")
	})

	t.Run("the first eight characters by display_order and id, an edit's image first, and their voices", func(t *testing.T) {
		h.reset(t)
		h.show(t, 20, 10, false, pvCover(20), nil)
		// Inserted last first, so only the ORDER BY can put them right.
		// The two at display_order 7 are told apart by id.
		h.character(t, 20, 8, "", 1009, 2009, pvCharacter(9), pvPerson(9))
		h.character(t, 20, 7, "00000000-0000-0000-0000-0000000000b2", 1008, 2008, pvCharacter(8), pvPerson(8))
		h.character(t, 20, 7, "00000000-0000-0000-0000-0000000000b1", 1007, 2007, pvCharacter(7), pvPerson(7))
		for n := 6; n >= 0; n-- {
			h.character(t, 20, n, "", 1000+n, 2000+n, pvCharacter(n), pvPerson(n))
		}
		h.overlay(t, "character", 1002, fmt.Sprintf(`{"image": %q}`, pvCharacter(902))) // the edit wins
		h.overlay(t, "character", 1004, `{"nameFull": "Edited"}`)                       // no image in it
		h.overlay(t, "character", 1009, fmt.Sprintf(`{"image": %q}`, pvCharacter(909))) // not among the first eight
		h.overlay(t, "person", 2003, fmt.Sprintf(`{"image": %q}`, pvPerson(903)))       // a voice's edit
		// Every voice of a character lives in anime_character_voices too,
		// which the detail page never reads.
		h.exec(t, `INSERT INTO anime_character_voices (anime_id, character_id, staff_id, display_order, image_url)
			VALUES (20, 1000, 2000, 0, $1)`, pvPerson(800))
		var all []string
		for n := 0; n <= 9; n++ {
			all = append(all, pvCharacter(n), pvPerson(n))
		}
		h.warm(t, append(all, pvCover(20), pvCharacter(902), pvCharacter(909), pvPerson(903), pvPerson(800))...)

		var characters, voices []string
		for _, n := range []int{0, 1, 902, 3, 4, 5, 6, 7} {
			characters = append(characters, strings.TrimPrefix(pvCharacter(n), anilistCDNPrefix)+" character")
		}
		for _, n := range []int{0, 1, 2, 903, 4, 5, 6, 7} {
			voices = append(voices, strings.TrimPrefix(pvPerson(n), anilistCDNPrefix)+" voice")
		}
		want := append([]string{"media/anime/cover/large/bx20-pv.jpg cover"}, sorted(characters...)...)
		want = append(want, sorted(voices...)...)
		assert.Equal(t, want, h.list(t))

		rows, err := q.ListImageVariantWarmTargets(ctx, 2, variantWarmStaffShown)
		require.NoError(t, err)
		assert.Equal(t, []string{
			"media/anime/cover/large/bx20-pv.jpg cover",
			"character/medium/b0-pv.png character", "character/medium/b1-pv.png character",
			"staff/medium/n0-pv.png voice", "staff/medium/n1-pv.png voice",
		}, describeRows(rows), "the count is the argument, not a number in the SQL")
	})

	t.Run("the first ten staff by display_order and id, an edit's image first, each image once", func(t *testing.T) {
		h.reset(t)
		h.show(t, 30, 10, false, pvCover(30), nil)
		staff := []struct {
			order, id int
			role      string
			image     string
		}{
			{0, 3000, "Director", pvPerson(100)},
			{1, 3001, "Storyboard", pvPerson(101)},
			{2, 3001, "Episode Director", pvPerson(101)}, // one person, two roles: one image
			{3, 3003, "Music", pvPerson(103)},            // who also voices the character below
			{4, 3004, "Script", pvPerson(104)},
			{5, 3005, "Art Director", pvPerson(105)}, // edited, below
			{6, 3006, "Sound Director", pvPerson(106)},
			{7, 3007, "Original Creator", pvPerson(107)},
			{8, 3008, "Character Design", pvPerson(108)},
			{9, 3009, "Animation Director", pvPerson(109)},
			{10, 3010, "Producer", pvPerson(110)}, // the eleventh and twelfth: not shown
			{11, 3011, "Editing", pvPerson(111)},
		}
		var images []string
		for i := len(staff) - 1; i >= 0; i-- {
			s := staff[i]
			h.staff(t, 30, s.order, s.id, s.role, s.image)
			images = append(images, s.image)
		}
		h.overlay(t, "person", 3005, fmt.Sprintf(`{"image": %q}`, pvPerson(905)))
		h.character(t, 30, 0, "", 1300, 3003, pvCharacter(300), pvPerson(103))
		h.warm(t, append(images, pvCover(30), pvPerson(905), pvCharacter(300))...)

		want := []string{
			"media/anime/cover/large/bx30-pv.jpg cover",
			"character/medium/b300-pv.png character",
			"staff/medium/n103-pv.png staff,voice", // a voice before it is staff, so placed as one
		}
		var rest []string
		for _, n := range []int{100, 101, 104, 905, 106, 107, 108, 109} {
			rest = append(rest, strings.TrimPrefix(pvPerson(n), anilistCDNPrefix)+" staff")
		}
		assert.Equal(t, append(want, sorted(rest...)...), h.list(t))
	})

	t.Run("only originals the mirror holds, and only AniList's", func(t *testing.T) {
		h.reset(t)
		h.show(t, 40, 70, false, pvCover(40), nil)
		h.show(t, 41, 60, false, pvCover(41), nil)
		h.show(t, 42, 50, false, pvCover(42), nil)
		h.show(t, 43, 40, false, pvCover(43), nil)
		h.show(t, 44, 30, false, pvCover(44), nil)
		h.show(t, 45, 20, false, "https://example.com/cover/45.jpg", nil)
		h.show(t, 46, 10, false, "http://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx46-pv.jpg", nil)
		h.character(t, 40, 0, "", 1400, 2400, "https://lain.bgm.tv/pic/crt/l/ab/1400.jpg", "https://lain.bgm.tv/pic/crt/l/ab/2400.jpg")
		h.warm(t, pvCover(40), "https://example.com/cover/45.jpg",
			"http://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx46-pv.jpg",
			"https://lain.bgm.tv/pic/crt/l/ab/1400.jpg", "https://lain.bgm.tv/pic/crt/l/ab/2400.jpg")
		// A failed re-check keeps its warmed_at, and is still not held as far
		// as this job knows.  44 has no row: never asked about.
		h.exec(t, `INSERT INTO image_manager (url, status, warmed_at, next_attempt_at, attempts, failures, last_http_status) VALUES
			($1, 'missing',   NULL,                       now() + interval '30 days', 1, 0, 404),
			($2, 'failed',    now() - interval '40 days', now() + interval '1 hour',  2, 1, 503),
			($3, 'throttled', NULL,                       now() + interval '1 hour',  1, 0, 429)`,
			pvCover(41), pvCover(42), pvCover(43))

		assert.Equal(t, []string{"media/anime/cover/large/bx40-pv.jpg cover"}, h.list(t))
	})

	t.Run("an image several pages show is one row, placed by the most popular page that needs it", func(t *testing.T) {
		h.reset(t)
		h.show(t, 50, 10, false, pvCover(50), nil)
		h.show(t, 51, 20, false, pvCover(51), nil)
		h.show(t, 52, 5, false, pvCover(52), nil)
		h.recommendation(t, 51, 50, pvCover(50))
		h.relation(t, 52, 50, nil) // enriched to 50's cover
		h.warm(t, pvCover(50), pvCover(51), pvCover(52))

		assert.Equal(t, []string{
			"media/anime/cover/large/bx51-pv.jpg cover",
			"media/anime/cover/large/bx50-pv.jpg cover,recommended,related", // first needed as 51's recommendation
			"media/anime/cover/large/bx52-pv.jpg cover",
		}, h.list(t))
	})

	// One show with an image in every role, for the last two subtests.
	everyRole := func(t *testing.T) {
		h.reset(t)
		h.show(t, 60, 10, false, pvCover(60), pvBanner(60))
		h.relation(t, 60, 61, pvRelated(61))
		h.recommendation(t, 60, 62, pvRelated(62))
		h.character(t, 60, 0, "", 1600, 2600, pvCharacter(60), pvPerson(60))
		h.staff(t, 60, 0, 3600, "Director", pvPerson(61))
		h.warm(t, pvCover(60), pvBanner(60), pvRelated(61), pvRelated(62), pvCharacter(60), pvPerson(60), pvPerson(61))
	}

	t.Run("the query names every role the warm list has, and no other", func(t *testing.T) {
		everyRole(t)
		rows, err := q.ListImageVariantWarmTargets(ctx, variantWarmCharactersShown, variantWarmStaffShown)
		require.NoError(t, err)
		var roles []string
		for _, r := range rows {
			roles = append(roles, r.Roles...)
		}
		slices.Sort(roles)
		var want []string
		for role := range variantWarmList {
			want = append(want, role)
		}
		slices.Sort(want)
		assert.Equal(t, want, roles)
	})

	t.Run("a pass over the real list asks nginx for exactly the page's variants, in the list's order", func(t *testing.T) {
		everyRole(t)
		logs := captureImageWarmLogs(t)
		rows, err := q.ListImageVariantWarmTargets(ctx, variantWarmCharactersShown, variantWarmStaffShown)
		require.NoError(t, err)
		clock := newVariantClock(nightAvoiding(t, rows))
		stub := newVariantStub(t, clock, always(variantStubAnswer{status: 200, cacheStatus: "MISS"}))
		runVariantPass(t, newTestVariantWorker(q, clock))

		assert.Equal(t, []string{
			pvCover(60) + " 256", pvCover(60) + " 384", pvCover(60) + " 640",
			pvBanner(60) + " 1200", pvBanner(60) + " 1920",
			pvRelated(61) + " 256", pvRelated(61) + " 384",
			pvRelated(62) + " 256", pvRelated(62) + " 384",
			pvCharacter(60) + " 64", pvCharacter(60) + " 128",
			pvPerson(60) + " 64", pvPerson(60) + " 128",
			pvPerson(61) + " 64", pvPerson(61) + " 96",
		}, stub.asked())
		summary := variantSummary(t, logs)
		assert.EqualValues(t, 15, summary["filled"])
		assert.Equal(t, "done", summary["stopped"])
	})
}

// The test's AniList URLs, one maker per kind of image and size the
// database stores: a show's cover (AniList's large file), a related work's
// or a recommendation's (its medium one), a banner, and the two portraits.
func pvCover(n int) string     { return pvURL("media/anime/cover/large/bx%d-pv.jpg", n) }
func pvRelated(n int) string   { return pvURL("media/anime/cover/medium/bx%d-pv.jpg", n) }
func pvBanner(n int) string    { return pvURL("media/anime/banner/%d-pv.jpg", n) }
func pvCharacter(n int) string { return pvURL("character/medium/b%d-pv.png", n) }
func pvPerson(n int) string    { return pvURL("staff/medium/n%d-pv.png", n) }

func pvURL(pathFormat string, n int) string {
	return anilistCDNPrefix + fmt.Sprintf(pathFormat, n)
}

// sorted returns its arguments in order: within one show and role the
// query orders by URL.
func sorted(s ...string) []string {
	out := slices.Clone(s)
	slices.Sort(out)
	return out
}

// describeRows is each row as "<path> <roles>", in the query's order.
func describeRows(rows []dbgen.ListImageVariantWarmTargetsRow) []string {
	out := make([]string, 0, len(rows))
	for _, r := range rows {
		out = append(out, strings.TrimPrefix(r.Url, anilistCDNPrefix)+" "+strings.Join(r.Roles, ","))
	}
	return out
}

// variantPGHarness is the database side: imageWarmHarness's helpers, and
// the rows a page is built from.
type variantPGHarness struct {
	*imageWarmHarness
}

// reset empties every table the query reads.  anime_cache cascades to the
// relation, recommendation and credit tables; the overlays and
// image_manager are keyed by AniList id and URL, so nothing cascades into
// them.
func (h *variantPGHarness) reset(t *testing.T) {
	t.Helper()
	h.exec(t, `TRUNCATE anime_cache, entity_overlays, image_manager CASCADE`)
}

// list is the query's answer with the production arguments, described.
func (h *variantPGHarness) list(t *testing.T) []string {
	t.Helper()
	rows, err := h.q.ListImageVariantWarmTargets(h.ctx, variantWarmCharactersShown, variantWarmStaffShown)
	require.NoError(t, err)
	return describeRows(rows)
}

// show adds a title.  popularity, cover and banner may be nil.
func (h *variantPGHarness) show(t *testing.T, id int, popularity any, adult bool, cover, banner any) {
	t.Helper()
	h.exec(t, `INSERT INTO anime_cache (anilist_id, title_romaji, popularity, is_adult, cover_image_url, banner_image_url)
		VALUES ($1, 'title', $2, $3, $4, $5)`, id, popularity, adult, cover, banner)
}

func (h *variantPGHarness) relation(t *testing.T, showID, relatedID int, cover any) {
	t.Helper()
	h.exec(t, `INSERT INTO anime_relations (anime_id, anilist_id, relation_type, cover_image_url)
		VALUES ($1, $2, 'SEQUEL', $3)`, showID, relatedID, cover)
}

func (h *variantPGHarness) recommendation(t *testing.T, showID, recommendedID int, cover any) {
	t.Helper()
	h.exec(t, `INSERT INTO anime_recommendations (anime_id, anilist_id, cover_image_url) VALUES ($1, $2, $3)`,
		showID, recommendedID, cover)
}

// character adds a credit row; id "" lets the table pick the uuid.
func (h *variantPGHarness) character(t *testing.T, showID, order int, id string, characterID, voiceID int, image, voiceImage string) {
	t.Helper()
	h.exec(t, `INSERT INTO anime_characters
			(id, anime_id, display_order, character_id, voice_actor_id, image_url, voice_actor_image_url, role)
		VALUES (COALESCE(NULLIF($1::text, '')::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, 'MAIN')`,
		id, showID, order, characterID, voiceID, image, voiceImage)
}

func (h *variantPGHarness) staff(t *testing.T, showID, order, staffID int, role, image string) {
	t.Helper()
	h.exec(t, `INSERT INTO anime_staff (anime_id, display_order, staff_id, role, image_url) VALUES ($1, $2, $3, $4, $5)`,
		showID, order, staffID, role, image)
}

// overlay is an accepted reader edit (entity_overlays, 0047).
func (h *variantPGHarness) overlay(t *testing.T, kind string, entityID int, data string) {
	t.Helper()
	h.exec(t, `INSERT INTO entity_overlays (kind, entity_id, data) VALUES ($1, $2, $3::jsonb)`, kind, entityID, data)
}

// warm records each URL as held by the mirror; a URL named twice is one row.
func (h *variantPGHarness) warm(t *testing.T, urls ...string) {
	t.Helper()
	h.exec(t, `INSERT INTO image_manager (url, status, warmed_at, attempts, last_http_status)
		SELECT DISTINCT u, 'warmed', now(), 1, 200 FROM unnest($1::text[]) AS u`, urls)
}
