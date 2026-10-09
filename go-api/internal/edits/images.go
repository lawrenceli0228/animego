package edits

import (
	"context"
	"errors"
	"image"
	"image/color"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/lawrenceli0228/animego/go-api/internal/avatars"
)

// Photos submitted with an edit live on the avatar volume, under
// <root>/pending until an admin accepts them and <root>/public after.  The
// public route serves public/ only, so an image is public exactly when it
// has been accepted -- a property of where the file is, not of a check a
// handler could forget.  A rejected image is deleted.
//
// Both ways in -- an upload (a data URL, the shape PATCH /api/auth/me
// takes) and a fetched link -- go through the avatar pipeline
// (avatars.DecodeDataURL, avatars.DecodeImage, avatars.WriteJPEG): the
// format read from the bytes, JPEG or PNG only, the byte and dimension caps
// checked before a pixel is allocated, and a re-encode to JPEG that keeps
// nothing but the pixels.  Then one step the avatar does not need (its
// client crops to a small square): anything larger than maxStoredSide on a
// side is scaled down, since a portrait is drawn at 230x345 and a 4000px
// original would be what every reader of the page downloads.
//
// File names are fresh UUIDs, never anything the submitter chose, and the
// serving routes accept nothing else.

// maxStoredSide is the longest side a stored photo keeps: three times the
// largest portrait the pages draw (345px), rounded.
const maxStoredSide = 1200

var imageNameRe = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$`)

// errImageFile: the image could not be written or moved (a server fault).
var errImageFile = errors.New("edits: image file")

// StoredImage is a photo an edit proposes, as its item stores it.
type StoredImage struct {
	// File is the stored file's name: <uuid>.jpg.
	File   string `json:"file"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
	// Source is the link it was fetched from; null for an upload.
	Source *string `json:"source"`
}

type imageFetcher interface {
	Fetch(ctx context.Context, link string) ([]byte, error)
}

// ImageStore keeps the photos edits propose.
type ImageStore struct {
	root    string
	origin  string
	fetcher imageFetcher
}

// NewImageStore stores under root and publishes at origin (the site's own
// address: an accepted photo's URL is origin + /api/edit-images/<file>).
func NewImageStore(root, origin string, fetcher imageFetcher) *ImageStore {
	return &ImageStore{root: root, origin: strings.TrimRight(origin, "/"), fetcher: fetcher}
}

func (s *ImageStore) pendingPath(name string) string { return filepath.Join(s.root, "pending", name) }
func (s *ImageStore) publicPath(name string) string  { return filepath.Join(s.root, "public", name) }

// PublicURL is where an accepted photo is served.
func (s *ImageStore) PublicURL(name string) string { return s.origin + "/api/edit-images/" + name }

// SaveUpload stores an uploaded photo (a JPEG or PNG data URL) as pending.
func (s *ImageStore) SaveUpload(dataURL string) (StoredImage, error) {
	raw, err := avatars.DecodeDataURL(dataURL)
	if err != nil {
		return StoredImage{}, err
	}
	return s.save(raw, nil)
}

// SaveLink fetches a linked photo (see fetch.go) and stores it as pending.
// The link is checked here as well as in the fetcher, so no fetcher is
// ever handed one the rules refuse.
func (s *ImageStore) SaveLink(ctx context.Context, link string) (StoredImage, error) {
	if _, err := checkImageURL(link); err != nil {
		return StoredImage{}, err
	}
	raw, err := s.fetcher.Fetch(ctx, link)
	if err != nil {
		return StoredImage{}, err
	}
	source := strings.TrimSpace(link)
	return s.save(raw, &source)
}

func (s *ImageStore) save(raw []byte, source *string) (StoredImage, error) {
	img, err := avatars.DecodeImage(raw)
	if err != nil {
		return StoredImage{}, err
	}
	img = fitWithin(img, maxStoredSide)
	if err := os.MkdirAll(filepath.Join(s.root, "pending"), 0o755); err != nil {
		return StoredImage{}, errors.Join(errImageFile, err)
	}
	name := uuid.NewString() + ".jpg"
	if err := avatars.WriteJPEG(s.pendingPath(name), img); err != nil {
		return StoredImage{}, errors.Join(errImageFile, err)
	}
	b := img.Bounds()
	return StoredImage{File: name, Width: b.Dx(), Height: b.Dy(), Source: source}, nil
}

