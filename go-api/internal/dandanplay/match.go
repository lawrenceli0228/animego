// Package dandanplay — POST /api/dandanplay/match handler.
//
// 3-phase orchestration ported verbatim from
// server/controllers/dandanplay.controller.js (the `match` function,
// lines 74-155).  Phases run sequentially — the first one to produce a
// non-empty episodeMap wins:
//
//	Phase 1 — dandanplay /api/v2/match (hash + filename), with the
//	          loose-match accept gate that salvages new-season fansub
//	          releases whose hashes aren't indexed yet.
//	Phase 2 — AnimeCache keyword search → per-candidate Bangumi
//	          episodes fetch.  First candidate with a non-empty
//	          episodeMap wins.
//	        — then dandanplay's own search, for release-group names
//	          anime_cache does not carry (search_match.go).  Answers only
//	          when every candidate of the requested season links to one
//	          AniList entry.
//	Phase 3 — per-file matching with no anime context (last-ditch
//	          fallback when neither dandanplay nor AnimeCache had a
//	          hit).  Stricter accept gate — only isMatched=true rows.
//
// All three phases share the matchUnmappedFiles helper for the
// per-episode hash fallback inside the phase's episodeMap.  The entire
// handler is wrapped in context.WithTimeout(20s) so a runaway match
// doesn't stall the HTTP connection.

package dandanplay

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
	"github.com/lawrenceli0228/animego/go-api/internal/titlematch"
)

// MatchRequest is the JSON body POST /api/dandanplay/match accepts.
// All fields are optional — the orchestration short-circuits whichever
// phases lack input.  Files carries per-episode hash info for the
// matchUnmappedFiles fallback.
type MatchRequest struct {
	Keyword  string          `json:"keyword,omitempty"`
	Episodes []int           `json:"episodes,omitempty"`
	FileName string          `json:"fileName,omitempty"`
	FileHash string          `json:"fileHash,omitempty"`
	FileSize int64           `json:"fileSize,omitempty"`
	Files    []MatchFileInfo `json:"files,omitempty"`
}

// MatchFileInfo is one entry in MatchRequest.Files — the per-episode
// hash/size pair used by matchUnmappedFiles.
type MatchFileInfo struct {
	Episode  int    `json:"episode"`
	FileName string `json:"fileName"`
	FileHash string `json:"fileHash"`
	FileSize int64  `json:"fileSize"`
}

// matchResponse is the top-level envelope /match emits.  Field order
// matches Express byte-for-byte (matched, anime, siteAnime,
// episodeMap, source).  All nullable fields are pointers so JSON null
// is faithful.
//
// Two response shapes share this struct:
//   - Total miss → {matched:false}.  The other fields omit via
//     pointers (nil = `null`) but Express only emitted `matched:false`,
//     so on miss we use missResponse instead.
//   - Hit → all fields populated to the phase's projection.
type matchResponse struct {
	Matched    bool                       `json:"matched"`
	Anime      any                        `json:"anime"`
	SiteAnime  *siteAnimePayload          `json:"siteAnime"`
	EpisodeMap map[int]EpisodeMapEntry    `json:"episodeMap"`
	Source     string                     `json:"source"`
}

// missResponse is the dedicated total-miss envelope.  Express's final
// fallback was `res.json({matched:false})` — a single field, no nulls
// for the rest.  Using a separate struct preserves the exact byte
// output for the most common cold-start case.
type missResponse struct {
	Matched bool `json:"matched"`
}

// phase1Anime is the projection /match emits in the Phase 1 response.
// Only two fields — titleNative + coverImageUrl — because that's all
// Express returned in the Phase 1 branch (server lines 95-101).  Other
// phases use different shapes (phase2 returns 6 cache fields;
// phase3 returns `{}` literally).
type phase1Anime struct {
	TitleNative   string `json:"titleNative"`
	CoverImageUrl string `json:"coverImageUrl"`
}

// phase2Anime is the projection /match emits in the Phase 2 response.
// Six fields lifted from the matched cache row — matches Express
// server lines 120-126.  All nullable to round-trip pgtype NULLs.
type phase2Anime struct {
	AnilistID     int32   `json:"anilistId"`
	TitleChinese  *string `json:"titleChinese"`
	TitleNative   *string `json:"titleNative"`
	TitleRomaji   *string `json:"titleRomaji"`
	CoverImageUrl *string `json:"coverImageUrl"`
	Episodes      *int32  `json:"episodes"`
}

