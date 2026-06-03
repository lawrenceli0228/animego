// Package avatars stores member-pass photos as files on a mounted volume
// instead of base64 data URLs in the DB. A data URL embedded in every
// /me + watchers + followers + comments row balloons those responses
// (100KB/row) and can't be cached; a file gets a short URL (~80 chars)
// that the browser + Cloudflare edge cache.
//
// Flow:
//
//	PATCH /api/auth/me {avatarUrl: "data:image/jpeg;base64,..."}
//	  → Save: decode → validate → re-encode JPEG (strips EXIF) → {dir}/{uuid}.jpg
//	  → avatar_url = "/api/avatars/{uuid}.jpg?v={unix}"   (?v busts CF on change)
//	GET /api/avatars/{uuid}.jpg  → ServeAvatar reads the file, long-cache headers.
package avatars

import (
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"image"
	"image/jpeg"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	_ "image/png" // register PNG decoder for image.Decode

	"github.com/go-chi/chi/v5"
)

// maxDecodedBytes caps the decoded upload (pre-re-encode) so a hostile
// caller can't OOM the process with a giant base64 blob. The cropped
// client output is ~50-120KB; 6MB is a generous ceiling.
const maxDecodedBytes = 6 << 20

// maxDimension rejects absurdly large images even if small on disk
// (decompression-bomb guard).
const maxDimension = 4000

// jpegQuality for the stored re-encode. 90 matches the client crop output.
const jpegQuality = 90

// nameRe allows only "{uuid}.jpg" — the userID is a google/uuid canonical
// hyphenated hex string. Anchored + no '/' or '.' beyond the suffix, so
// filepath.Join can't be walked out of the avatar dir.
var nameRe = regexp.MustCompile(`^[0-9a-fA-F-]{36}\.jpg$`)

var (
	errNotImage = errors.New("avatar: not a base64 image data URL")
	errTooLarge = errors.New("avatar: image too large")
	errDecode   = errors.New("avatar: could not decode image")
)

// IsBadImage reports whether err is a client-side validation failure (bad
// data URL / too large / undecodable) vs a server-side write failure. Lets
// the handler return 400 vs 500 instead of a misleading "too large".
func IsBadImage(err error) bool {
	return errors.Is(err, errNotImage) || errors.Is(err, errTooLarge) || errors.Is(err, errDecode)
}

// Save decodes a data URL, validates + re-encodes it to JPEG, and writes
// it atomically to {dir}/{userID}.jpg. Returns the public URL (with a
// cache-busting ?v= so a changed photo is fetched fresh through CF).
func Save(dir, userID, dataURL string) (string, error) {
	comma := strings.IndexByte(dataURL, ',')
	if comma < 0 {
		return "", errNotImage
	}
	meta := dataURL[:comma]
	if !strings.HasPrefix(meta, "data:image/") || !strings.Contains(meta, "base64") {
		return "", errNotImage
	}
	raw, err := base64.StdEncoding.DecodeString(dataURL[comma+1:])
	if err != nil {
		return "", errDecode
	}
	if len(raw) > maxDecodedBytes {
		return "", errTooLarge
	}

	img, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return "", errDecode
	}
	b := img.Bounds()
	if b.Dx() > maxDimension || b.Dy() > maxDimension {
		return "", errTooLarge
	}

	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	final := filepath.Join(dir, userID+".jpg")
	tmp := final + ".tmp"
	f, err := os.Create(tmp)
	if err != nil {
		return "", err
	}
	if err := jpeg.Encode(f, img, &jpeg.Options{Quality: jpegQuality}); err != nil {
		f.Close()
		os.Remove(tmp)
		return "", err
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return "", err
	}
	if err := os.Rename(tmp, final); err != nil { // atomic replace
		os.Remove(tmp)
		return "", err
	}

	return fmt.Sprintf("/api/avatars/%s.jpg?v=%d", userID, time.Now().Unix()), nil
}

// Delete removes a user's avatar file (best-effort; missing file is fine).
func Delete(dir, userID string) {
	_ = os.Remove(filepath.Join(dir, userID+".jpg"))
}

// ServeAvatar serves avatar files from dir with a long immutable cache
// (the ?v= query in the stored URL changes on update, so caching the
// content forever per-URL is safe). The {name} param is allowlisted to
// "{uuid}.jpg" so it can't traverse out of dir.
func ServeAvatar(dir string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		name := chi.URLParam(r, "name")
		if !nameRe.MatchString(name) {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		http.ServeFile(w, r, filepath.Join(dir, name))
	}
}
