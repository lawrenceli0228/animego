// anime_cache.go: Mongo `anime_cache` -> Postgres `anime_cache` plus seven
// child tables: anime_genres, anime_studios, anime_relations,
// anime_characters, anime_staff, anime_recommendations, anime_episode_titles.
//
// One Mongo document fans out into 1 main row plus N..M child rows depending
// on which embedded arrays are populated.  The natural key throughout is
// anilist_id (an Anilist-assigned integer); the main table uses it as PK and
// every child table FKs back to it.
//
// IDEMPOTENCY / DETERMINISM
//
// Child tables with surrogate UUID primary keys (anime_relations,
// anime_characters, anime_staff, anime_recommendations) get DETERMINISTIC
// UUIDs via uuid.NewSHA1(AnimegoNamespace, "<table>:<anilistId>:<index>").
// Re-running the migration on the same Mongo doc produces identical UUIDs,
// so PK collisions are reproducible rather than randomized noise.  Child
// tables with composite PKs (anime_genres, anime_studios,
// anime_episode_titles) need no surrogate key.
//
// ORCHESTRATOR LIMITATION (intentional, do not fix in this PR)
//
// migrate.Transform exposes a single ConflictTarget string, but TransformRow
// emits rows targeting multiple tables.  The orchestrator currently applies
// the same ConflictTarget to every emitted PGRow, which is wrong for
// fan-out: the main table's "(anilist_id)" target is not a UNIQUE constraint
// on the child tables.  Re-runs against non-empty child tables will fail on
// UNIQUE violations.
//
// Acceptable because the migration is one-shot at cutover; idempotency-on-
// rerun is a nice-to-have, not a blocker.  Operator runs TRUNCATE on every
// anime_* table before re-running.  A future PR may extend Transform with a
// per-table ConflictTarget map; tracked in MIGRATION_PLAN.md.
//
// The ConflictTarget here is "(anilist_id)", correct for the main row.
package transforms

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/lawrenceli0228/animego/go-api/internal/migrate"
)

type animeCacheTransform struct{}

func init() { migrate.Register(&animeCacheTransform{}) }

func (animeCacheTransform) Name() string            { return "anime_cache" }
// Mongoose pluralizes model names lowercased: AnimeCache → animecaches (no underscore).
// Transform Name() stays snake_case (orchestrator identifier); PGTable() is the
// Postgres convention; MongoCollection() is whatever Mongoose actually wrote.
func (animeCacheTransform) MongoCollection() string { return "animecaches" }
func (animeCacheTransform) PGTable() string         { return "anime_cache" }
func (animeCacheTransform) ConflictTarget() string  { return "(anilist_id)" }
func (animeCacheTransform) DependsOn() []string     { return nil }

// childUUID derives a stable v5 UUID from (table, anilistId, index) so
// re-running the transform on the same Mongo document yields the same UUIDs
// every time.  Used for child tables whose PK is a surrogate uuid.
func childUUID(table string, anilistID, index int) uuid.UUID {
	return uuid.NewSHA1(AnimegoNamespace, []byte(fmt.Sprintf("%s:%d:%d", table, anilistID, index)))
}

// floatPtr returns &f or nil when the source field was absent.  Numeric
// fields in Postgres are NULL-friendly; we prefer NULL over a zero default
// to preserve "I don't know" semantics from the upstream Mongo source.
func floatPtr(v float64, present bool) *float64 {
	if !present {
		return nil
	}
	return &v
}

// intPtr is the integer counterpart to floatPtr.
func intPtr(v int, present bool) *int {
	if !present {
		return nil
	}
	return &v
}

// subdocString reads an optional string from an embedded bson.M, returning
// nil when the field is absent or empty.  Used for child-row nullable
// columns like cover_image_color, poster_accent, etc.
func subdocString(m bson.M, key string) *string {
	s, ok := GetString(m, key)
	if !ok || s == "" {
		return nil
	}
	return &s
}