// Match implements POST /api/dandanplay/match.  3-phase orchestration —
// see package doc.  Returns the matched envelope on first hit; falls
// through to `{matched:false}` after all three phases miss.
//
// The handler-level context.WithTimeout(20s) is enforced here (NOT in
// middleware) so the cap sits next to the orchestration code and shows
// up in a code-review grep for "Match".  On timeout the handler emits
// a 500 bare-error envelope and slog.WarnContext for ops visibility.
func (h *Handlers) Match(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), matchTimeout)
	defer cancel()

	var req MatchRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		// Empty / invalid body — emit total miss instead of an error,
		// matching Express's behaviour where an empty body would
		// destructure to all-undefined and the function would still
		// run through to the final `{matched:false}`.
		writeJSON(w, http.StatusOK, missResponse{Matched: false})
		return
	}

	// Phase 1: dandanplay combined match (hash + filename).
	if req.FileName != "" {
		if resp, ok := h.tryPhase1(ctx, &req); ok {
			writeJSON(w, http.StatusOK, resp)
			return
		}
	}

	// Phase 2: AnimeCache search.
	if req.Keyword != "" {
		if resp, ok := h.tryPhase2(ctx, &req); ok {
			writeJSON(w, http.StatusOK, resp)
			return
		}
		// A release group's own name for the show, which anime_cache
		// does not carry but dandanplay's search does (search_match.go).
		if resp, ok := h.tryDandanSearch(ctx, &req); ok {
			writeJSON(w, http.StatusOK, resp)
			return
		}
	}

	// Phase 3: per-file matching with no anime context.
	if len(req.Files) > 0 {
		if resp, ok := h.tryPhase3(ctx, &req); ok {
			writeJSON(w, http.StatusOK, resp)
			return
		}
	}

	// Timeout while running phases — surface 500 so ops sees the
	// runaway.  Express never had this branch because Node's event
	// loop happily blocked HTTP connections forever; the Go cap makes
	// the failure mode explicit.
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		slog.WarnContext(ctx, "dandanplay /match timeout",
			"keyword", req.Keyword,
			"fileName", req.FileName,
			"episodes", req.Episodes)
		writeBareErrorJSON(w, http.StatusInternalServerError, "match timed out")
		return
	}

	// All three phases ran without producing a hit.
	writeJSON(w, http.StatusOK, missResponse{Matched: false})
}

// tryPhase1 runs the Phase 1 orchestration.  Returns (resp, true) on
// hit, (zero, false) on miss / error.  Errors are swallowed (matches
// Express's silent fall-through to Phase 2).
//
// The loose-match accept gate salvages candidates whose hash isn't in
// dandanplay's index yet but whose title obviously matches the user's
// keyword — common for new-season fansub releases.
func (h *Handlers) tryPhase1(ctx context.Context, req *MatchRequest) (matchResponse, bool) {
	combined, err := h.Client.MatchCombined(ctx, req.FileName, req.FileHash, req.FileSize)
	if err != nil {
		slog.DebugContext(ctx, "dandanplay phase1 match error",
			"err", err, "fileName", req.FileName)
		return matchResponse{}, false
	}
	accept := combined != nil && (combined.IsMatched || looselyAccepted(combined, req.Keyword))
	if !accept {
		return matchResponse{}, false
	}

	epData, err := h.Client.FetchEpisodesByDandanAnimeID(ctx, combined.AnimeID)
	if err != nil || epData == nil {
		if err != nil {
			slog.DebugContext(ctx, "dandanplay phase1 episodes fetch error",
				"err", err, "animeId", combined.AnimeID)
		}
		return matchResponse{}, false
	}

	episodeMap := BuildEpisodeMap(epData.Episodes, req.Episodes)
	h.matchUnmappedFiles(ctx, episodeMap, req.Episodes, req.Files)
	if len(episodeMap) == 0 {
		return matchResponse{}, false
	}

	// Best-effort siteAnime enrichment — never block on it.  Errors
	// inside resolveSiteAnime are already swallowed; pickSiteAnime
	// returns nil for nil input.
	siteHit := h.resolveSiteAnime(ctx, epData, req.Keyword)
	siteAnime := h.pickSiteAnime(ctx, siteHit)

	return matchResponse{
		Matched: true,
		Anime: phase1Anime{
			TitleNative:   epData.Title,
			CoverImageUrl: epData.ImageURL,
		},
		SiteAnime:  siteAnime,
		EpisodeMap: episodeMap,
		Source:     "dandanplay",
	}, true
}

