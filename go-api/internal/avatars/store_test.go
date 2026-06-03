package avatars

// Tests for the avatar pipeline. The package backs PATCH /api/auth/me photo
// uploads, so the decode guards here are a security boundary (decompression
// bomb, format allowlist) and the serve path is anti-traversal.
//
// Added by /qa on 2026-06-03 — the package shipped with no tests.

import (
	"bytes"
	"context"
	"encoding/base64"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// dataURL encodes img with the given encoder into a "data:image/{kind};base64,"
// URL, the wire shape the browser crop modal produces.
func dataURL(t *testing.T, kind string, raw []byte) string {
	t.Helper()
	return "data:image/" + kind + ";base64," + base64.StdEncoding.EncodeToString(raw)
}

func jpegBytes(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for x := 0; x < w; x++ {
		img.Set(x, 0, color.RGBA{R: uint8(x), G: 80, B: 160, A: 255})
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 90}); err != nil {
		t.Fatalf("encode jpeg: %v", err)
	}
	return buf.Bytes()
}

func TestSave_ValidJPEG_WritesFileAndURL(t *testing.T) {
	dir := t.TempDir()
	id := uuid.NewString()

	url, err := Save(dir, id, dataURL(t, "jpeg", jpegBytes(t, 200, 200)))
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	if !strings.HasPrefix(url, "/api/avatars/"+id+".jpg?v=") {
		t.Fatalf("unexpected url %q", url)
	}
	if _, err := os.Stat(filepath.Join(dir, id+".jpg")); err != nil {
		t.Fatalf("avatar file missing: %v", err)
	}
	// No temp file left behind after the atomic rename.
	if _, err := os.Stat(filepath.Join(dir, id+".jpg.tmp")); !os.IsNotExist(err) {
		t.Fatalf("temp file leaked: err=%v", err)
	}
}

func TestSave_PNGInput_ReEncodedToJPEG(t *testing.T) {
	dir := t.TempDir()
	id := uuid.NewString()
	img := image.NewRGBA(image.Rect(0, 0, 64, 64))
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("encode png: %v", err)
	}

	if _, err := Save(dir, id, dataURL(t, "png", buf.Bytes())); err != nil {
		t.Fatalf("Save png: %v", err)
	}
	// Stored file must be JPEG regardless of input format (EXIF stripped).
	f, err := os.Open(filepath.Join(dir, id+".jpg"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, format, err := image.DecodeConfig(f); err != nil || format != "jpeg" {
		t.Fatalf("stored format = %q err=%v, want jpeg", format, err)
	}
}

func TestSave_Base64WithNewlines_StillDecodes(t *testing.T) {
	dir := t.TempDir()
	id := uuid.NewString()
	b64 := base64.StdEncoding.EncodeToString(jpegBytes(t, 100, 100))
	// Wrap at 76 cols like MIME/older canvas encoders do.
	var wrapped strings.Builder
	for i := 0; i < len(b64); i += 76 {
		end := i + 76
		if end > len(b64) {
			end = len(b64)
		}
		wrapped.WriteString(b64[i:end])
		wrapped.WriteByte('\n')
	}
	if _, err := Save(dir, id, "data:image/jpeg;base64,"+wrapped.String()); err != nil {
		t.Fatalf("Save with wrapped base64: %v", err)
	}
}

func TestSave_OversizedDimensions_RejectedBeforeAllocation(t *testing.T) {
	dir := t.TempDir()
	id := uuid.NewString()
	// 4001px exceeds maxDimension (4000). DecodeConfig must reject this from
	// the header without allocating the full bitmap (decompression-bomb guard).
	_, err := Save(dir, id, dataURL(t, "jpeg", jpegBytes(t, 4001, 8)))
	if !IsTooLarge(err) {
		t.Fatalf("err = %v, want IsTooLarge", err)
	}
	if !IsBadImage(err) {
		t.Fatalf("IsBadImage(%v) = false, want true (→ 400)", err)
	}
}

func TestSave_UnsupportedFormat_GIF(t *testing.T) {
	dir := t.TempDir()
	id := uuid.NewString()
	img := image.NewPaletted(image.Rect(0, 0, 16, 16), []color.Color{color.Black, color.White})
	var buf bytes.Buffer
	if err := gif.Encode(&buf, img, nil); err != nil {
		t.Fatalf("encode gif: %v", err)
	}
	_, err := Save(dir, id, dataURL(t, "gif", buf.Bytes()))
	if !IsUnsupportedFormat(err) {
		t.Fatalf("err = %v, want IsUnsupportedFormat", err)
	}
}

func TestSave_NotADataURL(t *testing.T) {
	dir := t.TempDir()
	id := uuid.NewString()
	for _, in := range []string{"hello", "data:text/plain;base64,aGk=", "data:image/jpeg,nope"} {
		if _, err := Save(dir, id, in); !IsNotImage(err) {
			t.Fatalf("Save(%q) err = %v, want IsNotImage", in, err)
		}
	}
}

func TestSave_CorruptBase64_DecodeError(t *testing.T) {
	dir := t.TempDir()
	id := uuid.NewString()
	// Valid prefix, garbage payload that decodes to non-image bytes.
	_, err := Save(dir, id, "data:image/jpeg;base64,"+base64.StdEncoding.EncodeToString([]byte("not an image")))
	if !IsBadImage(err) {
		t.Fatalf("err = %v, want IsBadImage", err)
	}
}

func TestServeAvatar_RejectsTraversalAndServesValid(t *testing.T) {
	dir := t.TempDir()
	id := uuid.NewString()
	if _, err := Save(dir, id, dataURL(t, "jpeg", jpegBytes(t, 32, 32))); err != nil {
		t.Fatal(err)
	}
	h := ServeAvatar(dir)

	serve := func(name string) *httptest.ResponseRecorder {
		rctx := chi.NewRouteContext()
		rctx.URLParams.Add("name", name)
		req := httptest.NewRequest(http.MethodGet, "/api/avatars/x", nil).
			WithContext(context.WithValue(context.Background(), chi.RouteCtxKey, rctx))
		rec := httptest.NewRecorder()
		h(rec, req)
		return rec
	}

	if rec := serve(id + ".jpg"); rec.Code != http.StatusOK {
		t.Fatalf("valid avatar: code=%d", rec.Code)
	} else if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "image/jpeg") {
		t.Fatalf("content-type = %q, want image/jpeg", ct)
	} else if cc := rec.Header().Get("Cache-Control"); !strings.Contains(cc, "immutable") {
		t.Fatalf("cache-control = %q, want immutable", cc)
	}

	for _, bad := range []string{"../../etc/passwd", "..%2f..%2fpasswd", "foo.png", id + ".jpg.tmp", ""} {
		if rec := serve(bad); rec.Code != http.StatusNotFound {
			t.Fatalf("serve(%q) code=%d, want 404", bad, rec.Code)
		}
	}
}