func (animeCacheTransform) TransformRow(_ context.Context, doc bson.M) ([]migrate.PGRow, error) {
	anilistID, ok := GetInt(doc, "anilistId")
	if !ok {
		return nil, fmt.Errorf("anime_cache: missing anilistId")
	}

	rows := make([]migrate.PGRow, 0, 16)

	// -------------------- main anime_cache row --------------------

	titleRomaji, _ := GetString(doc, "titleRomaji")
	titleEnglish, _ := GetString(doc, "titleEnglish")
	titleNative, _ := GetString(doc, "titleNative")
	titleChinese, _ := GetString(doc, "titleChinese")
	coverImageURL, _ := GetString(doc, "coverImageUrl")
	coverImageColor, _ := GetString(doc, "coverImageColor")
	posterAccent, _ := GetString(doc, "posterAccent")
	posterAccentRGB, _ := GetString(doc, "posterAccentRgb")
	bannerImageURL, _ := GetString(doc, "bannerImageUrl")
	description, _ := GetString(doc, "description")
	status, _ := GetString(doc, "status")
	season, _ := GetString(doc, "season")
	format, _ := GetString(doc, "format")
	source, _ := GetString(doc, "source")
	adminFlag, _ := GetString(doc, "adminFlag")

	episodes, episodesOK := GetInt(doc, "episodes")
	seasonYear, seasonYearOK := GetInt(doc, "seasonYear")
	duration, durationOK := GetInt(doc, "duration")
	bgmID, bgmIDOK := GetInt(doc, "bgmId")
	bangumiVotes, bangumiVotesOK := GetInt(doc, "bangumiVotes")
	// bangumi_version is NOT NULL DEFAULT 0 in the PG schema (matches Mongo default).
	// If absent in the Mongo doc, fall back to 0 rather than NULL — orchestrator's
	// INSERT lists the column unconditionally so DEFAULT can't apply server-side.
	bangumiVersion, _ := GetInt(doc, "bangumiVersion")
	posterAccentContrastOnBlack, pacOK := GetFloat(doc, "posterAccentContrastOnBlack")
	averageScore, averageScoreOK := GetFloat(doc, "averageScore")
	bangumiScore, bangumiScoreOK := GetFloat(doc, "bangumiScore")

	var startDate *time.Time
	if sd, ok := GetSubdoc(doc, "startDate"); ok {
		y, _ := GetInt(sd, "year")
		m, _ := GetInt(sd, "month")
		d, _ := GetInt(sd, "day")
		startDate = MakeDate(y, m, d)
	}

	now := time.Now().UTC()
	cachedAt := now
	if t, ok := MongoDateTime(doc["cachedAt"]); ok {
		cachedAt = t
	}

	rows = append(rows, migrate.PGRow{
		Table: "anime_cache",
		Columns: []string{
			"anilist_id",
			"title_romaji",
			"title_english",
			"title_native",
			"title_chinese",
			"cover_image_url",
			"cover_image_color",
			"poster_accent",
			"poster_accent_rgb",
			"poster_accent_contrast_on_black",
			"banner_image_url",
			"description",
			"episodes",
			"status",
			"season",
			"season_year",
			"average_score",
			"format",
			"duration",
			"source",
			"bgm_id",
			"bangumi_score",
			"bangumi_votes",
			"bangumi_version",
			"cached_at",
			"start_date",
			"admin_flag",
			"created_at",
			"updated_at",
		},
		Values: []any{
			anilistID,
			titleRomaji,
			StringPtr(titleEnglish),
			StringPtr(titleNative),
			StringPtr(titleChinese),
			StringPtr(coverImageURL),
			StringPtr(coverImageColor),
			StringPtr(posterAccent),
			StringPtr(posterAccentRGB),
			floatPtr(posterAccentContrastOnBlack, pacOK),
			StringPtr(bannerImageURL),
			StringPtr(description),
			intPtr(episodes, episodesOK),
			StringPtr(status),
			StringPtr(season),
			intPtr(seasonYear, seasonYearOK),
			floatPtr(averageScore, averageScoreOK),
			StringPtr(format),
			intPtr(duration, durationOK),
			StringPtr(source),
			intPtr(bgmID, bgmIDOK),
			floatPtr(bangumiScore, bangumiScoreOK),
			intPtr(bangumiVotes, bangumiVotesOK),
			bangumiVersion,
			cachedAt,
			startDate,
			StringPtr(adminFlag),
			now,
			now,
		},
	})

	// -------------------- anime_genres --------------------

	if genres, ok := GetArray(doc, "genres"); ok {
		for _, g := range genres {
			s, ok := g.(string)
			if !ok || s == "" {
				continue
			}
			rows = append(rows, migrate.PGRow{
				Table:   "anime_genres",
				Columns: []string{"anime_id", "genre"},
				Values:  []any{anilistID, s},
			})
		}
	}

	// -------------------- anime_studios --------------------

	if studios, ok := GetArray(doc, "studios"); ok {
		for _, st := range studios {
			s, ok := st.(string)
			if !ok || s == "" {
				continue
			}
			rows = append(rows, migrate.PGRow{
				Table:   "anime_studios",
				Columns: []string{"anime_id", "studio"},
				Values:  []any{anilistID, s},
			})
		}
	}

	// -------------------- anime_relations --------------------

	if relations, ok := GetArray(doc, "relations"); ok {
		for i, r := range relations {
			sub, ok := toSubdoc(r)
			if !ok {
				continue
			}
			relAnilistID, _ := GetInt(sub, "anilistId")
			relationType, _ := GetString(sub, "relationType")
			title, _ := GetString(sub, "title")
			coverURL, _ := GetString(sub, "coverImageUrl")
			relFormat, _ := GetString(sub, "format")
			contrast, contrastOK := GetFloat(sub, "posterAccentContrastOnBlack")

			rows = append(rows, migrate.PGRow{
				Table: "anime_relations",
				Columns: []string{
					"id",
					"anime_id",
					"anilist_id",
					"relation_type",
					"title",
					"cover_image_url",
					"cover_image_color",
					"poster_accent",
					"poster_accent_rgb",
					"poster_accent_contrast_on_black",
					"format",
				},
				Values: []any{
					childUUID("anime_relations", anilistID, i),
					anilistID,
					relAnilistID,
					StringPtr(relationType),
					StringPtr(title),
					StringPtr(coverURL),
					subdocString(sub, "coverImageColor"),
					subdocString(sub, "posterAccent"),
					subdocString(sub, "posterAccentRgb"),
					floatPtr(contrast, contrastOK),
					StringPtr(relFormat),
				},
			})
		}
	}

	// -------------------- anime_characters --------------------

	if chars, ok := GetArray(doc, "characters"); ok {
		for i, c := range chars {
			sub, ok := toSubdoc(c)
			if !ok {
				continue
			}
			nameEn, _ := GetString(sub, "nameEn")
			nameJa, _ := GetString(sub, "nameJa")
			nameCn, _ := GetString(sub, "nameCn")
			imageURL, _ := GetString(sub, "imageUrl")
			role, _ := GetString(sub, "role")
			vaEn, _ := GetString(sub, "voiceActorEn")
			vaJa, _ := GetString(sub, "voiceActorJa")
			vaCn, _ := GetString(sub, "voiceActorCn")
			vaImage, _ := GetString(sub, "voiceActorImageUrl")

			rows = append(rows, migrate.PGRow{
				Table: "anime_characters",
				Columns: []string{
					"id",
					"anime_id",
					"display_order",
					"name_en",
					"name_ja",
					"name_cn",
					"image_url",
					"role",
					"voice_actor_en",
					"voice_actor_ja",
					"voice_actor_cn",
					"voice_actor_image_url",
				},
				Values: []any{
					childUUID("anime_characters", anilistID, i),
					anilistID,
					i,
					StringPtr(nameEn),
					StringPtr(nameJa),
					StringPtr(nameCn),
					StringPtr(imageURL),
					StringPtr(role),
					StringPtr(vaEn),
					StringPtr(vaJa),
					StringPtr(vaCn),
					StringPtr(vaImage),
				},
			})
		}
	}

	// -------------------- anime_staff --------------------

	if staff, ok := GetArray(doc, "staff"); ok {
		for i, s := range staff {
			sub, ok := toSubdoc(s)
			if !ok {
				continue
			}
			nameEn, _ := GetString(sub, "nameEn")
			nameJa, _ := GetString(sub, "nameJa")
			imageURL, _ := GetString(sub, "imageUrl")
			role, _ := GetString(sub, "role")

			rows = append(rows, migrate.PGRow{
				Table: "anime_staff",
				Columns: []string{
					"id",
					"anime_id",
					"display_order",
					"name_en",
					"name_ja",
					"image_url",
					"role",
				},
				Values: []any{
					childUUID("anime_staff", anilistID, i),
					anilistID,
					i,
					StringPtr(nameEn),
					StringPtr(nameJa),
					StringPtr(imageURL),
					StringPtr(role),
				},
			})
		}
	}

	// -------------------- anime_recommendations --------------------

	if recs, ok := GetArray(doc, "recommendations"); ok {
		for i, r := range recs {
			sub, ok := toSubdoc(r)
			if !ok {
				continue
			}
			recAnilistID, _ := GetInt(sub, "anilistId")
			title, _ := GetString(sub, "title")
			coverURL, _ := GetString(sub, "coverImageUrl")
			contrast, contrastOK := GetFloat(sub, "posterAccentContrastOnBlack")
			avgScore, avgScoreOK := GetFloat(sub, "averageScore")

			rows = append(rows, migrate.PGRow{
				Table: "anime_recommendations",
				Columns: []string{
					"id",
					"anime_id",
					"anilist_id",
					"title",
					"cover_image_url",
					"cover_image_color",
					"poster_accent",
					"poster_accent_rgb",
					"poster_accent_contrast_on_black",
					"average_score",
				},
				Values: []any{
					childUUID("anime_recommendations", anilistID, i),
					anilistID,
					recAnilistID,
					StringPtr(title),
					StringPtr(coverURL),
					subdocString(sub, "coverImageColor"),
					subdocString(sub, "posterAccent"),
					subdocString(sub, "posterAccentRgb"),
					floatPtr(contrast, contrastOK),
					floatPtr(avgScore, avgScoreOK),
				},
			})
		}
	}

	// -------------------- anime_episode_titles --------------------

	if eps, ok := GetArray(doc, "episodeTitles"); ok {
		// Dedup by (anime_id, episode) — prod data has ~17 anime where the
		// Bangumi enrichment pipeline appended new titles instead of
		// replacing.  Keep the LAST occurrence so the most recent enrichment
		// wins; first occurrence would freeze stale Phase-1 results.
		seen := make(map[int]int, len(eps))
		titles := make([]bson.M, 0, len(eps))
		for _, e := range eps {
			sub, ok := toSubdoc(e)
			if !ok {
				continue
			}
			epNum, epOK := GetInt(sub, "episode")
			if !epOK {
				continue
			}
			if idx, dup := seen[epNum]; dup {
				titles[idx] = sub
			} else {
				seen[epNum] = len(titles)
				titles = append(titles, sub)
			}
		}
		for _, sub := range titles {
			epNum, _ := GetInt(sub, "episode")
			nameCn, _ := GetString(sub, "nameCn")
			name, _ := GetString(sub, "name")

			rows = append(rows, migrate.PGRow{
				Table: "anime_episode_titles",
				Columns: []string{
					"anime_id",
					"episode",
					"name_cn",
					"name",
				},
				Values: []any{
					anilistID,
					epNum,
					StringPtr(nameCn),
					StringPtr(name),
				},
			})
		}
	}

	return rows, nil
}

// toSubdoc normalizes a value into bson.M.  bson.A elements arrive as one of
// bson.M / bson.D / map[string]any depending on the codec path; all three must
// be handled.  mongo-driver v2 decodes nested arrays-of-docs into bson.D by
// default even when the outer doc is bson.M.
func toSubdoc(v any) (bson.M, bool) {
	switch s := v.(type) {
	case bson.M:
		return s, true
	case bson.D:
		out := make(bson.M, len(s))
		for _, e := range s {
			out[e.Key] = e.Value
		}
		return out, true
	case map[string]any:
		return bson.M(s), true
	default:
		return nil, false
	}
}
