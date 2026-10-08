// credit_lists.go — the detail page's 角色 and 制作 tabs.
//
//	GET /api/anime/:anilistId/characters?role=&lang=&q=&offset=&limit=
//	GET /api/anime/:anilistId/staff
//	GET /api/anime/:anilistId/credit-counts
//
// /api/anime/:id carries the first 25 characters and staff, and must keep
// doing so: its consumers decode that shape.  The tabs list everything the
// credits sweep stores -- up to 400 of each -- so they read the tables
// through endpoints of their own.
//
// Read-only and local.  Nothing here calls AniList: a title we do not
// hold is a 404, never a fetch, so a crawler walking /anime/{n}/characters
// costs the database one primary-key read per id and the upstream budget
// nothing.  What a title holds is whatever the detail refresh and the
// credits sweep last wrote.
//
// A title's whole list is read once and kept in memory for
// creditListsTTL; filtering, counting and paging happen in Go over that
// copy (credit_lists_view.go).  These routes are public catalog reads, so
// the per-IP limiter waves them through (httpmw.isPublicReadExempt) on
// the understanding that a cache stands behind them -- here a reader
// typing into the search box, or anyone else varying the query string,
// re-reads the copy rather than the tables.
package anime

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"golang.org/x/sync/singleflight"

	"github.com/lawrenceli0228/animego/go-api/internal/cache"
	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/httpx"
)

const (
	// castDefaultLimit is a page of the card grid when the request names
	// none: twelve rows of two on a desktop.
	castDefaultLimit = 24
	// castMaxLimit bounds one page.  A title holds at most 400 characters,
	// so four requests read the longest list there is.
	castMaxLimit = 100
	// castMaxQueryRunes bounds the search box.  The longest name in the
	// tables is far shorter; a longer query is a mistake or a probe.
	castMaxQueryRunes = 64

	// creditListsTTL is how long a title's lists are served from memory.
	// The tables change when the detail refresh (at most daily) or the
	// credits sweep (at most monthly) writes them, and the pages that read
	// these endpoints are ISR-cached for 60s on top; ten minutes of staleness
	// is invisible and keeps a burst of searches off the database.
	creditListsTTL = 10 * time.Minute
	// creditListsCacheEntries caps how many titles each cache holds, by
	// entry rather than by byte (see cache.Config.IgnoreInternalCost).  The
	// largest cast -- 400 characters and their voices -- is about half a
	// megabyte, a typical one a tenth of that; 64 titles bounds the worst
	// case at tens of megabytes in a container with 512MB.
	creditListsCacheEntries = 64
)

// creditListsCacheControl is the public cache policy of the three
// endpoints: the one /api/anime/episodes uses for the same kind of
// answer, a catalogue fact that moves at the pace of a background sweep.
// Set on 200s only.
const creditListsCacheControl = episodeCountsCacheControl

// CreditListsDB is the sqlc subset the three endpoints read.
type CreditListsDB interface {
	GetAnimeCreditsHead(ctx context.Context, anilistID int32) (*string, error)
	ListAnimeCastCharacters(ctx context.Context, animeID int32) ([]dbgen.ListAnimeCastCharactersRow, error)
	ListAnimeCastVoices(ctx context.Context, animeID int32) ([]dbgen.ListAnimeCastVoicesRow, error)
	ListAnimeStaffCredits(ctx context.Context, animeID int32) ([]dbgen.ListAnimeStaffCreditsRow, error)
}

// CreditListsService serves the three endpoints from one pair of caches.
// Built once at startup (NewCreditListsService) and shared by every
// request.
type CreditListsService struct {
	db    CreditListsDB
	cast  *cache.Cache[*castList]
	staff *cache.Cache[*staffList]
	// loads collapses concurrent cold reads of one title's list into one,
	// the way DetailService.coldFetch does for AniList.
	loads     singleflight.Group
	closeOnce sync.Once
}

