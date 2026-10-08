package people

import (
	"context"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"golang.org/x/sync/errgroup"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/httpx"
)

// queryTimeout bounds one page's reads.  They are three indexed lookups
// run side by side; the budget is for contention, as in internal/anime.
const queryTimeout = 5 * time.Second

// PersonDB is what GET /api/people/:id reads.  *dbgen.Queries satisfies it.
type PersonDB interface {
	GetPersonIdentity(ctx context.Context, id int32) (dbgen.GetPersonIdentityRow, error)
	ListPersonVoiceRoles(ctx context.Context, staffID int32) ([]dbgen.ListPersonVoiceRolesRow, error)
	ListPersonStaffCredits(ctx context.Context, staffID int32) ([]dbgen.ListPersonStaffCreditsRow, error)
}

// CharacterDB is what GET /api/characters/:id reads.
type CharacterDB interface {
	GetCharacterIdentity(ctx context.Context, id int32) (dbgen.GetCharacterIdentityRow, error)
	ListCharacterAppearances(ctx context.Context, characterID int32) ([]dbgen.ListCharacterAppearancesRow, error)
	ListCharacterVoices(ctx context.Context, characterID int32) ([]dbgen.ListCharacterVoicesRow, error)
}

// SitemapDB is what the two sitemap listings read.
type SitemapDB interface {
	ListPeopleSitemapShard(ctx context.Context, minVoiceWorks, minStaffWorks, shardCount, shardIndex int32) ([]dbgen.ListPeopleSitemapShardRow, error)
	ListCharactersSitemapShard(ctx context.Context, shardCount, shardIndex int32) ([]dbgen.ListCharactersSitemapShardRow, error)
}

// DB is everything this package reads.
type DB interface {
	PersonDB
	CharacterDB
	SitemapDB
}

// MountPeople registers /api/people's routes on r: the sitemap listing and
// the page.  chi resolves the literal /sitemap before the /{id} pattern
// whatever the order (TestRoutes_SitemapIsNotAnID).
func MountPeople(r chi.Router, db DB, cache *SitemapCache) {
	r.Get("/sitemap", PeopleSitemap(db, cache))
	r.Get("/{id}", PersonHandler(db))
}

// MountCharacters registers /api/characters's routes on r.
func MountCharacters(r chi.Router, db DB, cache *SitemapCache) {
	r.Get("/sitemap", CharactersSitemap(db, cache))
	r.Get("/{id}", CharacterHandler(db))
}

// parseID reads a path id: a positive integer that fits an int32, which is
// every AniList id and the column type.
func parseID(raw string) (int32, bool) {
	id, err := strconv.ParseInt(raw, 10, 32)
	if err != nil || id <= 0 {
		return 0, false
	}
	return int32(id), true
}

// PersonHandler implements GET /api/people/:id — one AniList Staff id, voice
// actor or production staff.
//
// 400 for an id that is not a positive integer, 404 for one no non-adult
// credit names (a profile row alone does not make a page), else 200 with
// {"data": Person}.  See dto.go for the shape.
func PersonHandler(db PersonDB) http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		id, ok := parseID(chi.URLParam(req, "id"))
		if !ok {
			httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeValidationError, "invalid person id"))
			return
		}
		ctx, cancel := context.WithTimeout(req.Context(), queryTimeout)
		defer cancel()

		var (
			ident  dbgen.GetPersonIdentityRow
			voices []dbgen.ListPersonVoiceRolesRow
			staff  []dbgen.ListPersonStaffCreditsRow
		)
		g, gctx := errgroup.WithContext(ctx)
		g.Go(func() (err error) { ident, err = db.GetPersonIdentity(gctx, id); return err })
		g.Go(func() (err error) { voices, err = db.ListPersonVoiceRoles(gctx, id); return err })
		g.Go(func() (err error) { staff, err = db.ListPersonStaffCredits(gctx, id); return err })
		if err := g.Wait(); err != nil {
			httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "query failed"))
			return
		}

		person, found := buildPerson(id, ident, voices, staff)
		if !found {
			httpx.Fail(w, httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, "person not found"))
			return
		}
		httpx.Data(w, http.StatusOK, person)
	}
}

// CharacterHandler implements GET /api/characters/:id — one AniList
// Character id.  Status codes as PersonHandler's: 404 when no non-adult
// title lists the character.
func CharacterHandler(db CharacterDB) http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		id, ok := parseID(chi.URLParam(req, "id"))
		if !ok {
			httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeValidationError, "invalid character id"))
			return
		}
		ctx, cancel := context.WithTimeout(req.Context(), queryTimeout)
		defer cancel()

		var (
			ident       dbgen.GetCharacterIdentityRow
			appearances []dbgen.ListCharacterAppearancesRow
			voices      []dbgen.ListCharacterVoicesRow
		)
		g, gctx := errgroup.WithContext(ctx)
		g.Go(func() (err error) { ident, err = db.GetCharacterIdentity(gctx, id); return err })
		g.Go(func() (err error) { appearances, err = db.ListCharacterAppearances(gctx, id); return err })
		g.Go(func() (err error) { voices, err = db.ListCharacterVoices(gctx, id); return err })
		if err := g.Wait(); err != nil {
			httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "query failed"))
			return
		}

		character, found := buildCharacter(id, ident, appearances, voices)
		if !found {
			httpx.Fail(w, httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, "character not found"))
			return
		}
		httpx.Data(w, http.StatusOK, character)
	}
}
