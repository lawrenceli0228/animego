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
// caller can't OOM the process with a giant base64 blob. The global 1MiB
// body limit already caps this well below the ceiling; it's a second line
// of defence in case the body limit is ever relaxed. The cropped client
// output is ~50-120KB.
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
	errNotImage    = errors.New("avatar: not a base64 image data URL")
	errUnsupported = errors.New("avatar: unsupported image format")
	errTooLarge    = errors.New("avatar: image too large")
	errDecode      = errors.New("avatar: could not decode image")
)

// IsBadImage reports whether err is a client-side validation failure (bad
// data URL / unsupported format / too large / undecodable) vs a server-side
// write failure. Lets the handler return 400 vs 500.
func IsBadImage(err error) bool {
	return errors.Is(err, errNotImage) || errors.Is(err, errUnsupported) ||
		errors.Is(err, errTooLarge) || errors.Is(err, errDecode)
}

// The predicates below let the handler return a precise 400 message instead
// of a single misleading "Photo is too large" for every validation failure.

// IsNotImage reports a malformed / non-image data URL.
func IsNotImage(err error) bool { return errors.Is(err, errNotImage) }

// IsUnsupportedFormat reports a data URL whose format we don't decode (only
// JPEG and PNG are accepted; the server always re-encodes to JPEG).
func IsUnsupportedFormat(err error) bool { return errors.Is(err, errUnsupported) }

// IsTooLarge reports an image past the byte or dimension ceiling.
func IsTooLarge(err error) bool { return errors.Is(err, errTooLarge) }

// Save decodes a data URL, validates + re-encodes it to JPEG, and writes
// it atomically to {dir}/{userID}.jpg. Returns the public URL (with a
// cache-busting ?v= so a changed photo is fetched fresh through CF).
func Save(dir, userID, dataURL string) (string, error) {
	raw, err := DecodeDataURL(dataURL)
	if err != nil {
		return "", err
	}
	img, err := DecodeImage(raw)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	if err := WriteJPEG(filepath.Join(dir, userID+".jpg"), img); err != nil {
		return "", err
	}
	return fmt.Sprintf("/api/avatars/%s.jpg?v=%d", userID, time.Now().Unix()), nil
}

// DecodeDataURL checks a "data:image/...;base64," URL the way an avatar
// upload is checked -- a JPEG or PNG declared, valid base64 (wrapped lines
// allowed), at most maxDecodedBytes -- and returns the decoded bytes.  What
// the bytes really are is DecodeImage's question.
//
// Shared with internal/edits, whose photo uploads follow this pipeline.
func DecodeDataURL(dataURL string) ([]byte, error) {
	comma := strings.IndexByte(dataURL, ',')
	if comma < 0 {
		return nil, errNotImage
	}
	meta := dataURL[:comma]
	if !strings.HasPrefix(meta, "data:image/") || !strings.Contains(meta, "base64") {
		return nil, errNotImage
	}
	// Allowlist only the formats we have decoders for. The MIME prefix alone
	// could claim gif/webp, which image.Decode can't read — that would fail
	// later with a misleading "decode" error. The server re-encodes to JPEG
	// regardless, so JPEG + PNG input is all we need.
	if !strings.HasPrefix(meta, "data:image/jpeg") && !strings.HasPrefix(meta, "data:image/png") {
		return nil, errUnsupported
	}
	// Some canvas/base64 producers wrap the payload at 76 cols; StdEncoding
	// rejects embedded newlines, so strip ASCII whitespace before decoding.
	payload := strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' || r == '\t' || r == ' ' {
			return -1
		}
		return r
	}, dataURL[comma+1:])
	raw, err := base64.StdEncoding.DecodeString(payload)
	if err != nil {
		return nil, errDecode
	}
	if len(raw) > maxDecodedBytes {
		return nil, errTooLarge
	}
	return raw, nil
}

// DecodeImage reads image bytes: at most maxDecodedBytes, JPEG or PNG by
// what the bytes are (not by what the caller or a Content-Type claimed),
// at most maxDimension on a side -- read from the header before a pixel is
// allocated -- then the bitmap.
//
// Shared with internal/edits, which feeds it uploads and fetched links.
func DecodeImage(raw []byte) (image.Image, error) {
	if len(raw) > maxDecodedBytes {
		return nil, errTooLarge
	}
	// Read just the header to get dimensions BEFORE decoding the full bitmap.
	// image.Decode allocates width*height*4 bytes of RGBA up front, so a
	// small but highly compressed file (a "decompression bomb") could balloon
	// to tens of MB and OOM the container. DecodeConfig is cheap and lets us
	// reject oversized images without ever allocating the pixel buffer.
	cfg, format, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil {
		return nil, errDecode
	}
	// Any decoder another package registers would answer here too; only the
	// two this pipeline promises are let through.
	if format != "jpeg" && format != "png" {
		return nil, errUnsupported
	}
	if cfg.Width > maxDimension || cfg.Height > maxDimension {
		return nil, errTooLarge
	}

	img, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil, errDecode
	}
	return img, nil
}

// WriteJPEG re-encodes img as a JPEG -- which keeps the pixels and drops
// everything else a file can carry (EXIF, location, ICC, trailing bytes) --
// and writes it to path atomically: a temporary file beside it, renamed
// over it.  The directory must exist.
func WriteJPEG(path string, img image.Image) error {
	tmp := path + ".tmp"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	if err := jpeg.Encode(f, img, &jpeg.Options{Quality: jpegQuality}); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, path); err != nil { // atomic replace
		os.Remove(tmp)
		return err
	}
	return nil
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