func creditListsCacheConfig() cache.Config {
	return cache.Config{
		NumCounters:        10 * creditListsCacheEntries,
		MaxCost:            creditListsCacheEntries,
		IgnoreInternalCost: true,
		DefaultTTL:         creditListsTTL,
	}
}

// NewCreditListsService builds the service and its two caches.  Returns
// an error only when ristretto rejects the configuration.
func NewCreditListsService(db CreditListsDB) (*CreditListsService, error) {
	castCache, err := cache.New[*castList](creditListsCacheConfig())
	if err != nil {
		return nil, fmt.Errorf("anime/credit-lists: build cast cache: %w", err)
	}
	staffCache, err := cache.New[*staffList](creditListsCacheConfig())
	if err != nil {
		castCache.Close()
		return nil, fmt.Errorf("anime/credit-lists: build staff cache: %w", err)
	}
	return &CreditListsService{db: db, cast: castCache, staff: staffCache}, nil
}

// Close releases the caches.  Safe to call more than once.
func (s *CreditListsService) Close() {
	s.closeOnce.Do(func() {
		s.cast.Close()
		s.staff.Close()
	})
}

// charactersResponse is GET /api/anime/:id/characters.
//
//	data      the page of characters, AniList's order, each with its voices
//	          in `language`
//	total     how many characters match role + q (the page is a slice of
//	          them)
//	offset    as asked (clamped at 0); limit as applied
//	hasMore   whether a later page has more of them
//	language  the dub the voices are in: the one asked for, else the
//	          title's (see defaultCastLang)
//	counts    roles: per role, over the characters matching q (any role);
//	          languages: characters with a voice in each language over the
//	          whole title, only those with any, in the order ja, zh, ko
type charactersResponse struct {
	Data     []castCharacter `json:"data"`
	Total    int             `json:"total"`
	Offset   int             `json:"offset"`
	Limit    int             `json:"limit"`
	HasMore  bool            `json:"hasMore"`
	Language string          `json:"language"`
	Counts   castCounts      `json:"counts"`
}

// staffResponse is GET /api/anime/:id/staff: every credit in AniList's
// order, how many credits that is, and how many people.
type staffResponse struct {
	Data   []staffCredit `json:"data"`
	Total  int           `json:"total"`
	People int           `json:"people"`
}

// creditCounts is GET /api/anime/:id/credit-counts' data: the numbers the
// tab bar and the overview's 「全部 N 位」 links show.  Staff counts people,
// not credits.
type creditCounts struct {
	Characters int `json:"characters"`
	Staff      int `json:"staff"`
}

// Characters implements GET /api/anime/:anilistId/characters.
//
// Query parameters (all optional):
//
//	role    main | supporting | background | all (any case)    else 400
//	lang    ja | zh | ko (any case)                             else 400
//	q       up to castMaxQueryRunes characters, matched against the
//	        character's names and the names of its voices in `lang`
//	        after bgmnames.Normalize                            else 400
//	offset  default 0; negative or unparseable reads as 0
//	limit   default castDefaultLimit, at most castMaxLimit
func (s *CreditListsService) Characters() http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		ctx, cancel := context.WithTimeout(req.Context(), queryTimeout)
		defer cancel()

		id, ok := creditListsID(w, req)
		if !ok {
			return
		}
		q, err := parseCastQuery(req.URL.Query())
		if err != nil {
			httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeValidationError, err.Error()))
			return
		}

		list, err := s.loadCast(ctx, id)
		if err != nil {
			writeCreditListsError(w, err)
			return
		}
		page := list.page(q)
		w.Header().Set("Cache-Control", creditListsCacheControl)
		writeMultiKeyEnvelope(w, http.StatusOK, charactersResponse{
			Data:     page.Data,
			Total:    page.Total,
			Offset:   page.Offset,
			Limit:    page.Limit,
			HasMore:  page.HasMore,
			Language: string(page.Language),
			Counts:   page.Counts,
		})
	}
}

