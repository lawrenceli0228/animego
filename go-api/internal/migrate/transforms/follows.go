// follows.go: Mongo `follows` → Postgres `follows`.
//
// Maps the social-graph edge between two users.  Both endpoints flow
// through MongoIDToUUID so the FKs line up with the users transform's
// deterministic id mapping.  Composite PK on (follower_id, followee_id);
// the ON CONFLICT clause idempotently re-runs the migration without
// duplicating edges.
package transforms

import (
	"context"
	"fmt"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/lawrenceli0228/animego/go-api/internal/migrate"
)

type followsTransform struct{}

func init() { migrate.Register(&followsTransform{}) }

func (followsTransform) Name() string            { return "follows" }
func (followsTransform) MongoCollection() string { return "follows" }
func (followsTransform) PGTable() string         { return "follows" }
func (followsTransform) ConflictTarget() string  { return "(follower_id, followee_id)" }
func (followsTransform) DependsOn() []string     { return []string{"users"} }

func (followsTransform) TransformRow(_ context.Context, doc bson.M) ([]migrate.PGRow, error) {
	followerID, err := MongoIDToUUID(doc["followerId"])
	if err != nil {
		return nil, fmt.Errorf("follows: bad followerId: %w", err)
	}
	followeeID, err := MongoIDToUUID(doc["followeeId"])
	if err != nil {
		return nil, fmt.Errorf("follows: bad followeeId: %w", err)
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
		Table: "follows",
		Columns: []string{
			"follower_id",
			"followee_id",
			"created_at",
			"updated_at",
		},
		Values: []any{
			followerID,
			followeeID,
			createdAt,
			updatedAt,
		},
	}
	return []migrate.PGRow{row}, nil
}