// looselyAccepted is Phase 1's salvage for a hash dandanplay has not
// indexed: its guess counts when the title loosely matches the keyword AND
// names the same season.  Containment alone cannot see seasons when one
// title runs into the other ("我推的孩子 第二季" contains "我推的孩子").
func looselyAccepted(combined *MatchResult, keyword string) bool {
	if combined.AnimeID == 0 || !TitleLooselyMatchesKeyword(combined.AnimeTitle, keyword) {
		return false
	}
	return titlematch.ExtractMarker(combined.AnimeTitle).SameEntry(titlematch.ExtractMarker(keyword))
}

// tryPhase2 runs the AnimeCache keyword search and answers with the one
// entry the keyword names, or not at all.
//
// It used to walk the ranked rows and take the first whose episodes
// resolved.  For a folder keyword that was usually right, but /match now
// gets a keyword for every library import whose hash dandanplay has not
// indexed, and a release group's short name can fit several shows: on the
// live catalogue Judas's "Tensei shita" (Tensei Shita Daiseijo wa…) went
// to Tensei Shitara Ken Deshita, the highest-scoring of three.  The library
// writes the answer as a lasting binding, so an ambiguous keyword is a miss
// (the dandanplay search step and the library's unmatched flow come next).
func (h *Handlers) tryPhase2(ctx context.Context, req *MatchRequest) (matchResponse, bool) {
	keyword, year := splitTrailingYear(req.Keyword)
	cacheRows, err := h.searchAnimeCache(ctx, keyword)
	if err != nil {
		slog.WarnContext(ctx, "dandanplay phase2 cache search error",
			"err", err, "keyword", req.Keyword)
		return matchResponse{}, false
	}
	// rankCacheRows drops rows whose season/part contradicts the keyword
	// or whose titles do not match it, and orders the rest by similarity.
	row, ok := soleAnswer(rankCacheRows(preferYear(cacheRows, year), keyword), keyword)
	if !ok || row.BgmID == nil {
		return matchResponse{}, false
	}
	epData, err := h.Client.FetchEpisodesByBgmID(ctx, *row.BgmID)
	if err != nil {
		slog.DebugContext(ctx, "dandanplay phase2 episodes fetch error",
			"err", err, "bgmId", *row.BgmID)
		return matchResponse{}, false
	}
	if epData == nil {
		return matchResponse{}, false
	}
	episodeMap := BuildEpisodeMap(epData.Episodes, req.Episodes)
	h.matchUnmappedFiles(ctx, episodeMap, req.Episodes, req.Files)
	if len(episodeMap) == 0 {
		return matchResponse{}, false
	}
	// Phase 2 hit — project the cache row twice: once into the shallow
	// `anime` envelope and once into the full `siteAnime` (Express did the
	// same; siteAnime gets the genres+studios enrichment, anime stays light).
	siteAnime := h.pickSiteAnime(ctx, &row)
	return matchResponse{
		Matched: true,
		Anime: phase2Anime{
			AnilistID:     row.AnilistID,
			TitleChinese:  row.TitleChinese,
			TitleNative:   row.TitleNative,
			TitleRomaji:   row.TitleRomaji,
			CoverImageUrl: row.CoverImageUrl,
			Episodes:      row.Episodes,
		},
		SiteAnime:  siteAnime,
		EpisodeMap: episodeMap,
		Source:     "animeCache",
	}, true
}

