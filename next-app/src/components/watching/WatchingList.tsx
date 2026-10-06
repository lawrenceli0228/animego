// 全部在追 (/watching): every show the reader is watching, each as the same
// card the homepage's 继续看 section leads with — banner, status, progress,
// "继续看第 N 集" — in the order 继续看 uses (most recently updated first).
//
// Server component. The list was read by the page, on the server, with the
// reader's cookie; nothing here fetches, and an anonymous visitor never gets
// this far (the route is behind the sign-in gate in proxy.ts).
//
// The account-specific part sits inside SignedOutGate, as on the homepage:
// logout does not navigate, so without it a shared machine would keep showing
// the previous reader's list under a "log in" header.

import type { ReactNode } from "react";
import Link from "@/components/ui/LocaleLink";
import SignedOutGate from "@/components/anime/SignedOutGate";
import { ContinueFeatureCard } from "@/components/home/ContinueCards";
import { ArrowIcon, ChevronIcon } from "@/components/home/icons";
import type { Dict, Lang } from "@/lib/i18n";
import { fillTemplate } from "@/lib/home/time";
import type { ContinueCard } from "@/lib/home/viewModels";
import type { WatchingPageState } from "@/lib/watching/view";
import styles from "./WatchingList.module.css";

/** Cards above the fold on a wide screen load eagerly: they are the page. */
const EAGER_CARDS = 2;

interface WatchingListProps {
  state: Exclude<WatchingPageState, "signed-out">;
  cards: ContinueCard[];
  dict: Dict;
  lang: Lang;
  /** The request's render time, for "上次观看 3 天前". */
  nowMs: number;
  /** The current season's page: where to find something to watch. */
  seasonHref: string;
  /** /login, carrying this page as `from`. */
  loginHref: string;
}

export default function WatchingList({ state, cards, dict, lang, nowMs, seasonHref, loginHref }: WatchingListProps) {
  const header = (sub: ReactNode, manage: boolean) => (
    <header className={styles.header}>
      <div className={styles.heading}>
        <span className={styles.eyebrow}>{dict.nav.myList}</span>
        <h1 className={styles.title}>{dict.watchingPage.title}</h1>
        {sub ? <p className={styles.summary}>{sub}</p> : null}
      </div>
      {manage ? (
        <Link href="/profile" prefetch={false} className={styles.manage}>
          {dict.watchingPage.manage}
          <ChevronIcon className={styles.manageIcon} />
        </Link>
      ) : null}
    </header>
  );

  const signedOut = (
    <>
      {header(null, false)}
      <div className={styles.panel}>
        <p className={styles.panelTitle}>{dict.watchingPage.signedOut}</p>
        <Link href={loginHref} prefetch={false} className={styles.cta}>
          {dict.watchingPage.signIn}
        </Link>
      </div>
    </>
  );

  if (state === "unavailable") {
    return (
      <SignedOutGate signedOut={signedOut}>
        {header(null, true)}
        <p className={styles.failed}>{dict.watchingPage.loadFailed}</p>
      </SignedOutGate>
    );
  }

  if (state === "empty") {
    return (
      <SignedOutGate signedOut={signedOut}>
        {header(null, true)}
        <div className={styles.panel}>
          <p className={styles.panelTitle}>{dict.home.watchingEmptyTitle}</p>
          <p className={styles.panelBody}>{dict.home.watchingEmptyBody}</p>
          <Link href={seasonHref} prefetch={false} className={styles.cta}>
            {dict.home.watchingEmptyCta}
            <ArrowIcon className={styles.ctaIcon} />
          </Link>
        </div>
      </SignedOutGate>
    );
  }

  const sub = [fillTemplate(dict.watchingPage.count, { n: cards.length }), dict.watchingPage.order].join(" · ");
  return (
    <SignedOutGate signedOut={signedOut}>
      {header(sub, true)}
      <ul className={styles.grid}>
        {cards.map((c, i) => (
          <li key={c.id} className={styles.item}>
            <ContinueFeatureCard c={c} dict={dict} lang={lang} nowMs={nowMs} priority={i < EAGER_CARDS} />
          </li>
        ))}
      </ul>
    </SignedOutGate>
  );
}
