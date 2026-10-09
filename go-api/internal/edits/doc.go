// Package edits takes readers' edits to the person and character pages and
// the admin review of them.
//
//	POST /api/edits                          a signed-in reader submits
//	GET  /api/edit-images/{name}             an accepted photo
//	GET  /api/admin/edits                    the queue (admin)
//	GET  /api/admin/edits/{id}               one submission, item by item
//	POST /api/admin/edits/{id}/review        accept or reject each item
//	GET  /api/admin/edits/images/{name}      a photo waiting for review
//
// A submission is diffed against the page as it is shown now (people.Load*,
// accepted edits included): only what changed becomes an item, and a
// submission that changes nothing is refused.  Each item is reviewed on its
// own; an accepted one is merged into the page's overlay (internal/overlay,
// entity_overlays) and never into the tables AniList refreshes, a rejected
// one carries the note its submitter is told.  The submitter hears through
// the site's notification inbox.
package edits
