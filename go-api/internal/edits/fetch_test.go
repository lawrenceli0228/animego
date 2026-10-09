package edits

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"image"
	"image/color"
	"image/png"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestCheckImageURL(t *testing.T) {
	t.Parallel()
	for _, ok := range []string{
		"https://upload.wikimedia.org/wikipedia/commons/a/b.png",
		"https://example.org:443/a.jpg?x=1",
		"  https://Example.ORG/a.jpg#frag  ",
	} {
		u, err := checkImageURL(ok)
		assert.NoError(t, err, ok)
		if err == nil {
			assert.Empty(t, u.Fragment, "the fragment never leaves")
		}
	}
	for _, bad := range []string{
		"",
		"http://example.org/a.jpg",           // not https
		"ftp://example.org/a.jpg",            // not https
		"https://user:pw@example.org/a.jpg",  // credentials
		"https://example.org:8443/a.jpg",     // another port
		"https://127.0.0.1/a.jpg",            // an address, not a name
		"https://[::1]/a.jpg",                // an address, not a name
		"https://2130706433/a.jpg",           // a number is not a host name either
		"https://localhost/a.jpg",            // no dot
		"https://intranet/a.jpg",             // no dot
		"https://metadata.google.internal/x", // an internal zone
		"https://printer.local/a.jpg",
		"https://app.localhost/a.jpg",
		"https:///a.jpg",
		"https://example.org/" + string(make([]byte, maxImageURLLen)),
	} {
		_, err := checkImageURL(bad)
		assert.ErrorIs(t, err, errImageLink, bad)
	}
}

func TestPublicAddr(t *testing.T) {
	t.Parallel()
	for _, s := range []string{"8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "203.0.114.1"} {
		assert.True(t, publicAddr(netip.MustParseAddr(s)), s)
	}
	for _, s := range []string{
		"127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254",
		"100.64.0.1", "0.0.0.0", "0.1.2.3", "224.0.0.1", "255.255.255.255", "198.18.0.1",
		"192.0.2.1", "198.51.100.7", "203.0.113.9", "240.0.0.1", "192.0.0.8",
		"::1", "::", "fe80::1", "fc00::1", "fd12::1", "ff02::1", "2001:db8::1",
		"::ffff:127.0.0.1", "::ffff:10.0.0.1", "64:ff9b::a00:1", "2002:a00:1::1", "fec0::1",
	} {
		assert.False(t, publicAddr(netip.MustParseAddr(s)), s)
	}
}

func TestGuardDial(t *testing.T) {
	t.Parallel()
	assert.NoError(t, guardDial("tcp4", "8.8.8.8:443", nil))
	assert.ErrorIs(t, guardDial("tcp4", "8.8.8.8:80", nil), errImageLink, "only 443")
	assert.ErrorIs(t, guardDial("tcp4", "127.0.0.1:443", nil), errImageLink)
	assert.ErrorIs(t, guardDial("tcp6", "[fd00::1]:443", nil), errImageLink)
	assert.ErrorIs(t, guardDial("tcp4", "not-an-address", nil), errImageLink)
}

// The production fetcher refuses a loopback server however the link is
// spelled: the dial is checked against the address actually connected to,
// after DNS, which is what a rebinding name cannot get past.
func TestFetcher_RefusesInternalAddresses(t *testing.T) {
	t.Parallel()
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(pngBytes(t, 4, 4))
	}))
	t.Cleanup(srv.Close)

	f := NewFetcher()
	// localhost.direct-style names that resolve to 127.0.0.1 would pass the
	// URL check; the dial guard is what stops them.  Here the dialer is
	// pointed straight at the server's address under a public-looking name.
	dial := f.client.Transport.(*http.Transport).DialContext
	f.client.Transport.(*http.Transport).DialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
		return dial(ctx, network, srv.Listener.Addr().String())
	}
	_, err := f.Fetch(context.Background(), "https://images.example.org/a.png")
	assert.ErrorIs(t, err, errImageFetch)
}

// testFetcher is the production fetcher with its dialer pointed at srv and
// its TLS trusting srv's certificate (valid for example.com): every other
// rule -- the URL check, redirects, status, type, size -- is the real one.
func testFetcher(t *testing.T, srv *httptest.Server) *Fetcher {
	t.Helper()
	f := NewFetcher()
	pool := x509.NewCertPool()
	pool.AddCert(srv.Certificate())
	tr := f.client.Transport.(*http.Transport)
	tr.TLSClientConfig = &tls.Config{RootCAs: pool, ServerName: "example.com"}
	tr.DialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, network, srv.Listener.Addr().String())
	}
	return f
}

func pngBytes(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	img.Set(0, 0, color.RGBA{R: 200, A: 255})
	var buf bytes.Buffer
	require.NoError(t, png.Encode(&buf, img))
	return buf.Bytes()
}

func TestFetcher_StatusTypeSizeAndRedirects(t *testing.T) {
	t.Parallel()
	body := pngBytes(t, 8, 12)
	mux := http.NewServeMux()
	mux.HandleFunc("/ok.png", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(body)
	})
	mux.HandleFunc("/html", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte("<html></html>"))
	})
	mux.HandleFunc("/webp", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "image/webp")
		_, _ = w.Write(body)
	})
	mux.HandleFunc("/missing", http.NotFound)
	mux.HandleFunc("/huge", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "image/jpeg")
		_, _ = w.Write(make([]byte, maxFetchBytes+10))
	})
	mux.HandleFunc("/to-http", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://example.com/ok.png", http.StatusFound)
	})
	mux.HandleFunc("/hop", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "https://example.com/hop", http.StatusFound)
	})
	mux.HandleFunc("/to-ok", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "https://example.com/ok.png", http.StatusFound)
	})
	srv := httptest.NewTLSServer(mux)
	t.Cleanup(srv.Close)
	f := testFetcher(t, srv)
	ctx := context.Background()

	got, err := f.Fetch(ctx, "https://example.com/ok.png")
	require.NoError(t, err)
	assert.Equal(t, body, got)

	got, err = f.Fetch(ctx, "https://example.com/to-ok")
	require.NoError(t, err, "a redirect to another https link is followed")
	assert.Equal(t, body, got)

	for path, want := range map[string]error{
		"/html":    errImageType,
		"/webp":    errImageType,
		"/missing": errImageFetch,
		"/huge":    errImageTooLarge,
		"/to-http": errImageFetch,
		"/hop":     errImageFetch,
	} {
		_, err := f.Fetch(ctx, "https://example.com"+path)
		assert.ErrorIs(t, err, want, path)
	}
}

func TestFetcher_GivesUpOnASlowServer(t *testing.T) {
	t.Parallel()
	release := make(chan struct{})
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	t.Cleanup(func() { close(release); srv.Close() })
	f := testFetcher(t, srv)
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	_, err := f.Fetch(ctx, "https://example.com/slow.png")
	assert.True(t, errors.Is(err, errImageFetch), "%v", err)
}
