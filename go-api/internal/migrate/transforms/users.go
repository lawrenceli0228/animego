// users.go: Mongo `users` → Postgres `users`.
//
// One-to-one row mapping.  ObjectId becomes a deterministic UUID v5 via
// MongoIDToUUID; username, email, and bcrypt password hash pass through
// unchanged; nullable string fields land as *string (nil → NULL).
//
// The `is_public` column intentionally is NOT in Columns/Values — the
// Postgres schema sets DEFAULT true, and leaving it out lets that default
// apply on first INSERT.  On UPSERT (ON CONFLICT DO UPDATE) the column is
// not touched either, preserving whatever the application has stored.
package transforms

import (
	"context"
	"fmt"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/lawrenceli0228/animego/go-api/internal/migrate"
)

type usersTransform struct{}

func init() { migrate.Register(&usersTransform{}) }

func (usersTransform) Name() string             { return "users" }
func (usersTransform) MongoCollection() string  { return "users" }
func (usersTransform) PGTable() string          { return "users" }
func (usersTransform) ConflictTarget() string   { return "(id)" }
func (usersTransform) DependsOn() []string      { return nil }

func (usersTransform) TransformRow(_ context.Context, doc bson.M) ([]migrate.PGRow, error) {
	id, err := MongoIDToUUID(doc["_id"])
	if err != nil {
		return nil, fmt.Errorf("users: bad _id: %w", err)
	}

	username, _ := GetString(doc, "username")
	email, _ := GetString(doc, "email")
	password, _ := GetString(doc, "password")
	roleStr, _ := GetString(doc, "role")
	refreshToken, _ := GetString(doc, "refreshToken")
	resetToken, _ := GetString(doc, "resetPasswordToken")

	var resetExpires *time.Time
	if t, ok := MongoDateTime(doc["resetPasswordExpires"]); ok {
		resetExpires = &t
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
		Table: "users",
		Columns: []string{
			"id",
			"username",
			"email",
			"password",
			"role",
			"refresh_token",
			"reset_password_token",
			"reset_password_expires",
			"created_at",
			"updated_at",
		},
		Values: []any{
			id,
			username,
			email,
			password,
			StringPtr(roleStr),
			StringPtr(refreshToken),
			StringPtr(resetToken),
			resetExpires,
			createdAt,
			updatedAt,
		},
	}
	return []migrate.PGRow{row}, nil
}
