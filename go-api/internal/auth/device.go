package auth

// device.go — what a session was signed in with (migration 0053): the
// request's User-Agent and Cloudflare's visitor-location headers, cleaned
// for storage, and the User-Agent parsed into the "Mac · Chrome" the
// settings page's device list shows.

import (
	"net/http"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Column limits, matching migration 0053's CHECKs.
const (
	maxUserAgentLen = 512
	maxCityLen      = 80
)

// clientInfo is a request's device columns, each nil when the request does
// not state it or states something that fails validation.
type clientInfo struct {
	UserAgent *string
	Country   *string
	City      *string
}

var countryCode = regexp.MustCompile(`^[A-Z]{2}$`)

// clientInfoFrom reads the device columns off a request.
//
// The location headers are trusted as far as the device list needs: the
// origin only accepts Cloudflare's addresses, and Cloudflare sets
// CF-IPCountry itself.  CF-IPCity comes from a managed transform that may be
// off, in which case a client could send its own — which would only relabel
// its own session in its own device list, as text.  "XX" (unknown) and "T1"
// (Tor) are Cloudflare's non-answers and are dropped.
func clientInfoFrom(r *http.Request) clientInfo {
	var info clientInfo
	if ua := cleanText(r.UserAgent(), maxUserAgentLen); ua != "" {
		info.UserAgent = &ua
	}
	if cc := strings.ToUpper(strings.TrimSpace(r.Header.Get("CF-IPCountry"))); countryCode.MatchString(cc) && cc != "XX" && cc != "T1" {
		info.Country = &cc
	}
	if city := cleanText(r.Header.Get("CF-IPCity"), maxCityLen); city != "" {
		info.City = &city
	}
	return info
}

// cleanText drops invalid UTF-8 and control characters, trims, and cuts to
// max characters.
func cleanText(s string, max int) string {
	if !utf8.ValidString(s) {
		s = strings.ToValidUTF8(s, "")
	}
	s = strings.TrimSpace(strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, s))
	if utf8.RuneCountInString(s) > max {
		s = string([]rune(s)[:max])
	}
	return strings.TrimSpace(s)
}

// Device is a User-Agent as the device list names it.  Kind picks the icon;
// OS and Browser are display names the frontend localises where it needs to
// ("WeChat" → 微信).  Empty means "could not tell".
type Device struct {
	Kind    string
	OS      string
	Browser string
}

// Device kinds.
const (
	KindLaptop  = "laptop"
	KindDesktop = "desktop"
	KindPhone   = "phone"
	KindTablet  = "tablet"
	KindUnknown = "unknown"
)

// ParseUserAgent names a device from its User-Agent.  Deliberately small:
// it only has to tell a person's own devices apart, not identify them.
//
// What it cannot tell: an iPad in Safari's default desktop mode reports
// itself as a Mac, and a Mac is assumed to be a laptop and a Windows or
// Linux machine a desktop — the header carries neither fact.
func ParseUserAgent(ua string) Device {
	d := Device{Kind: KindUnknown, OS: osOf(ua), Browser: browserOf(ua)}
	switch d.OS {
	case "iPhone":
		d.Kind = KindPhone
	case "iPad":
		d.Kind = KindTablet
	case "Android", "HarmonyOS":
		d.Kind = KindTablet
		if strings.Contains(ua, "Mobile") {
			d.Kind = KindPhone
		}
	case "Mac", "ChromeOS":
		d.Kind = KindLaptop
	case "Windows", "Linux":
		d.Kind = KindDesktop
	}
	return d
}

func osOf(ua string) string {
	switch {
	case strings.Contains(ua, "iPhone"), strings.Contains(ua, "iPod"):
		return "iPhone"
	case strings.Contains(ua, "iPad"):
		return "iPad"
	case strings.Contains(ua, "HarmonyOS"), strings.Contains(ua, "OpenHarmony"):
		return "HarmonyOS"
	case strings.Contains(ua, "Android"):
		return "Android"
	case strings.Contains(ua, "CrOS"):
		return "ChromeOS"
	case strings.Contains(ua, "Macintosh"), strings.Contains(ua, "Mac OS X"):
		return "Mac"
	case strings.Contains(ua, "Windows"):
		return "Windows"
	case strings.Contains(ua, "Linux"):
		return "Linux"
	}
	return ""
}

// browserOf checks the in-app and vendor browsers first: each of them also
// carries a "Chrome/" or "Safari/" token, which only identifies the engine.
func browserOf(ua string) string {
	switch {
	case strings.Contains(ua, "MicroMessenger"):
		return "WeChat"
	case strings.Contains(ua, "QQBrowser"), strings.Contains(ua, " QQ/"):
		return "QQ"
	case strings.Contains(ua, "UCBrowser"), strings.Contains(ua, "UCWEB"):
		return "UC"
	case strings.Contains(ua, "SamsungBrowser"):
		return "Samsung"
	case strings.Contains(ua, "Edg/"), strings.Contains(ua, "EdgA/"), strings.Contains(ua, "EdgiOS/"):
		return "Edge"
	case strings.Contains(ua, "OPR/"), strings.Contains(ua, "OPiOS/"), strings.Contains(ua, "Opera"):
		return "Opera"
	case strings.Contains(ua, "Firefox/"), strings.Contains(ua, "FxiOS/"):
		return "Firefox"
	case strings.Contains(ua, "CriOS/"), strings.Contains(ua, "Chrome/"):
		return "Chrome"
	case strings.Contains(ua, "Safari/") && strings.Contains(ua, "Version/"):
		return "Safari"
	}
	return ""
}
