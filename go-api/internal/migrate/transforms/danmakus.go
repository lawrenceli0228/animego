// danmakus.go: Mongo `danmakus` → Postgres `danmakus`.
//
// One-to-one row mapping with an important quirk: the PG `id` column is a
// `bigint GENERATED ALWAYS AS IDENTITY` and MUST NOT be emitted by this
// transform.  We let PG assign IDs on INSERT.  Consequently this transform
// returns ConflictTarget() == "" (no UPSERT path); idempotency is the
// operator's responsibility — TRUNCATE the table before re-running on the
// same Mongo dump to avoid duplicates.  This choice is documented because
// the natural-key composition (anilist_id, episode, user_id, content,
// live_ends_at) would inflate an index whose only purpose is to dedupe a
// one-shot migration.
//
// `live_ends_at` is REQUIRED upstream (Mongoose `required: true`); a missing
// value is treated as a data integrity error and routed to the failure log.
//
// Content length (≤ 50 chars per app constraint) is enforced by the PG
// CHECK constraint `danmakus_content_length_chk` — we deliberately do NOT
// re-check here; the orchestrator's failure JSONL captures DB rejections
// with full context.
package transforms

import (
	"context"
	"fmt"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/lawrenceli0228/animego/go-api/internal/migrate"
)

type danmakusTransform struct{}

func init() { migrate.Register(&danmakusTransform{}) }

func (danmakusTransform) Name() string            { return "danmakus" }
func (danmakusTransform) MongoCollection() string { return "danmakus" }
func (danmakusTransform) PGTable() string         { return "danmakus" }
func (danmakusTransform) ConflictTarget() string  { return "" }
func (danmakusTransform) DependsOn() []string     { return []string{"users", "anime_cache"} }

func (danmakusTransform) TransformRow(_ context.Context, doc bson.M) ([]migrate.PGRow, error) {
	userID, err := MongoIDToUUID(doc["userId"])
	if err != nil {
		return nil, fmt.Errorf("danmakus: bad userId: %w", err)
	}

	anilistID, ok := GetInt(doc, "anilistId")
	if !ok {
		return nil, fmt.Errorf("danmakus: missing anilistId")
	}
	episode, ok := GetInt(doc, "episode")
	if !ok {
		return nil, fmt.Errorf("danmakus: missing episode")
	}

	username, _ := GetString(doc, "username")
	content, _ := GetString(doc, "content")

	liveEndsAt, ok := MongoDateTime(doc["liveEndsAt"])
	if !ok {
		return nil, fmt.Errorf("danmakus: missing liveEndsAt")
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
		Table: "danmakus",
		Columns: []string{
			"anilist_id",
			"episode",
			"user_id",
			"username",
			"content",
			"live_ends_at",
			"created_at",
			"updated_at",
		},
		Values: []any{
			anilistID,
			episode,
			userID,
			username,
			content,
			liveEndsAt,
			createdAt,
			updatedAt,
		},
	}
	return []migrate.PGRow{row}, nil
}