// soleAnswer picks the entry a keyword names among rows that already
// cleared rankCacheRows: the only one, or — when several do — the only one
// with a title equal to the keyword ("Sousou no Frieren" over "Sousou no
// Frieren: Marumaru no Mahou").  Anything else is ambiguous.
func soleAnswer(rows []dbgen.SearchAnimeCacheForDandanplayRow, keyword string) (dbgen.SearchAnimeCacheForDandanplayRow, bool) {
	switch len(rows) {
	case 0:
		return dbgen.SearchAnimeCacheForDandanplayRow{}, false
	case 1:
		return rows[0], true
	}
	want := titlematch.LooseNormalize(keyword)
	exact := -1
	for i := range rows {
		for _, t := range cacheRowTitles(&rows[i]) {
			if titlematch.LooseNormalize(t) != want {
				continue
			}
			if exact >= 0 {
				return dbgen.SearchAnimeCacheForDandanplayRow{}, false
			}
			exact = i
			break
		}
	}
	if exact < 0 {
		return dbgen.SearchAnimeCacheForDandanplayRow{}, false
	}
	return rows[exact], true
}

// tryPhase3 is the per-file hash-only fallback when neither Phase 1
// nor Phase 2 produced a match.  matchUnmappedFiles uses the stricter
// accept gate (isMatched=true only) — Phase 1's loose-match relaxation
// would falsely accept arbitrary returns when there's no anime context
// to ground the title comparison against.
//
// On hit, the response shape is special — `anime: {}` (literal empty
// object), no siteAnime.  Matches Express server lines 141-147.
func (h *Handlers) tryPhase3(ctx context.Context, req *MatchRequest) (matchResponse, bool) {
	episodeMap := make(map[int]EpisodeMapEntry)
	h.matchUnmappedFiles(ctx, episodeMap, req.Episodes, req.Files)
	if len(episodeMap) == 0 {
		return matchResponse{}, false
	}
	return matchResponse{
		Matched:    true,
		Anime:      struct{}{}, // emits `{}` literally
		SiteAnime:  nil,        // emits `null`
		EpisodeMap: episodeMap,
		Source:     "dandanplay",
	}, true
}

// matchUnmappedFiles is the per-file fallback used inside every phase.
// Picks the requested episode numbers that don't yet have an entry in
// episodeMap, finds the matching MatchFileInfo, and calls
// MatchCombined.  On isMatched=true (NEVER the loose-match relaxation
// — Phase 1's gate doesn't apply here) the entry is added.
//
// usedIds tracks the dandanplay episodeIds we've already mapped so
// the same episode doesn't get assigned twice (Express used a Set in
// the JS port).
//
// Errors are swallowed — a per-file failure shouldn't unwind the
// phase.  matchCombined per-call latency is bounded by the client's
// 8s HTTP timeout.
func (h *Handlers) matchUnmappedFiles(ctx context.Context, episodeMap map[int]EpisodeMapEntry, episodes []int, files []MatchFileInfo) {
	if len(episodes) == 0 || len(files) == 0 {
		return
	}
	usedIDs := make(map[int64]struct{}, len(episodeMap))
	for _, e := range episodeMap {
		usedIDs[e.DandanEpisodeID] = struct{}{}
	}
	for _, ep := range episodes {
		if _, done := episodeMap[ep]; done {
			continue
		}
		// Find the matching file info by episode.  Express used
		// Array.prototype.find — linear scan, O(n*m).  At expected
		// list sizes (n,m ≤ 24) the constant cost is in the µs range.
		var info *MatchFileInfo
		for i := range files {
			if files[i].Episode == ep {
				info = &files[i]
				break
			}
		}
		if info == nil || info.FileName == "" {
			continue
		}
		result, err := h.Client.MatchCombined(ctx, info.FileName, info.FileHash, info.FileSize)
		if err != nil {
			slog.DebugContext(ctx, "dandanplay matchUnmappedFiles match error",
				"err", err, "episode", ep, "fileName", info.FileName)
			continue
		}
		// Phase 3-stricter gate: only isMatched=true.  Loose-match
		// relaxation deliberately omitted (see package doc).
		if result == nil || !result.IsMatched {
			continue
		}
		if _, dup := usedIDs[result.EpisodeID]; dup {
			continue
		}
		episodeMap[ep] = EpisodeMapEntry{
			DandanEpisodeID: result.EpisodeID,
			Title:           result.EpisodeTitle,
		}
		usedIDs[result.EpisodeID] = struct{}{}
	}
}