// Publish moves an accepted photo from pending to public and returns its
// public URL.
func (s *ImageStore) Publish(name string) (string, error) {
	if !imageNameRe.MatchString(name) {
		return "", errImageFile
	}
	if err := os.MkdirAll(filepath.Join(s.root, "public"), 0o755); err != nil {
		return "", errors.Join(errImageFile, err)
	}
	if err := os.Rename(s.pendingPath(name), s.publicPath(name)); err != nil {
		return "", errors.Join(errImageFile, err)
	}
	return s.PublicURL(name), nil
}

// Unpublish undoes Publish, for a review whose transaction failed after
// the move.
func (s *ImageStore) Unpublish(name string) error {
	if !imageNameRe.MatchString(name) {
		return errImageFile
	}
	return os.Rename(s.publicPath(name), s.pendingPath(name))
}

// Discard deletes a pending photo: rejected, or its submission never
// stored.  Best effort -- a file left behind is unreachable either way.
func (s *ImageStore) Discard(name string) {
	if imageNameRe.MatchString(name) {
		_ = os.Remove(s.pendingPath(name))
	}
}

// ServePublic answers GET /api/edit-images/{name}: accepted photos only,
// cached for good (a name is never reused for another image).
func (s *ImageStore) ServePublic() http.HandlerFunc {
	return s.serve(s.publicPath, "public, max-age=31536000, immutable")
}

// ServePending answers the admin's GET /api/admin/edits/images/{name}:
// photos waiting for review, never cached anywhere.
func (s *ImageStore) ServePending() http.HandlerFunc {
	return s.serve(s.pendingPath, "private, no-store")
}

func (s *ImageStore) serve(path func(string) string, cacheControl string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		name := chi.URLParam(r, "name")
		if !imageNameRe.MatchString(name) {
			http.NotFound(w, r)
			return
		}
		f, err := os.Open(path(name))
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer f.Close()
		info, err := f.Stat()
		if err != nil || info.IsDir() {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Cache-Control", cacheControl)
		w.Header().Set("Content-Type", "image/jpeg")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		http.ServeContent(w, r, name, info.ModTime(), f)
	}
}

// fitWithin scales img down, keeping its proportions, until neither side
// is longer than maxSide; a smaller image is returned as it is.  A box
// filter: every source pixel counts toward the one it falls in, which is
// what shrinking a photo several times over wants (a point sample would
// alias).
func fitWithin(img image.Image, maxSide int) image.Image {
	b := img.Bounds()
	sw, sh := b.Dx(), b.Dy()
	if sw <= maxSide && sh <= maxSide {
		return img
	}
	dw, dh := maxSide, maxSide
	if sw >= sh {
		dh = max(1, sh*maxSide/sw)
	} else {
		dw = max(1, sw*maxSide/sh)
	}
	dst := image.NewRGBA(image.Rect(0, 0, dw, dh))
	for y := 0; y < dh; y++ {
		y0 := b.Min.Y + y*sh/dh
		y1 := max(y0+1, b.Min.Y+(y+1)*sh/dh)
		for x := 0; x < dw; x++ {
			x0 := b.Min.X + x*sw/dw
			x1 := max(x0+1, b.Min.X+(x+1)*sw/dw)
			var r, g, bl, a, n uint64
			for sy := y0; sy < y1; sy++ {
				for sx := x0; sx < x1; sx++ {
					cr, cg, cb, ca := img.At(sx, sy).RGBA()
					r += uint64(cr)
					g += uint64(cg)
					bl += uint64(cb)
					a += uint64(ca)
					n++
				}
			}
			dst.SetRGBA(x, y, color.RGBA{
				R: uint8((r / n) >> 8), G: uint8((g / n) >> 8), B: uint8((bl / n) >> 8), A: uint8((a / n) >> 8),
			})
		}
	}
	return dst
}
