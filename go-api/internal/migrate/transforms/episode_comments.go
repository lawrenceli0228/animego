// episode_comments.go: Mongo `episode_comments` → Postgres `episode_comments`.
//
// One-to-one row mapping with a self-FK quirk: `parent_id` references
// another row in the same table (reply tree).  Within one orchestrator
// batch a reply may be inserted before its parent, which would normally
// fail the FK check.  Migration 0003 alters the constraint to
// DEFERRABLE INITIALLY DEFERRED so the check moves to COMMIT time — see
// migrations/0003_defer_comment_self_fk.up.sql for the rationale.
//
// Mongo `parentId` semantics:
//   - field absent or null    → row.parent_id = nil (top-level comment)
//   - field present (ObjectId)→ row.parent_id = MongoIDToUUID(parentId)
//
// Content length (≤ 500 chars per app constraint) is enforced by the PG
// CHECK `episode_comments_content_length_chk`; transform passes through.
package transforms

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/lawrenceli0228/animego/go-api/internal/migrate"
)

type episodeCommentsTransform struct{}

func init() { migrate.Register(&episodeCommentsTransform{}) }

func (episodeCommentsTransform) Name() string            { return "episode_comments" }
// Mongoose collection: EpisodeComment → episodecomments (lowercased + s, no underscore).
func (episodeCommentsTransform) MongoCollection() string { return "episodecomments" }
func (episodeCommentsTransform) PGTable() string         { return "episode_comments" }
func (episodeCommentsTransform) ConflictTarget() string  { return "(id)" }
func (episodeCommentsTransform) DependsOn() []string {
	return []string{"users", "anime_cache"}
}

func (episodeCommentsTransform) TransformRow(_ context.Context, doc bson.M) ([]migrate.PGRow, error) {
	id, err := MongoIDToUUID(doc["_id"])
	if err != nil {
		return nil, fmt.Errorf("episode_comments: bad _id: %w", err)
	}

	userID, err := MongoIDToUUID(doc["userId"])
	if err != nil {
		return nil, fmt.Errorf("episode_comments: bad userId: %w", err)
	}

	anilistID, ok := GetInt(doc, "anilistId")
	if !ok {
		return nil, fmt.Errorf("episode_comments: missing anilistId")
	}
	episode, ok := GetInt(doc, "episode")
	if !ok {
		return nil, fmt.Errorf("episode_comments: missing episode")
	}

	username, _ := GetString(doc, "username")
	content, _ := GetString(doc, "content")
	replyToUsername, _ := GetString(doc, "replyToUsername")

	// parent_id: nullable self-FK.  Absent or explicit nil → NULL in PG.
	var parentID *uuid.UUID
	if raw, present := doc["parentId"]; present && raw != nil {
		pid, err := MongoIDToUUID(raw)
		if err != nil {
			return nil, fmt.Errorf("episode_comments: bad parentId: %w", err)
		}
		parentID = &pid
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
		Table: "episode_comments",
		Columns: []string{
			"id",
			"anilist_id",
			"episode",
			"user_id",
			"username",
			"content",
			"parent_id",
			"reply_to_username",
			"created_at",
			"updated_at",
		},
		Values: []any{
			id,
			anilistID,
			episode,
			userID,
			username,
			content,
			parentID,
			StringPtr(replyToUsername),
			createdAt,
			updatedAt,
		},
	}
	return []migrate.PGRow{row}, nil
}
