// subscriptions.go: Mongo `subscriptions` → Postgres `subscriptions`.
//
// Composite-key target: (user_id, anilist_id).  userId is mapped through
// MongoIDToUUID to match the same deterministic UUID assigned by the users
// transform.  status is passed through verbatim — invalid values will be
// rejected by the PG CHECK constraint at INSERT time and routed to the
// orchestrator's failure log; this transform does not silently rewrite
// them.
package transforms

import (
	"context"
	"fmt"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/lawrenceli0228/animego/go-api/internal/migrate"
)

type subscriptionsTransform struct{}

func init() { migrate.Register(&subscriptionsTransform{}) }

func (subscriptionsTransform) Name() string            { return "subscriptions" }
func (subscriptionsTransform) MongoCollection() string { return "subscriptions" }
func (subscriptionsTransform) PGTable() string         { return "subscriptions" }
func (subscriptionsTransform) ConflictTarget() string  { return "(user_id, anilist_id)" }
func (subscriptionsTransform) DependsOn() []string {
	return []string{"users", "anime_cache"}
}

func (subscriptionsTransform) TransformRow(_ context.Context, doc bson.M) ([]migrate.PGRow, error) {
	userID, err := MongoIDToUUID(doc["userId"])
	if err != nil {
		return nil, fmt.Errorf("subscriptions: bad userId: %w", err)
	}

	anilistID, ok := GetInt(doc, "anilistId")
	if !ok {
		return nil, fmt.Errorf("subscriptions: missing anilistId for user %s", userID)
	}

	status, _ := GetString(doc, "status")
	currentEpisode, _ := GetInt(doc, "currentEpisode")

	var scorePtr *int
	if s, ok := GetInt(doc, "score"); ok {
		scorePtr = &s
	}

	var lastWatchedAt *time.Time
	if t, ok := MongoDateTime(doc["lastWatchedAt"]); ok {
		lastWatchedAt = &t
	}

	now := time.Now().UTC()
	createdAt := now
	if t, ok := MongoDateTime(doc["createdAt"]); ok {
		createdAt = t
	}
	updatedAt := now
	if t, ok := MongoDateTime(doc["updatedAt"]); ok {
		updatedAt = t
	}

	row := migrate.PGRow{
		Table: "subscriptions",
		Columns: []string{
			"user_id",
			"anilist_id",
			"status",
			"current_episode",
			"score",
			"last_watched_at",
			"created_at",
			"updated_at",
		},
		Values: []any{
			userID,
			anilistID,
			status,
			currentEpisode,
			scorePtr,
			lastWatchedAt,
			createdAt,
			updatedAt,
		},
	}
	return []migrate.PGRow{row}, nil
}
