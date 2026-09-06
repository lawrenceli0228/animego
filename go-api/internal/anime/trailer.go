package anime

import (
	"regexp"
	"strings"

	"github.com/lawrenceli0228/animego/go-api/internal/anilist"
)

// youtubeTrailerID is YouTube's 11-character video id.  The same rule is
// written down in migration 0032's anime_trailer_pair CHECK, which is the
// load-bearing copy: warm_season logs and skips a failed per-row upsert, so a
// value this regexp let through and the constraint refused would silently stop
// that row from refreshing.  test/integration/trailer_columns_test.go drives
// this function's whole accept/reject table through the real constraint so the
// two cannot drift apart unnoticed.
var youtubeTrailerID = regexp.MustCompile(`^[A-Za-z0-9_-]{11}$`)

// supportedTrailer returns metadata only, never an arbitrary embed URL.  A
// trailer on any other site is reported as none: the API promises a YouTube id
// and nothing renders anything else.
func supportedTrailer(t *anilist.Trailer) *anilist.Trailer {
	if t == nil || t.ID == nil || t.Site == nil || strings.ToLower(*t.Site) != "youtube" || !youtubeTrailerID.MatchString(*t.ID) {
		return nil
	}
	id, site := *t.ID, "youtube"
	return &anilist.Trailer{ID: &id, Site: &site}
}
