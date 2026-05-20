package transforms

import (
	"sort"
	"testing"

	"github.com/lawrenceli0228/animego/go-api/internal/migrate"
)

// Verifies all seven P1.C transforms registered themselves via init().
// If episode_windows (or any other) is missing, this test fails loudly so
// future contributors aren't surprised by a silently empty registry.
func TestAllSevenTransformsRegistered(t *testing.T) {
	want := []string{
		"anime_cache",
		"danmakus",
		"episode_comments",
		"episode_windows",
		"follows",
		"subscriptions",
		"users",
	}
	sort.Strings(want)

	registered := migrate.Registered()
	got := make([]string, 0, len(registered))
	for _, tr := range registered {
		got = append(got, tr.Name())
	}
	sort.Strings(got)

	t.Logf("registered: %v", got)

	if len(got) != len(want) {
		t.Errorf("registered count = %d, want %d", len(got), len(want))
	}

	wantSet := make(map[string]bool, len(want))
	for _, n := range want {
		wantSet[n] = true
	}
	for _, n := range got {
		delete(wantSet, n)
	}
	if len(wantSet) > 0 {
		missing := make([]string, 0, len(wantSet))
		for n := range wantSet {
			missing = append(missing, n)
		}
		sort.Strings(missing)
		t.Errorf("missing transforms: %v", missing)
	}
}
