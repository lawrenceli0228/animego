import type { Metadata, Viewport } from "next";
import Navbar from "@/components/layout/Navbar";
import Footer from "@/components/layout/Footer";
import { getDict, getLang } from "@/lib/i18n";
import { apiGet, ApiError } from "@/lib/api";
import "./globals.css";

// SSR-side auth probe. `apiGet` (lib/api.ts) forwards the browser's
// session cookie via buildHeaders, so this request reaches Express
// /api/auth/me authenticated whenever the user has a valid session.
// 401 / network failure → fall back to anonymous Navbar.
interface NavUser {
  username: string;
  role?: string | null;
}
async function fetchCurrentUser(): Promise<NavUser | null> {
  try {
    const data = await apiGet<{ user?: NavUser }>("/api/auth/me", {
      cache: "no-store",
    });
    return data?.user ?? null;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    return null;
  }
}

// Root-level defaults applied to every route segment unless a child page
// overrides them. Per Next 16, `viewport` and `themeColor` MUST be exported
// from a separate `viewport` object (split from `metadata` in Next 14+).
//
// `metadataBase` lets child segments use relative paths in openGraph.images
// and alternates.canonical -- the production domain is animegoclub.com.
export const metadata: Metadata = {
  metadataBase: new URL("https://animegoclub.com"),
  title: {
    template: "%s . AnimeGo",
    default: "AnimeGo . 追你该追的那一话",
  },
  description:
    "把封面当主角的动漫站。多源聚合、弹幕同屏、手动选集兜底 -- 不做信息流推荐，不藏 VIP 集数。",
  applicationName: "AnimeGo",
  authors: [{ name: "AnimeGo" }],
  generator: "Next.js",
  keywords: [
    "动漫",
    "番剧",
    "追番",
    "弹幕",
    "AnimeGo",
    "anime",
    "danmaku",
    "OKLCH",
    "海报色",
    "字幕组",
    "本地播放器",
  ],
  robots: { index: true, follow: true },
  openGraph: {
    siteName: "AnimeGo",
    type: "website",
    locale: "zh_CN",
    alternateLocale: ["en_US"],
  },
  twitter: {
    card: "summary_large_image",
    site: "@animegoclub",
  },
  alternates: {
    canonical: "/",
    languages: {
      "zh-CN": "/",
      "en-US": "/?lang=en",
    },
  },
};

// Next 16: themeColor and colorScheme moved out of `metadata` into `viewport`.
// Project ships a dark theme by default, so we pin both here.
export const viewport: Viewport = {
  themeColor: "#000000",
  colorScheme: "dark",
};

type Season = "WINTER" | "SPRING" | "SUMMER" | "FALL";

function getCurrentSeason(): Season {
  const m = new Date().getMonth() + 1;
  if (m <= 3) return "WINTER";
  if (m <= 6) return "SPRING";
  if (m <= 9) return "SUMMER";
  return "FALL";
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const [lang, dict, user] = await Promise.all([
    getLang(),
    getDict(),
    fetchCurrentUser(),
  ]);
  const season = getCurrentSeason();
  const year = new Date().getFullYear();

  return (
    <html lang={lang === "en" ? "en" : "zh-CN"}>
      <body
        style={{
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <Navbar
          dict={dict}
          lang={lang}
          season={season}
          year={year}
          user={user}
        />
        <div style={{ flex: 1 }}>{children}</div>
        <Footer dict={dict} season={season} year={year} />
      </body>
    </html>
  );
}
