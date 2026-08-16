package pii

import (
	"crypto/md5"
	"encoding/hex"
	"strings"
	"testing"
)

// The shapes below are the ones actually observed in production on
// 2026-08-16 (values altered, shapes kept): a QQ address used as a
// username, a bare mobile number, and a bare QQ number.
func TestLooksLikeContact_MasksWhatWasFoundInProduction(t *testing.T) {
	contactShaped := []string{
		"2548537435@qq.com", // QQ address — the reported case
		"xieyu_5656@qq.com", // same shape, different local part
		"someone@gmail.com",
		"17566285293",  // mainland mobile, 11 digits
		"154961455462", // bare QQ number, 12 digits
		"1234567",      // shortest run we treat as an account id
	}
	for _, u := range contactShaped {
		if !LooksLikeContact(u) {
			t.Errorf("LooksLikeContact(%q) = false, want true — this would leak", u)
		}
	}
}

func TestLooksLikeContact_LeavesRealUsernamesAlone(t *testing.T) {
	// Every one of these must pass through byte-for-byte.  A false
	// positive here silently renames a real user.
	safe := []string{
		"lawrence",
		"无始冬", // CJK handle, from the same production sample
		"xin",
		"user_2024",
		"2024",     // short numeric handle, under minDigitRun
		"123456",   // 6 digits — still under the line
		"a1b2c3d4", // mixed, not all digits
		"kirito-kun",
		"日暮里の猫",
	}
	for _, u := range safe {
		if LooksLikeContact(u) {
			t.Errorf("LooksLikeContact(%q) = true, want false — this would rename a real user", u)
		}
	}
}

func TestLooksLikeContact_EmptyAndBlank(t *testing.T) {
	for _, u := range []string{"", "   ", "\t"} {
		if LooksLikeContact(u) {
			t.Errorf("LooksLikeContact(%q) = true, want false", u)
		}
	}
}

func TestLooksLikeContact_AnyAtSignCounts(t *testing.T) {
	// Deliberately cruder than RFC 5322 — a username has no legitimate
	// reason to carry an '@', and a false negative costs an address.
	for _, u := range []string{"@handle", "no-tld@localhost", "a@b", "two@@ats"} {
		if !LooksLikeContact(u) {
			t.Errorf("LooksLikeContact(%q) = false, want true", u)
		}
	}
}

func TestLooksLikeContact_IgnoresSurroundingWhitespace(t *testing.T) {
	if !LooksLikeContact("  2548537435@qq.com  ") {
		t.Error("padded address should still be detected")
	}
}

func TestPublicUsername_MasksContactLeavesRest(t *testing.T) {
	const addr = "2548537435@qq.com"
	got := PublicUsername(addr)

	if strings.Contains(got, "@") {
		t.Fatalf("PublicUsername(%q) = %q — still contains an '@'", addr, got)
	}
	if strings.Contains(got, "2548537435") {
		t.Fatalf("PublicUsername(%q) = %q — still contains the local part", addr, got)
	}
	if !strings.HasPrefix(got, SlugPrefix) {
		t.Fatalf("PublicUsername(%q) = %q — want the %q prefix", addr, got, SlugPrefix)
	}

	if got := PublicUsername("lawrence"); got != "lawrence" {
		t.Fatalf("PublicUsername(%q) = %q, want it unchanged", "lawrence", got)
	}
}

// A partial redaction like "xi***@qq.com" would still disclose the provider
// and enough of the local part to guess at.  Pin the stronger contract.
func TestPublicUsername_DisclosesNothingAboutTheAddress(t *testing.T) {
	for _, addr := range []string{"2548537435@qq.com", "xieyu_5656@qq.com", "someone@gmail.com"} {
		got := PublicUsername(addr)
		for _, leak := range []string{"qq", "gmail", ".com", "@", "xieyu", "someone"} {
			if strings.Contains(got, leak) {
				t.Errorf("PublicUsername(%q) = %q leaks %q", addr, got, leak)
			}
		}
	}
}

func TestSlug_IsStable(t *testing.T) {
	const addr = "2548537435@qq.com"
	if Slug(addr) != Slug(addr) {
		t.Fatal("Slug is not deterministic")
	}
	if Slug(addr) == Slug("other@qq.com") {
		t.Fatal("different usernames collided")
	}
}

// The reverse lookup runs in SQL as left(md5(username), 10).  If Go and
// Postgres ever disagree on the digest input, /u/{slug} silently 404s for
// exactly the users this package is protecting.  This pins the Go half to
// the raw bytes, with no case folding, so the SQL half can match it.
func TestSlug_MatchesPostgresMd5Contract(t *testing.T) {
	const addr = "2548537435@qq.com"

	sum := md5.Sum([]byte(addr)) // raw bytes, no ToLower
	want := SlugPrefix + hex.EncodeToString(sum[:])[:slugHexLen]

	if got := Slug(addr); got != want {
		t.Fatalf("Slug(%q) = %q, want %q — the SQL lookup will not match", addr, got, want)
	}
	if len(want) != len(SlugPrefix)+slugHexLen {
		t.Fatalf("slug length drifted: %d", len(want))
	}
}

// Case folding would have made the Go side depend on Postgres collation
// agreeing with Go's Unicode casing.  Assert we did not do it.
func TestSlug_IsCaseSensitive(t *testing.T) {
	if Slug("A@b.com") == Slug("a@b.com") {
		t.Fatal("Slug folded case — it must hash raw bytes so SQL md5(username) matches")
	}
}

func TestPublicUsernamePtr(t *testing.T) {
	if got := PublicUsernamePtr(nil); got != nil {
		t.Fatalf("PublicUsernamePtr(nil) = %v, want nil", got)
	}

	addr := "2548537435@qq.com"
	got := PublicUsernamePtr(&addr)
	if got == nil || strings.Contains(*got, "@") {
		t.Fatalf("PublicUsernamePtr(%q) = %v — not masked", addr, got)
	}
	if addr != "2548537435@qq.com" {
		t.Fatalf("PublicUsernamePtr mutated its input: %q", addr)
	}

	plain := "lawrence"
	if got := PublicUsernamePtr(&plain); got == nil || *got != "lawrence" {
		t.Fatalf("PublicUsernamePtr(%q) changed a safe username", plain)
	}
}
