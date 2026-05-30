import type { Metadata, Viewport } from "next";
import { Sora, DM_Sans, JetBrains_Mono } from "next/font/google";
import { Toaster } from "react-hot-toast";
import Navbar from "@/components/layout/Navbar";
import Footer from "@/components/layout/Footer";
import { getDict, getLang } from "@/lib/i18n";
import { LanguageProvider } from "@/lib/lang-client";
import { apiGet, ApiError } from "@/lib/api";
import "./globals.css";

const sora = Sora({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700", "800"],
  variable: "--font-display",
  display: "swap",
  preload: true,
});

const dmSans = DM_Sans({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600"],
  style: ["normal", "italic"],
  variable: "--font-sans",
  display: "swap",
  preload: true,
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
  display: "swap",
  preload: false,
});

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
    <html
      lang={lang === "en" ? "en" : "zh-CN"}
      className={`${sora.variable} ${dmSans.variable} ${jetbrainsMono.variable}`}
    >
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
        <Toaster
          position="top-center"
          toastOptions={{
            duration: 3500,
            style: {
              background: "#141414",
              color: "#fff",
              border: "1px solid rgba(255,255,255,0.08)",
            },
          }}
        />
        <div style={{ flex: 1 }}>
          <LanguageProvider lang={lang}>{children}</LanguageProvider>
        </div>
        <Footer dict={dict} season={season} year={year} />
      </body>
    </html>
  );
}
