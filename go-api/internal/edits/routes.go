package edits

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

// Mount registers the reader-facing routes on the API root: the submission,
// behind requireAuth (only signed-in readers submit), and the accepted
// photos, which anyone may load.
func (h *Handlers) Mount(r chi.Router, requireAuth func(http.Handler) http.Handler) {
	r.With(requireAuth).Post("/api/edits", h.Submit)
	r.Get("/api/edit-images/{name}", h.images.ServePublic())
}

// MountAdmin registers the review routes on the /api/admin group, which
// already requires a signed-in admin.  The static images segment resolves
// before the {id} pattern, whatever the order.
func (h *Handlers) MountAdmin(r chi.Router) {
	r.Get("/edits", h.List)
	r.Get("/edits/images/{name}", h.images.ServePending())
	r.Get("/edits/{id}", h.Get)
	r.Post("/edits/{id}/review", h.Review)
}
