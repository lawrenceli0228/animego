package auth

import (
	"strings"
	"testing"

	"github.com/google/uuid"

	dbgen "github.com/lawrenceli0228/animego/go-api/internal/db/gen"
)

// One name, one value, everyone — the owner included.  There is no second
// field carrying the raw username, so nothing can leak it back and nothing
// on screen can disagree with what other people see.
func TestToSafeUser_MasksForTheOwnerToo(t *testing.T) {
	const addr = "2548537435@qq.com"

	su := ToSafeUser(dbgen.User{ID: uuid.New(), Username: addr, Email: addr})

	if su.Username == addr {
		t.Fatal("Username still holds the address — the owner's own view leaks it")
	}
	if !strings.HasPrefix(su.Username, "user-") {
		t.Fatalf("Username = %q, want a masked handle", su.Username)
	}
	if !su.UsernameHidden {
		t.Fatal("UsernameHidden = false — the settings page cannot explain the handle")
	}
}

// The common case must stay boring: the real name, no flag, no warning.
func TestToSafeUser_LeavesAnOrdinaryNameAlone(t *testing.T) {
	su := ToSafeUser(dbgen.User{ID: uuid.New(), Username: "lawrence", Email: "l@example.com"})

	if su.Username != "lawrence" {
		t.Fatalf("Username = %q, want it unchanged", su.Username)
	}
	if su.UsernameHidden {
		t.Fatal("UsernameHidden = true for an ordinary name — a warning would appear for no reason")
	}
}

// The flag and the value have to agree.  If they ever drift, the settings
// page either warns about a name that is fine or stays silent about one that
// is hidden.
func TestToSafeUser_FlagAgreesWithTheValue(t *testing.T) {
	cases := []struct {
		stored     string
		wantHidden bool
	}{
		{"2548537435@qq.com", true},
		{"17566285293", true},
		{"154961455462", true},
		{"lawrence", false},
		{"无始冬", false},
		{"2024", false},
	}
	for _, c := range cases {
		su := ToSafeUser(dbgen.User{ID: uuid.New(), Username: c.stored})
		if su.UsernameHidden != c.wantHidden {
			t.Errorf("%q: UsernameHidden = %v, want %v", c.stored, su.UsernameHidden, c.wantHidden)
		}
		masked := su.Username != c.stored
		if masked != c.wantHidden {
			t.Errorf("%q: value masked = %v but flag = %v — they disagree", c.stored, masked, su.UsernameHidden)
		}
	}
}

// ToSafeUser is documented as the ONLY conversion from a DB row into a
// response payload.  Assert the secret columns still do not survive it, so
// the guarantee that everything routes through here keeps its teeth.
func TestToSafeUser_StillStripsSecrets(t *testing.T) {
	su := ToSafeUser(dbgen.User{
		ID:                 uuid.New(),
		Username:           "lawrence",
		Email:              "l@example.com",
		Password:           "$2a$10$hashed",
		RefreshToken:       strptr("refresh-token"),
		ResetPasswordToken: strptr("reset-token"),
	})

	// SafeUser has no field for any of them — a compile-time guarantee — so
	// assert the observable part: the projection built and did not carry the
	// extra columns through some future catch-all.
	if su.Username != "lawrence" || su.Email != "l@example.com" {
		t.Fatalf("unexpected projection: %+v", su)
	}
}

func strptr(s string) *string { return &s }
