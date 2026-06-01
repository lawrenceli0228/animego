import type { Metadata, Viewport } from "next";
import { Sora, DM_Sans, JetBrains_Mono } from "next/font/google";
import { Toaster } from "react-hot-toast";
import Navbar from "@/components/layout/Navbar";
import Footer from "@/components/layout/Footer";
import { getDict, getDictByLang, getLang } from "@/lib/i18n";
import { LanguageProvider } from "@/lib/lang-client";
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

// ISR islanding: the Navbar auth state is no longer fetched server-side
// here (that no-store /api/auth/me call forced every page dynamic). The
// Navbar ("use client") fetches its own user on mount — see Navbar.tsx.

export async function generateMetadata(): Promise<Metadata> {
  const lang = await getLang();
  const dict = getDictByLang(lang);
  // proxy.ts injects x-pathname on every request so this RSC can build a
  // self-referential canonical + hreflang per route (#41).
  // ISR islanding: no x-pathname header read (would force dynamic). SEO
  // pages set their own self-canonical in their generateMetadata from
  // route params; pages without one self-canonicalise at the URL.
  const pathname: string | null = null;
  return {
    metadataBase: new URL("https://animegoclub.com"),
    title: {
      template: "%s . AnimeGoClub",
      default: dict.meta.titleDefault,
    },
    description: dict.meta.description,
    applicationName: "AnimeGoClub",
    authors: [{ name: "AnimeGoClub" }],
    generator: "Next.js",
    keywords: dict.meta.keywords,
    robots: { index: true, follow: true },
    icons: {
      // favicon.ico is the app/ file convention; apple-touch-icon (180×180,
      // reused from the legacy site) has no file convention so declare it.
      apple: "/apple-touch-icon.png",
    },
    openGraph: {
      siteName: "AnimeGoClub",
      type: "website",
      locale: lang === "en" ? "en_US" : "zh_CN",
      alternateLocale: lang === "en" ? ["zh_CN"] : ["en_US"],
      // Site-wide default share card (1200×630, reused from the legacy
      // site's og-default.png). Pages with their own image (e.g. anime
      // detail) override this via their own openGraph.images.
      images: ["/og-default.png"],
    },
    twitter: {
      card: "summary_large_image",
      site: "@animegoclub",
      images: ["/og-default.png"],
    },
    // Self-referential canonical + hreflang per route (#41). Each page
    // canonicalises to ITSELF via x-pathname — NOT the homepage (the bug the
    // old blanket canonical:"/" caused). Pages that set their own alternates
    // (home/welcome/seasonal/anime/faq/calendar/...) override this. If
    // x-pathname is absent, omit alternates and let Google self-canonicalise
    // — never re-introduce a "/"-pointing default.
    ...(pathname
      ? {
          alternates: {
            canonical: pathname,
            languages: {
              "zh-CN": pathname,
              "en-US": `${pathname}?lang=en`,
            },
          },
        }
      : {}),
  };
}

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
  const [lang, dict] = await Promise.all([getLang(), getDict()]);
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
        <LanguageProvider lang={lang}>
          <Navbar season={season} year={year} />
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
          <div style={{ flex: 1 }}>{children}</div>
          <Footer dict={dict} season={season} year={year} />
        </LanguageProvider>
      </body>
    </html>
  );
}
