package edits

import (
	"bytes"
	"context"
	"encoding/base64"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/lawrenceli0228/animego/go-api/internal/avatars"
)

func jpegDataURL(t *testing.T, w, h int) string {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for x := 0; x < w; x++ {
		img.Set(x, x%h, color.RGBA{R: 255, G: uint8(x), A: 255})
	}
	var buf bytes.Buffer
	require.NoError(t, jpeg.Encode(&buf, img, &jpeg.Options{Quality: 90}))
	return "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(buf.Bytes())
}

type stubFetcher struct {
	body []byte
	err  error
	got  string
	// When set, Fetch signals entered and then waits for release.
	entered chan struct{}
	release chan struct{}
}

func (f *stubFetcher) Fetch(_ context.Context, link string) ([]byte, error) {
	f.got = link
	if f.entered != nil {
		f.entered <- struct{}{}
		<-f.release
	}
	return f.body, f.err
}

func TestImageStore_UploadLifecycle(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	s := NewImageStore(root, "https://example.org/", nil)

	img, err := s.SaveUpload(jpegDataURL(t, 230, 345))
	require.NoError(t, err)
	assert.Regexp(t, imageNameRe, img.File)
	assert.Equal(t, 230, img.Width)
	assert.Equal(t, 345, img.Height)
	assert.Nil(t, img.Source)
	_, err = os.Stat(filepath.Join(root, "pending", img.File))
	require.NoError(t, err, "stored as pending")

	r := chi.NewRouter()
	r.Get("/api/edit-images/{name}", s.ServePublic())
	r.Get("/api/admin/edits/images/{name}", s.ServePending())
	get := func(path string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		return rec
	}

	assert.Equal(t, http.StatusNotFound, get("/api/edit-images/"+img.File).Code, "not public before it is accepted")
	pending := get("/api/admin/edits/images/" + img.File)
	require.Equal(t, http.StatusOK, pending.Code)
	assert.Equal(t, "private, no-store", pending.Header().Get("Cache-Control"))
	assert.Equal(t, "image/jpeg", pending.Header().Get("Content-Type"))
	assert.Equal(t, "nosniff", pending.Header().Get("X-Content-Type-Options"))

	url, err := s.Publish(img.File)
	require.NoError(t, err)
	assert.Equal(t, "https://example.org/api/edit-images/"+img.File, url)
	public := get("/api/edit-images/" + img.File)
	require.Equal(t, http.StatusOK, public.Code)
	assert.Equal(t, "public, max-age=31536000, immutable", public.Header().Get("Cache-Control"))
	decoded, err := jpeg.Decode(public.Body)
	require.NoError(t, err)
	assert.Equal(t, 230, decoded.Bounds().Dx())
	assert.Equal(t, http.StatusNotFound, get("/api/admin/edits/images/"+img.File).Code, "no longer pending")

	require.NoError(t, s.Unpublish(img.File))
	assert.Equal(t, http.StatusNotFound, get("/api/edit-images/"+img.File).Code)
	s.Discard(img.File)
	assert.Equal(t, http.StatusNotFound, get("/api/admin/edits/images/"+img.File).Code)

	for _, bad := range []string{"..%2Fpending%2F" + img.File, "x.jpg", "../../etc/passwd", img.File + ".png"} {
		assert.Equal(t, http.StatusNotFound, get("/api/edit-images/"+bad).Code, bad)
	}
}

func TestImageStore_LargeImagesAreScaledDown(t *testing.T) {
	t.Parallel()
	s := NewImageStore(t.TempDir(), "https://example.org", nil)
	img, err := s.SaveUpload(jpegDataURL(t, 2400, 3600))
	require.NoError(t, err)
	assert.Equal(t, 800, img.Width)
	assert.Equal(t, 1200, img.Height)
}

func TestImageStore_RefusesWhatIsNotJPEGOrPNG(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	pal := image.NewPaletted(image.Rect(0, 0, 8, 8), []color.Color{color.Black, color.White})
	var buf bytes.Buffer
	require.NoError(t, gif.Encode(&buf, pal, nil))

	f := &stubFetcher{body: buf.Bytes()}
	s := NewImageStore(root, "https://example.org", f)
	_, err := s.SaveLink(context.Background(), "https://example.org/a.png")
	assert.True(t, avatars.IsUnsupportedFormat(err), "a GIF served as a PNG: %v", err)

	_, err = s.SaveUpload("data:image/png;base64," + base64.StdEncoding.EncodeToString(buf.Bytes()))
	assert.True(t, avatars.IsUnsupportedFormat(err), "%v", err)

	entries, _ := os.ReadDir(filepath.Join(root, "pending"))
	assert.Empty(t, entries, "nothing refused is kept")
}

func TestImageStore_SaveLinkKeepsTheSource(t *testing.T) {
	t.Parallel()
	raw, err := base64.StdEncoding.DecodeString(jpegDataURL(t, 40, 60)[len("data:image/jpeg;base64,"):])
	require.NoError(t, err)
	f := &stubFetcher{body: raw}
	s := NewImageStore(t.TempDir(), "https://example.org", f)
	img, err := s.SaveLink(context.Background(), " https://example.org/a.jpg ")
	require.NoError(t, err)
	require.NotNil(t, img.Source)
	assert.Equal(t, "https://example.org/a.jpg", *img.Source)
	assert.Equal(t, " https://example.org/a.jpg ", f.got)

	f.err = errImageTooLarge
	_, err = s.SaveLink(context.Background(), "https://example.org/b.jpg")
	assert.ErrorIs(t, err, errImageTooLarge)
}

func TestFitWithin(t *testing.T) {
	t.Parallel()
	small := image.NewRGBA(image.Rect(0, 0, 100, 50))
	assert.Same(t, small, fitWithin(small, 1200), "small enough: untouched")

	wide := image.NewRGBA(image.Rect(0, 0, 3000, 1000))
	for x := 0; x < 3000; x++ {
		for y := 0; y < 1000; y++ {
			wide.Set(x, y, color.RGBA{R: 200, G: 100, B: 50, A: 255})
		}
	}
	out := fitWithin(wide, 1200)
	assert.Equal(t, image.Rect(0, 0, 1200, 400), out.Bounds())
	r, g, b, _ := out.At(600, 200).RGBA()
	assert.Equal(t, []uint32{200, 100, 50}, []uint32{r >> 8, g >> 8, b >> 8}, "a flat colour stays that colour")

	offset := image.NewRGBA(image.Rect(10, 10, 2410, 4810))
	out = fitWithin(offset, 1200)
	assert.Equal(t, image.Rect(0, 0, 600, 1200), out.Bounds(), "a source not at the origin")
}
