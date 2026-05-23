import type { Metadata, Viewport } from "next";
import { getLang } from "@/lib/i18n";
import "./globals.css";

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

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const lang = await getLang();
  return (
    <html lang={lang === "en" ? "en" : "zh-CN"}>
      <body>{children}</body>
    </html>
  );
}
