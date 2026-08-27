import type { Metadata, Viewport } from "next";
import { Sora, DM_Sans, JetBrains_Mono } from "next/font/google";
import { Toaster } from "react-hot-toast";
import Navbar from "@/components/layout/Navbar";
import Footer from "@/components/layout/Footer";
import { LocaleHint } from "@/components/layout/LocaleHint";
import { StaleTabNotice } from "@/components/layout/StaleTabNotice";
import { ActivityBeacon } from "@/components/layout/ActivityBeacon";
import { LanguageProvider } from "@/lib/lang-client";
import { HTML_LANG, OG_LOCALE, alternateOgLocales } from "@/lib/i18n/lang";
import { localeParams, resolveLocale, type LangParams } from "@/lib/i18n/route";
import { SITE_ORIGIN } from "@/lib/seo/alternates";
import "../globals.css";

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

// Prerender one shell per locale. Without this the whole tree is dynamic:
// a `[param]` segment is `ƒ` unless something in it declares its params, and
// that would take /anime/[id] — the site's entire SEO surface and the only
// route Cloudflare edge-caches — down with it.
export function generateStaticParams() {
  return localeParams();
}

export async function generateMetadata({ params }: LangParams): Promise<Metadata> {
  const { lang, dict } = await resolveLocale(params);
  return {
    // Resolves every relative canonical and og URL on the site, including
    // the ones lib/seo/alternates.ts returns. Same constant, so a canonical
    // is genuinely self-referential rather than pointing at an origin we do
    // not serve.
    metadataBase: new URL(SITE_ORIGIN),
    title: {
      template: "%s . AnimeGoClub",
      default: dict.meta.titleDefault,
    },
    description: dict.meta.description,
    applicationName: "AnimeGoClub",
    authors: [{ name: "AnimeGoClub" }],
    generator: "Next.js",
    keywords: dict.meta.keywords,
    // No blanket `robots` directive.
    //
    // `index, follow` is what a crawler already assumes, so declaring it site-
    // wide bought nothing — and it cost something specific: it inherits down
    // into the not-found page, which emits its own `noindex`. Every 404 was
    // therefore served with two contradictory robots tags:
    //
    //     <meta name="robots" content="index, follow">
    //     <meta name="robots" content="noindex">
    //
    // Google resolves that conflict by taking the most restrictive value, so
    // the pages were not being indexed — but the guarantee rested on a
    // tie-break rule rather than on the page saying one thing. These routes
    // stream (see the loading.tsx note below), which means notFound() cannot
    // set a 404 status and `noindex` is the ONLY signal keeping a
    // non-existent anime out of the index. It should not have to win an
    // argument first.
    //
    // Removing it leaves normal pages with no robots tag, which is
    // index,follow by default, and leaves 404s with an unambiguous noindex.
    //
    // A page that genuinely needs restricting declares it for itself, and
    // most already did: /login, /register, /profile, /settings, /search
    // without a query, and the alias form of /u/[username]. The legal pages
    // set theirs through untranslatedRobots(locale).
    //
    // /smoke did not, and only looked covered because of the tag this
    // removes — it now declares its own noindex. That is worth noting as the
    // shape of the risk here: a blanket allow makes it impossible to tell a
    // page that decided to be indexable from one that never thought about it.
    icons: {
      // favicon.ico is the app/ file convention; apple-touch-icon (180×180,
      // reused from the legacy site) has no file convention so declare it.
      apple: "/apple-touch-icon.png",
    },
    openGraph: {
      siteName: "AnimeGoClub",
      type: "website",
      locale: OG_LOCALE[lang],
      alternateLocale: alternateOgLocales(lang),
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
    // No alternates here on purpose. This used to read a proxy-injected
    // x-pathname header to build a per-route canonical, but ISR islanding
    // removed the read — the header is still set, and `pathname` was left
    // pinned to null, so the block below it was a permanently false branch
    // that nonetheless read as a working blueprint. Its content was also the
    // wrong blueprint: a `?lang=en` alternate the server does not honour.
    //
    // Each route sets its own via lib/seo/alternates.ts, from route params
    // it already has. A page with none self-canonicalises at its URL, which
    // is correct; never re-introduce a blanket "/"-pointing default here.
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
  params,
}: Readonly<{ children: React.ReactNode } & LangParams>) {
  const { lang, dict } = await resolveLocale(params);
  const season = getCurrentSeason();
  const year = new Date().getFullYear();

  return (
    <html
      lang={HTML_LANG[lang]}
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
          {/* The two things on this site that appear without being asked
              for. They are siblings here and not stacked: LocaleHint is
              fixed to the top of the viewport and StaleTabNotice to the
              bottom, so a first-time visitor during a deploy can be shown
              both without one covering the other. Neither renders anything
              on the server. */}
          <LocaleHint />
          <StaleTabNotice />
          {/* Renders nothing. Reports one page view per navigation so the
              admin activity panel can count arrivals the server never sees —
              a soft navigation between two cached routes issues no request
              at all. Sends a coarse surface label, never the path. */}
          <ActivityBeacon />
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
