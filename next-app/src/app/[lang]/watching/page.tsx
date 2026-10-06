import type { Metadata } from "next";
import type { CSSProperties } from "react";
import { redirect } from "next/navigation";
import { authHrefWithFrom } from "@/components/auth/authFromLink";
import { currentSeasonHref } from "@/components/anime/continueWatchingState";
import scope from "@/components/home/HomeHueScope.module.css";
import WatchingList from "@/components/watching/WatchingList";
import styles from "@/components/watching/WatchingList.module.css";
import { pageToneVars } from "@/lib/home/tone";
import { continueCards } from "@/lib/home/viewModels";
import { localizePath } from "@/lib/i18n/locale";
import { resolveLocale } from "@/lib/i18n/route";
import { fetchWatching } from "@/lib/schedule/fetch";
import { buildAlternates } from "@/lib/seo/alternates";
import { watchingPageHue, watchingPageState } from "@/lib/watching/view";

// 全部在追 — every show the signed-in reader is watching, as 继续看 cards.
// Both "全部在追" links lead here: the homepage's 继续看 header and the
// schedule page's 我追的 · 本周. /profile, with its status tabs, is unchanged.
//
// dynamic = "force-dynamic", like the homepage: the list is the reader's own,
// read here on the server with their cookie (lib/schedule/fetch.ts, the same
// read the homepage makes) — never by a client island after hydration, which
// is what broke signed-in state on the homepage three times. No cookie is
// read during a client render, and nothing here requests anything from the
// browser.
//
// Anonymous visitors never reach this render: proxy.ts gates /watching the
// way it gates /profile and sends them to /login?from=/watching. A session
// the proxy accepted but the API refuses goes the same way, from here. No
// loading.tsx on purpose: inside its Suspense boundary that redirect would
// degrade into a client-side navigation behind an HTTP 200.
export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: PageProps<"/[lang]/watching">): Promise<Metadata> {
  const { locale, dict } = await resolveLocale(params);
  return {
    title: dict.watchingPage.title,
    // A reader's own list: nothing here belongs in a search index.
    robots: { index: false, follow: false },
    alternates: buildAlternates("/watching", locale),
  };
}

/**
 * This request's render time, for "上次观看 3 天前" — a helper rather than
 * Date.now() in the component body, which react-hooks/purity rejects.
 */
function requestTime(): number {
  return Date.now();
}

export default async function WatchingPage({ params }: PageProps<"/[lang]/watching">) {
  const [{ dict, lang, locale }, watching] = await Promise.all([resolveLocale(params), fetchWatching()]);
  const loginHref = authHrefWithFrom("/login", localizePath("/watching", locale));

  const state = watchingPageState(watching);
  if (state === "signed-out") redirect(loginHref);

  const cards = continueCards(watching.items, lang);
  return (
    <main className={`${scope.scope} ${styles.page}`} style={pageToneVars(watchingPageHue(cards)) as unknown as CSSProperties}>
      <WatchingList
        state={state}
        cards={cards}
        dict={dict}
        lang={lang}
        nowMs={requestTime()}
        seasonHref={currentSeasonHref()}
        loginHref={loginHref}
      />
    </main>
  );
}
