package edits

import (
	"context"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"syscall"
	"time"
)

// A linked photo is fetched once, when the edit is submitted, and from then
// on handled exactly like an upload: decoded, re-encoded and stored on our
// volume, shown to the admin from there, and published from there if it is
// accepted.  The page never points at the link.
//
// Why not store the link: what an admin approves would not be what readers
// later see -- the host can swap the file, or start serving something else
// at the same address, after the review.  A hotlink also hands every reader
// of the page to a third party, breaks when the host goes away, and is
// unreachable for readers whose network blocks it.  Why not proxy it on
// every read: the same objections, plus a fetch of an outside address on
// every page view.  One guarded fetch at submission is the only time the
// server reaches out, and the link is kept beside the stored copy as the
// image's source.
//
// The guards, in the order they apply:
//
//   - the link: https, port 443, no credentials, a host name (not an
//     address: decimal, octal and v6 spellings of internal addresses all
//     parse as addresses), not localhost or an internal zone;
//   - every connection, after DNS: the address actually dialled must be a
//     public unicast address on port 443 -- checked in the dialer, so a name
//     that resolves to an internal address, or is re-pointed at one between
//     a check and the connection, is refused all the same;
//   - redirects: at most maxRedirects, each one re-checked as a link;
//   - the answer: 200, Content-Type image/jpeg or image/png, at most
//     maxFetchBytes (the body is read through a limit, whatever
//     Content-Length claims), within fetchTimeout;
//   - then the bytes are decoded as a JPEG or PNG by what they are
//     (avatars.DecodeImage), whatever the header said.
//
// No proxy from the environment is used: an HTTP(S)_PROXY would carry the
// request past the dial check.

const (
	fetchTimeout   = 10 * time.Second
	maxFetchBytes  = 6 << 20
	maxRedirects   = 3
	maxImageURLLen = 2000
)

var (
	// errImageLink: the link, or an address it led to, is not one we fetch.
	errImageLink = errors.New("edits: image link refused")
	// errImageFetch: the fetch failed (unreachable, refused, not 200, a bad
	// redirect, too slow).
	errImageFetch = errors.New("edits: image could not be fetched")
	// errImageType: the answer is not a JPEG or PNG.
	errImageType = errors.New("edits: link is not a JPEG or PNG image")
	// errImageTooLarge: more bytes than maxFetchBytes.
	errImageTooLarge = errors.New("edits: image too large")
)

// internalSuffixes are name suffixes that only resolve inside a network.
var internalSuffixes = []string{".localhost", ".local", ".internal", ".lan", ".home.arpa", ".intranet", ".corp"}

// checkImageURL validates a submitted image link and returns it parsed,
// without its fragment.
func checkImageURL(raw string) (*url.URL, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" || len(raw) > maxImageURLLen {
		return nil, errImageLink
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Opaque != "" || u.Host == "" {
		return nil, errImageLink
	}
	if port := u.Port(); port != "" && port != "443" {
		return nil, errImageLink
	}
	host := strings.TrimSuffix(strings.ToLower(u.Hostname()), ".")
	if host == "" || !strings.Contains(host, ".") || net.ParseIP(host) != nil {
		return nil, errImageLink
	}
	for _, suffix := range internalSuffixes {
		if strings.HasSuffix(host, suffix) {
			return nil, errImageLink
		}
	}
	u.Fragment = ""
	u.RawFragment = ""
	return u, nil
}

// blockedPrefixes are the ranges netip's predicates do not already cover
// that must never be fetched from: shared, reserved, documentation and
// benchmark space, and the v6 prefixes that embed a v4 address.
var blockedPrefixes = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"),
	netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("64:ff9b::/96"),
	netip.MustParsePrefix("64:ff9b:1::/48"),
	netip.MustParsePrefix("100::/64"),
	netip.MustParsePrefix("2001:db8::/32"),
	netip.MustParsePrefix("2002::/16"),
	netip.MustParsePrefix("fec0::/10"),
}

// publicAddr reports whether a is an address the fetcher may connect to.
func publicAddr(a netip.Addr) bool {
	a = a.Unmap()
	if !a.IsValid() || a.IsLoopback() || a.IsPrivate() || a.IsUnspecified() ||
		a.IsLinkLocalUnicast() || a.IsLinkLocalMulticast() || a.IsInterfaceLocalMulticast() ||
		a.IsMulticast() || a == netip.AddrFrom4([4]byte{255, 255, 255, 255}) {
		return false
	}
	for _, p := range blockedPrefixes {
		if p.Contains(a) {
			return false
		}
	}
	return true
}

// guardDial is the dialer's Control hook: it runs for every connection
// attempt with the address about to be connected to.
func guardDial(_, address string, _ syscall.RawConn) error {
	host, port, err := net.SplitHostPort(address)
	if err != nil || port != "443" {
		return errImageLink
	}
	a, err := netip.ParseAddr(host)
	if err != nil || !publicAddr(a) {
		return errImageLink
	}
	return nil
}

// Fetcher fetches submitted image links under the guards above.
type Fetcher struct {
	client *http.Client
}

// NewFetcher returns the production fetcher.
func NewFetcher() *Fetcher {
	dialer := &net.Dialer{Timeout: 5 * time.Second, Control: guardDial}
	transport := &http.Transport{
		Proxy:                  nil,
		DialContext:            dialer.DialContext,
		ForceAttemptHTTP2:      true,
		TLSHandshakeTimeout:    5 * time.Second,
		ResponseHeaderTimeout:  8 * time.Second,
		MaxResponseHeaderBytes: 64 << 10,
		MaxIdleConns:           4,
		IdleConnTimeout:        30 * time.Second,
	}
	return &Fetcher{client: &http.Client{
		Transport: transport,
		Timeout:   fetchTimeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= maxRedirects {
				return errImageLink
			}
			if _, err := checkImageURL(req.URL.String()); err != nil {
				return err
			}
			return nil
		},
	}}
}

// Fetch returns the bytes at link, or an error wrapping one of errImageLink,
// errImageFetch, errImageType or errImageTooLarge.
func (f *Fetcher) Fetch(ctx context.Context, link string) ([]byte, error) {
	u, err := checkImageURL(link)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, errImageLink
	}
	req.Header.Set("Accept", "image/jpeg, image/png")
	req.Header.Set("User-Agent", "AnimeGoClub-image-check/1.0")
	resp, err := f.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errImageFetch, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%w: status %d", errImageFetch, resp.StatusCode)
	}
	mediaType, _, err := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	if err != nil || (mediaType != "image/jpeg" && mediaType != "image/png" && mediaType != "image/jpg") {
		return nil, errImageType
	}
	if resp.ContentLength > maxFetchBytes {
		return nil, errImageTooLarge
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxFetchBytes+1))
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errImageFetch, err)
	}
	if len(body) > maxFetchBytes {
		return nil, errImageTooLarge
	}
	return body, nil
}
