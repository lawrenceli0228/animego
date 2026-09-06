package anime

import (
	"github.com/lawrenceli0228/animego/go-api/internal/anilist"
	"regexp"
	"strings"
)

var youtubeTrailerID = regexp.MustCompile(`^[A-Za-z0-9_-]{11}$`)

// supportedTrailer returns metadata only, never an arbitrary embed URL.
func supportedTrailer(t *anilist.Trailer) *anilist.Trailer {
	if t == nil || t.ID == nil || t.Site == nil || strings.ToLower(*t.Site) != "youtube" || !youtubeTrailerID.MatchString(*t.ID) {
		return nil
	}
	id, site := *t.ID, "youtube"
	return &anilist.Trailer{ID: &id, Site: &site}
}
