// episode_windows.go: Mongo `episode_windows` → Postgres `episode_windows`.
//
// Single-row mapping for live-broadcast freshness windows.  liveEndsAt is
// REQUIRED — a missing or malformed value fails the doc into the
// orchestrator's failure log rather than silently dropping it.  The
// collection has no timestamps in Mongo, so the PG table mirrors that:
// only (anilist_id, episode, live_ends_at) are written.
package transforms

import (
	"context"
	"fmt"

	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/lawrenceli0228/animego/go-api/internal/migrate"
)

type episodeWindowsTransform struct{}

func init() { migrate.Register(&episodeWindowsTransform{}) }

func (episodeWindowsTransform) Name() string            { return "episode_windows" }
func (episodeWindowsTransform) MongoCollection() string { return "episode_windows" }
func (episodeWindowsTransform) PGTable() string         { return "episode_windows" }
func (episodeWindowsTransform) ConflictTarget() string  { return "(anilist_id, episode)" }
func (episodeWindowsTransform) DependsOn() []string     { return []string{"anime_cache"} }

func (episodeWindowsTransform) TransformRow(_ context.Context, doc bson.M) ([]migrate.PGRow, error) {
	anilistID, ok := GetInt(doc, "anilistId")
	if !ok {
		return nil, fmt.Errorf("episode_windows: missing anilistId")
	}
	episode, ok := GetInt(doc, "episode")
	if !ok {
		return nil, fmt.Errorf("episode_windows: missing episode for anilistId=%d", anilistID)
	}
	liveEndsAt, ok := MongoDateTime(doc["liveEndsAt"])
	if !ok {
		return nil, fmt.Errorf("episode_windows: missing liveEndsAt for anilistId=%d episode=%d", anilistID, episode)
	}

	row := migrate.PGRow{
		Table: "episode_windows",
		Columns: []string{
			"anilist_id",
			"episode",
			"live_ends_at",
		},
		Values: []any{
			anilistID,
			episode,
			liveEndsAt,
		},
	}
	return []migrate.PGRow{row}, nil
}