// Staff implements GET /api/anime/:anilistId/staff.  No parameters: the
// tab groups the list by department and filters it as the reader types,
// so it takes the whole list (at most 400 credits) in one read.
func (s *CreditListsService) Staff() http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		ctx, cancel := context.WithTimeout(req.Context(), queryTimeout)
		defer cancel()

		id, ok := creditListsID(w, req)
		if !ok {
			return
		}
		list, err := s.loadStaff(ctx, id)
		if err != nil {
			writeCreditListsError(w, err)
			return
		}
		w.Header().Set("Cache-Control", creditListsCacheControl)
		writeMultiKeyEnvelope(w, http.StatusOK, staffResponse{
			Data:   list.credits,
			Total:  len(list.credits),
			People: list.people,
		})
	}
}

// Counts implements GET /api/anime/:anilistId/credit-counts:
//
//	{"data":{"characters":100,"staff":343}}
//
// Every detail tab shows both numbers in its tab bar, and the overview
// shows them in its 「全部 N 位」 links, so each page asks once rather than
// loading two lists for their lengths.  The numbers are read off the same
// cached lists the tabs page through, so a tab never disagrees with the
// count that led to it.
func (s *CreditListsService) Counts() http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		ctx, cancel := context.WithTimeout(req.Context(), queryTimeout)
		defer cancel()

		id, ok := creditListsID(w, req)
		if !ok {
			return
		}
		cast, err := s.loadCast(ctx, id)
		if err != nil {
			writeCreditListsError(w, err)
			return
		}
		staff, err := s.loadStaff(ctx, id)
		if err != nil {
			writeCreditListsError(w, err)
			return
		}
		w.Header().Set("Cache-Control", creditListsCacheControl)
		httpx.Data(w, http.StatusOK, creditCounts{Characters: len(cast.entries), Staff: staff.people})
	}
}

// creditListsID reads the path id, answering 400 itself when it is not
// a positive int32 -- the message /api/anime/:id gives.
func creditListsID(w http.ResponseWriter, req *http.Request) (int32, bool) {
	id, err := strconv.ParseInt(chi.URLParam(req, "anilistId"), 10, 32)
	if err != nil || id <= 0 {
		httpx.Fail(w, httpx.NewError(http.StatusBadRequest, httpx.CodeValidationError, "无效的番剧 ID"))
		return 0, false
	}
	return int32(id), true
}

// parseCastQuery validates the characters endpoint's query string.  The
// three filters are strict -- a value the tab never sends is a client
// bug, and answering it with the unfiltered list would hide that -- while
// offset and limit clamp, as every other list endpoint here does.
func parseCastQuery(qs map[string][]string) (castQuery, error) {
	get := func(k string) string {
		if v, ok := qs[k]; ok && len(v) > 0 {
			return strings.TrimSpace(v[0])
		}
		return ""
	}

	var q castQuery
	switch role := strings.ToUpper(get("role")); role {
	case "", "ALL":
	case castRoleMain, castRoleSupporting, castRoleBackground:
		q.role = role
	default:
		return castQuery{}, errors.New("role must be one of main, supporting, background")
	}

	if raw := get("lang"); raw != "" {
		lang, ok := parseCastLang(raw)
		if !ok {
			return castQuery{}, errors.New("lang must be one of ja, zh, ko")
		}
		q.lang = lang
	}

	search := get("q")
	if utf8.RuneCountInString(search) > castMaxQueryRunes {
		return castQuery{}, fmt.Errorf("q is longer than %d characters", castMaxQueryRunes)
	}
	q.needle = normalizeCastNeedle(search)

	q.offset = max(parseIntDefault(get("offset"), 0), 0)
	q.limit = parseLimit(get("limit"), castDefaultLimit, castMaxLimit)
	return q, nil
}

