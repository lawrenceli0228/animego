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

// queryTimeout bounds one page's reads.  They are indexed lookups, four
// side by side and then up to two more; the budget is for contention, as in
// internal/anime.
const queryTimeout = 5 * time.Second

// PersonDB is what GET /api/people/:id reads.  *dbgen.Queries satisfies it.
type PersonDB interface {
	GetPersonIdentity(ctx context.Context, id int32) (dbgen.GetPersonIdentityRow, error)
	ListPersonVoiceRoles(ctx context.Context, staffID int32) ([]dbgen.ListPersonVoiceRolesRow, error)
	ListPersonStaffCredits(ctx context.Context, staffID int32) ([]dbgen.ListPersonStaffCreditsRow, error)
	OverlayDB
}

// CharacterDB is what GET /api/characters/:id reads.
type CharacterDB interface {
	GetCharacterIdentity(ctx context.Context, id int32) (dbgen.GetCharacterIdentityRow, error)
	ListCharacterAppearances(ctx context.Context, characterID int32) ([]dbgen.ListCharacterAppearancesRow, error)
	ListCharacterVoices(ctx context.Context, characterID int32) ([]dbgen.ListCharacterVoicesRow, error)
	OverlayDB
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

// LoadPerson builds one person's page as GET /api/people/:id answers it,
// accepted edits applied.  found is false for an id no non-adult credit
// names.  The submission handler (internal/edits) reads the same page, so
// what a submitter is shown as the old value is exactly what the page says.
//
// Two rounds: the credits, the profile, the match and the person's own
// edits side by side; then the edits of the characters the person voices,
// which only the first round can name.
func LoadPerson(ctx context.Context, db PersonDB, id int32) (*Person, bool, error) {
	var (
		ident  dbgen.GetPersonIdentityRow
		voices []dbgen.ListPersonVoiceRolesRow
		staff  []dbgen.ListPersonStaffCreditsRow
		own    []dbgen.ListEntityOverlaysRow
	)
	g, gctx := errgroup.WithContext(ctx)
	g.Go(func() (err error) { ident, err = db.GetPersonIdentity(gctx, id); return err })
	g.Go(func() (err error) { voices, err = db.ListPersonVoiceRoles(gctx, id); return err })
	g.Go(func() (err error) { staff, err = db.ListPersonStaffCredits(gctx, id); return err })
	g.Go(func() (err error) { own, err = db.ListEntityOverlays(gctx, []int32{id}, nil); return err })
	if err := g.Wait(); err != nil {
		return nil, false, err
	}
	if len(voices) == 0 && len(staff) == 0 {
		return nil, false, nil
	}

	people, _ := decodeOverlays(own)
	ov := pageOverlays{self: people[id]}
	if characterIDs := voicedCharacters(voices); len(characterIDs) > 0 {
		rows, err := db.ListEntityOverlays(ctx, nil, characterIDs)
		if err != nil {
			return nil, false, err
		}
		_, ov.characters = decodeOverlays(rows)
	}
	person, found := buildPerson(id, ident, voices, staff, ov)
	return person, found, nil
}

// LoadCharacter is LoadPerson for GET /api/characters/:id.  Its second
// round reads the edits of the people who voice the character and the
// names and portraits of anyone a voice edit added who is not among them.
func LoadCharacter(ctx context.Context, db CharacterDB, id int32) (*Character, bool, error) {
	var (
		ident       dbgen.GetCharacterIdentityRow
		appearances []dbgen.ListCharacterAppearancesRow
		voices      []dbgen.ListCharacterVoicesRow
		own         []dbgen.ListEntityOverlaysRow
	)
	g, gctx := errgroup.WithContext(ctx)
	g.Go(func() (err error) { ident, err = db.GetCharacterIdentity(gctx, id); return err })
	g.Go(func() (err error) { appearances, err = db.ListCharacterAppearances(gctx, id); return err })
	g.Go(func() (err error) { voices, err = db.ListCharacterVoices(gctx, id); return err })
	g.Go(func() (err error) { own, err = db.ListEntityOverlays(gctx, nil, []int32{id}); return err })
	if err := g.Wait(); err != nil {
		return nil, false, err
	}
	if len(appearances) == 0 {
		return nil, false, nil
	}

	_, characters := decodeOverlays(own)
	ov := pageOverlays{self: characters[id], refs: map[int32]PersonRef{}}
	all, uncredited := voicePeople(voices, ov.self)
	var (
		peopleRows []dbgen.ListEntityOverlaysRow
		refRows    []dbgen.ListPersonRefsRow
	)
	g, gctx = errgroup.WithContext(ctx)
	if len(all) > 0 {
		g.Go(func() (err error) { peopleRows, err = db.ListEntityOverlays(gctx, all, nil); return err })
	}
	if len(uncredited) > 0 {
		g.Go(func() (err error) { refRows, err = db.ListPersonRefs(gctx, uncredited); return err })
	}
	if err := g.Wait(); err != nil {
		return nil, false, err
	}
	ov.people, _ = decodeOverlays(peopleRows)
	for _, r := range refRows {
		ov.refs[r.AnilistID] = personRefFromRow(r)
	}
	character, found := buildCharacter(id, ident, appearances, voices, ov)
	return character, found, nil
}

// voicedCharacters is the distinct characters among a person's voice rows.
func voicedCharacters(rows []dbgen.ListPersonVoiceRolesRow) []int32 {
	seen := map[int32]bool{}
	out := []int32{}
	for _, r := range rows {
		if !seen[r.CharacterID] {
			seen[r.CharacterID] = true
			out = append(out, r.CharacterID)
		}
	}
	return out
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

		person, found, err := LoadPerson(ctx, db, id)
		if err != nil {
			httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "query failed"))
			return
		}
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

		character, found, err := LoadCharacter(ctx, db, id)
		if err != nil {
			httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "query failed"))
			return
		}
		if !found {
			httpx.Fail(w, httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, "character not found"))
			return
		}
		httpx.Data(w, http.StatusOK, character)
	}
}
