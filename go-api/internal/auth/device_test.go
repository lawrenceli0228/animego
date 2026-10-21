package auth

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestParseUserAgent(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name, ua string
		want     Device
	}{
		{"Mac Chrome",
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
			Device{KindLaptop, "Mac", "Chrome"}},
		{"Mac Safari",
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
			Device{KindLaptop, "Mac", "Safari"}},
		{"Windows Edge",
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0",
			Device{KindDesktop, "Windows", "Edge"}},
		{"Windows Firefox",
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0",
			Device{KindDesktop, "Windows", "Firefox"}},
		{"iPhone Safari",
			"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
			Device{KindPhone, "iPhone", "Safari"}},
		{"iPhone Chrome",
			"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0.6668.69 Mobile/15E148 Safari/604.1",
			Device{KindPhone, "iPhone", "Chrome"}},
		{"iPhone WeChat",
			"Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.50(0x1800323b) NetType/WIFI Language/zh_CN",
			Device{KindPhone, "iPhone", "WeChat"}},
		{"iPad Safari",
			"Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
			Device{KindTablet, "iPad", "Safari"}},
		{"Android Chrome phone",
			"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36",
			Device{KindPhone, "Android", "Chrome"}},
		{"Android tablet",
			"Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
			Device{KindTablet, "Android", "Chrome"}},
		{"Android WeChat",
			"Mozilla/5.0 (Linux; Android 13; V2244A Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/116.0.0.0 Mobile Safari/537.36 XWEB/1160065 MMWEBSDK/20240301 MicroMessenger/8.0.48.2580(0x28003036) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64",
			Device{KindPhone, "Android", "WeChat"}},
		{"Android QQ Browser",
			"Mozilla/5.0 (Linux; U; Android 12; zh-cn; PDKM00 Build/SP1A.210812.016) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/109.0.5414.86 MQQBrowser/14.9 Mobile Safari/537.36",
			Device{KindPhone, "Android", "QQ"}},
		{"Android UC",
			"Mozilla/5.0 (Linux; U; Android 12; zh-CN; V2148A Build/SP1A.210812.003) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/100.0.4896.58 UCBrowser/16.6.6.1300 Mobile Safari/537.36",
			Device{KindPhone, "Android", "UC"}},
		{"Samsung Internet",
			"Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36",
			Device{KindPhone, "Android", "Samsung"}},
		{"HarmonyOS",
			"Mozilla/5.0 (Phone; OpenHarmony 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36 ArkWeb/4.1.6.1 Mobile HuaweiBrowser/5.0.4.300",
			Device{KindPhone, "HarmonyOS", "Chrome"}},
		{"Linux Firefox",
			"Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0",
			Device{KindDesktop, "Linux", "Firefox"}},
		{"ChromeOS",
			"Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
			Device{KindLaptop, "ChromeOS", "Chrome"}},
		{"Opera",
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 OPR/114.0.0.0",
			Device{KindDesktop, "Windows", "Opera"}},
		{"curl", "curl/8.7.1", Device{KindUnknown, "", ""}},
		{"empty", "", Device{KindUnknown, "", ""}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := ParseUserAgent(tc.ua); got != tc.want {
				t.Errorf("ParseUserAgent(%q) = %+v, want %+v", tc.ua, got, tc.want)
			}
		})
	}
}

func TestClientInfoFrom(t *testing.T) {
	t.Parallel()
	str := func(p *string) string {
		if p == nil {
			return "<nil>"
		}
		return *p
	}
	tests := []struct {
		name                    string
		ua, country, city       string
		wantUA, wantC, wantCity string
	}{
		{"all present", "Mozilla/5.0 X", "cn", " Shanghai ", "Mozilla/5.0 X", "CN", "Shanghai"},
		{"nothing stated", "", "", "", "<nil>", "<nil>", "<nil>"},
		{"Cloudflare's unknown and Tor are not countries", "", "XX", "", "<nil>", "<nil>", "<nil>"},
		{"Tor", "", "T1", "", "<nil>", "<nil>", "<nil>"},
		{"not a country code", "", "CHN", "", "<nil>", "<nil>", "<nil>"},
		{"control characters are dropped", "a\x00b\nc", "", "Sha\x07nghai", "abc", "<nil>", "Shanghai"},
		{"only control characters is nothing", "\x01\x02", "", "\x03", "<nil>", "<nil>", "<nil>"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			r := httptest.NewRequest("POST", "/api/auth/login", nil)
			r.Header.Del("User-Agent")
			if tc.ua != "" {
				r.Header.Set("User-Agent", tc.ua)
			}
			if tc.country != "" {
				r.Header.Set("CF-IPCountry", tc.country)
			}
			if tc.city != "" {
				r.Header.Set("CF-IPCity", tc.city)
			}
			got := clientInfoFrom(r)
			if str(got.UserAgent) != tc.wantUA || str(got.Country) != tc.wantC || str(got.City) != tc.wantCity {
				t.Errorf("got ua=%q country=%q city=%q, want %q %q %q",
					str(got.UserAgent), str(got.Country), str(got.City), tc.wantUA, tc.wantC, tc.wantCity)
			}
		})
	}
}

// The columns' CHECKs cap the lengths; what is written must already fit,
// counted in characters, not bytes.
func TestClientInfoFrom_CutsToTheColumnLimits(t *testing.T) {
	t.Parallel()
	r := httptest.NewRequest("POST", "/api/auth/login", nil)
	r.Header.Set("User-Agent", strings.Repeat("浏", 600))
	r.Header.Set("CF-IPCity", strings.Repeat("市", 100))

	got := clientInfoFrom(r)

	if n := len([]rune(*got.UserAgent)); n != maxUserAgentLen {
		t.Errorf("user agent kept %d characters, want %d", n, maxUserAgentLen)
	}
	if n := len([]rune(*got.City)); n != maxCityLen {
		t.Errorf("city kept %d characters, want %d", n, maxCityLen)
	}
}
