// 继续看 — the signed-in reader's watching list, first on the homepage after
// the hero. Server component: the data is fetched by the page (in parallel
// with everything else, not as a second round trip after it) and passed in.
//
// Three states, as before:
//   - anonymous (401/network)  → the 我的库 explainer, with a log-in CTA
//   - signed in, nothing       → the same explainer, pointing at the library
//   - signed in, rows          → the cards
//
// The account-specific states sit inside SignedOutGate: logout does not
// navigate, so without it a shared machine would keep showing the previous
// reader's list under a "log in" navbar.
//
// The first row is the large card (its banner, progress, "继续看第 N 集"); the
// next two are compact. The cards themselves are components/home/ContinueCards
// — the 全部在追 page (/watching), which the header's link opens, draws the
// same ones for every show in the list.

import LibraryExplainer from "@/components/home/LibraryExplainer";
import SectionHeader from "@/components/home/SectionHeader";
import { ContinueCompactCard, ContinueFeatureCard } from "@/components/home/ContinueCards";
import section from "@/components/home/section.module.css";
import styles from "@/components/home/ContinueWatching.module.css";
import type { Dict, Lang } from "@/lib/i18n";
import type { ContinueCard } from "@/lib/home/viewModels";
import SignedOutGate from "./SignedOutGate";

const SHOWN = 3;

interface ContinueWatchingProps {
  items: ContinueCard[];
  loggedOut: boolean;
  dict: Dict;
  lang: Lang;
  nowMs: number;
  seasonHref: string;
}

export default function ContinueWatching({ items, loggedOut, dict, lang, nowMs, seasonHref }: ContinueWatchingProps) {
  const visitor = <LibraryExplainer dict={dict} variant="visitor" seasonHref={seasonHref} />;
  if (loggedOut) return visitor;
  if (items.length === 0) {
    return (
      <SignedOutGate signedOut={visitor}>
        <LibraryExplainer dict={dict} variant="empty" seasonHref={seasonHref} />
      </SignedOutGate>
    );
  }

  const [first, ...rest] = items.slice(0, SHOWN);
  return (
    <SignedOutGate signedOut={visitor}>
      <section className={`${section.section} ${section.first}`} aria-labelledby="home-continue">
        <SectionHeader
          id="home-continue"
          title={dict.home.continueTitle}
          count={items.length}
          link={{ href: "/watching", label: dict.home.continueAll }}
        />
        <div className={styles.row} data-count={1 + rest.length}>
          <ContinueFeatureCard c={first} dict={dict} lang={lang} nowMs={nowMs} />
          {rest.map((c) => (
            <ContinueCompactCard key={c.id} c={c} dict={dict} lang={lang} nowMs={nowMs} />
          ))}
        </div>
      </section>
    </SignedOutGate>
  );
}