// loadCast returns the title's cast from memory, or reads it.
func (s *CreditListsService) loadCast(ctx context.Context, id int32) (*castList, error) {
	key := strconv.FormatInt(int64(id), 10)
	if hit, ok := s.cast.Get(key); ok && hit != nil {
		return hit, nil
	}
	v, err := s.shared(ctx, "cast:"+key, func(lctx context.Context) (any, error) {
		country, err := s.head(lctx, id)
		if err != nil {
			return nil, err
		}
		chars, err := s.db.ListAnimeCastCharacters(lctx, id)
		if err != nil {
			return nil, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "query failed")
		}
		voices, err := s.db.ListAnimeCastVoices(lctx, id)
		if err != nil {
			return nil, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "query failed")
		}
		list := buildCastList(country, chars, voices)
		if !s.cast.Set(key, list) {
			slog.Debug("anime/credit-lists: cast cache set rejected", "anilistId", id)
		}
		return list, nil
	})
	if err != nil {
		return nil, err
	}
	return v.(*castList), nil
}

// loadStaff returns the title's staff from memory, or reads it.
func (s *CreditListsService) loadStaff(ctx context.Context, id int32) (*staffList, error) {
	key := strconv.FormatInt(int64(id), 10)
	if hit, ok := s.staff.Get(key); ok && hit != nil {
		return hit, nil
	}
	v, err := s.shared(ctx, "staff:"+key, func(lctx context.Context) (any, error) {
		if _, err := s.head(lctx, id); err != nil {
			return nil, err
		}
		rows, err := s.db.ListAnimeStaffCredits(lctx, id)
		if err != nil {
			return nil, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "query failed")
		}
		list := buildStaffList(rows)
		if !s.staff.Set(key, list) {
			slog.Debug("anime/credit-lists: staff cache set rejected", "anilistId", id)
		}
		return list, nil
	})
	if err != nil {
		return nil, err
	}
	return v.(*staffList), nil
}

// head is the existence check every load starts with: the title's row,
// or the 404 /api/anime/:id gives for an id we do not hold.  Only a hit
// is ever cached (inside the list it was read for), so a title that
// appears later is listed as soon as it does.
func (s *CreditListsService) head(ctx context.Context, id int32) (*string, error) {
	country, err := s.db.GetAnimeCreditsHead(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errAnimeNotFound()
	}
	if err != nil {
		return nil, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "query failed")
	}
	return country, nil
}

// shared runs load once for every concurrent caller of the same key.
//
// The load runs on a context detached from any one caller, with its own
// queryTimeout, so the request that happened to start it disconnecting
// does not fail the others; each caller still stops waiting at its own
// deadline.  DoChan runs load on a goroutine of its own, where
// httpmw.Recoverer cannot reach a panic, hence the recover.
func (s *CreditListsService) shared(ctx context.Context, key string, load func(context.Context) (any, error)) (any, error) {
	ch := s.loads.DoChan(key, func() (val any, err error) {
		defer func() {
			if rec := recover(); rec != nil {
				slog.ErrorContext(ctx, "anime/credit-lists: load panic",
					"key", key, "panic", rec, "stack", string(debug.Stack()))
				val, err = nil, httpx.NewError(http.StatusInternalServerError, httpx.CodeServerError, "Internal Server Error")
			}
		}()
		lctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), queryTimeout)
		defer cancel()
		return load(lctx)
	})
	select {
	case res := <-ch:
		return res.Val, res.Err
	case <-ctx.Done():
		return nil, httpx.WrapError(ctx.Err(), http.StatusInternalServerError, httpx.CodeServerError, "query failed")
	}
}

func writeCreditListsError(w http.ResponseWriter, err error) {
	if apiErr, ok := httpx.IsAPIError(err); ok {
		httpx.Fail(w, apiErr)
		return
	}
	httpx.Fail(w, httpx.WrapError(err, http.StatusInternalServerError, httpx.CodeServerError, "internal error"))
}
