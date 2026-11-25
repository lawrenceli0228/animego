// Package dandanplay — the dandanplay-search step of POST /api/dandanplay/match.
//
// It runs after Phase 2 (anime_cache keyword search) misses and before
// Phase 3.  The keyword it serves is one neither earlier phase can use: a
// release group's own name for a show.  Judas names its files
// "[Judas] Nama-Anaru - S01E08.mkv" for 生徒会にも穴はある！ and
// "Kanotomo" for Kanojo no Tomodachi; when the hash is not indexed yet,
// Phase 1 cannot place the file, and anime_cache has no such title.
// dandanplay's own search does know these names.
//
// The step only answers when the answer is unambiguous: the candidates of
// the requested season must all lead to ONE AniList entry, found through
// dandanplay's published cross-link (resolveSiteAnime), not through a title
// guess.  A short name like "Tensei shita" brings back a different show's
// TV series and OVA — two entries, so no answer.  An empty answer leaves
// the file for the library's own unmatched flow; a wrong one binds a card
// to the wrong show.

package dandanplay

import (
	"context"
	"errors"
	"log/slog"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/titlematch"
)

// maxSearchCandidates bounds how many season-matching search results are
// examined (one episodes fetch each).  More than this is a generic name,
// and generic names are not what this step is for.
const maxSearchCandidates = 3

// seasonWordsRe matches a trailing season phrase the library client
// appends to its keyword ("… Season 3") or that a title carries
// ("… 2nd Season", "… 第二季").  dandanplay's search wants the bare title;
// the season is applied afterwards as a gate on the candidates.
var seasonWordsRe = regexp.MustCompile(
	`(?i)\s+(?:season\s*[0-9]+|[0-9]+(?:st|nd|rd|th)\s*season|第\s*(?:[0-9]+|[一二三四五六七八九十]+)\s*[季期])\s*$`,
)

// stripSeasonWords removes one trailing season phrase.  A title that is
// only a season phrase is returned as is.
func stripSeasonWords(keyword string) string {
	k := strings.TrimSpace(keyword)
	bare := strings.TrimSpace(seasonWordsRe.ReplaceAllString(k, ""))
	if bare == "" {
		return k
	}
	return bare
}

// tryDandanSearch resolves req.Keyword through dandanplay's search.
// Returns (resp, true) only for a single AniList entry; see the file doc.
func (h *Handlers) tryDandanSearch(ctx context.Context, req *MatchRequest) (matchResponse, bool) {
	query, _ := splitTrailingYear(stripSeasonWords(req.Keyword))
	if query == "" {
		return matchResponse{}, false
	}
	want := titlematch.ExtractMarker(req.Keyword)

	found, err := h.Client.SearchAnime(ctx, query)
	if err != nil {
		slog.DebugContext(ctx, "dandanplay search-step search error", "err", err, "keyword", query)
		return matchResponse{}, false
	}
	var candidates []DandanAnime
	for _, c := range found {
		if titlematch.ExtractMarker(c.Title).SameEntry(want) {
			candidates = append(candidates, c)
		}
	}
	if len(candidates) == 0 || len(candidates) > maxSearchCandidates {
		return matchResponse{}, false
	}

	// Place EVERY candidate before choosing.  One that fails to load or has
	// no cross-link could be the right answer (a new show dandanplay has not
	// linked yet); skipping it would leave a wrong one standing alone.
	placed := make([]placedCandidate, 0, len(candidates))
	for _, c := range candidates {
		epData, err := h.Client.FetchEpisodesByDandanAnimeID(ctx, c.DandanAnimeID)
		if err != nil || epData == nil {
			if err != nil {
				slog.DebugContext(ctx, "dandanplay search-step episodes fetch error",
					"err", err, "animeId", c.DandanAnimeID)
			}
			return matchResponse{}, false
		}
		entry := h.resolveLinkedEntry(ctx, epData)
		if entry.anilistID == 0 {
			return matchResponse{}, false
		}
		if len(placed) > 0 && entry.anilistID != placed[0].entry.anilistID {
			// Two entries answer to this name: ambiguous, no answer.
			return matchResponse{}, false
		}
		placed = append(placed, placedCandidate{epData: epData, entry: entry})
	}

	var (
		chosenRow  candidateEntry
		episodeMap map[int]EpisodeMapEntry
	)
	for _, p := range placed {
		m := BuildEpisodeMap(p.epData.Episodes, req.Episodes)
		h.matchUnmappedFiles(ctx, m, req.Episodes, req.Files)
		if len(m) > 0 {
			chosenRow, episodeMap = p.entry, m
			break
		}
	}
	if episodeMap == nil {
		return matchResponse{}, false
	}

	r := chosenRow.row
	return matchResponse{
		Matched: true,
		Anime: phase2Anime{
			AnilistID:     r.AnilistID,
			TitleChinese:  r.TitleChinese,
			TitleNative:   r.TitleNative,
			TitleRomaji:   r.TitleRomaji,
			CoverImageUrl: r.CoverImageUrl,
			Episodes:      r.Episodes,
		},
		SiteAnime:  h.pickSiteAnime(ctx, r),
		EpisodeMap: episodeMap,
		Source:     "dandanplaySearch",
	}, true
}

// placedCandidate is a search candidate with its episodes and the entry
// its cross-link names.
type placedCandidate struct {
	epData *EpisodeData
	entry  candidateEntry
}

// candidateEntry is the anime_cache row a search candidate links to.
type candidateEntry struct {
	anilistID int32
	row       *dbgen.SearchAnimeCacheForDandanplayRow
}

// resolveLinkedEntry places a candidate by dandanplay's published
// cross-links only: AniList id, then bgm.tv id.  Unlike resolveSiteAnime it
// never falls back to a title search — the title in hand is a nickname, so
// a title search would prove nothing.
func (h *Handlers) resolveLinkedEntry(ctx context.Context, epData *EpisodeData) candidateEntry {
	if epData.AniListID != 0 {
		row, err := h.DB.GetAnimeByAnilistIDForDandanplay(ctx, epData.AniListID)
		if err == nil {
			return candidateEntry{anilistID: row.AnilistID, row: rowFromAnilistRow(row)}
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			slog.WarnContext(ctx, "dandanplay search-step anilist lookup error",
				"err", err, "anilistId", epData.AniListID)
		}
	}
	if epData.BgmID != 0 {
		bgmID := epData.BgmID
		row, err := h.DB.GetAnimeByBgmID(ctx, &bgmID)
		if err == nil {
			r := rowFromBgmRow(row)
			return candidateEntry{anilistID: r.AnilistID, row: r}
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			slog.WarnContext(ctx, "dandanplay search-step bgm lookup error",
				"err", err, "bgmId", bgmID)
		}
	}
	return candidateEntry{}
}
