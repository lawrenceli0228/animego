// 我的库 — what a visitor (or a reader with nothing in progress) sees where a
// signed-in reader sees 继续看. It explains the one thing this site does that
// the catalogue sites do not: local files, played with danmaku, progress
// tracked. Server component; two variants differ only in their calls to action.

import Link from "@/components/ui/LocaleLink";
import type { Dict } from "@/lib/i18n";
import SectionHeader from "./SectionHeader";
import { ArrowIcon } from "./icons";
import section from "./section.module.css";
import styles from "./ContinueWatching.module.css";

interface LibraryExplainerProps {
  dict: Dict;
  /** visitor: log in first. empty: signed in, nothing in progress yet. */
  variant: "visitor" | "empty";
  seasonHref: string;
}

export default function LibraryExplainer({ dict, variant, seasonHref }: LibraryExplainerProps) {
  const steps = [dict.home.libraryStep1, dict.home.libraryStep2, dict.home.libraryStep3];
  return (
    <section className={`${section.section} ${section.first}`} aria-labelledby="home-library">
      <SectionHeader id="home-library" title={dict.nav.library} note={dict.home.librarySub} />
      <div className={styles.explainer}>
        <div className={styles.pitch}>
          <h3 className={styles.pitchTitle}>{dict.home.libraryHeadline}</h3>
          <p className={styles.pitchBody}>{dict.home.libraryBody}</p>
          <div className={styles.ctas}>
            {variant === "visitor" ? (
              <Link href="/login" prefetch={false} className={styles.glassBtn}>
                {dict.home.libraryLoginCta}
              </Link>
            ) : (
              <Link href="/library" prefetch={false} className={styles.glassBtn}>
                {dict.home.libraryOpen}
              </Link>
            )}
            {/* The player needs the File System Access API, which no phone
                browser has; /player answers phones with "use a computer". So
                the trial link is desktop-only (hidden ≤600px in CSS), the same
                call the old hero made for the same reason. */}
            {variant === "visitor" ? (
              <Link href="/player" prefetch={false} className={styles.textLink}>
                {dict.home.libraryTryPlayer}
                <ArrowIcon className={styles.textLinkIcon} />
              </Link>
            ) : (
              <Link href={seasonHref} prefetch={false} className={`${styles.textLink} ${styles.textLinkAlways}`}>
                {dict.home.watchingEmptyCta}
                <ArrowIcon className={styles.textLinkIcon} />
              </Link>
            )}
          </div>
        </div>
        <ol className={styles.steps}>
          {steps.map((step, i) => (
            <li key={step} className={styles.step}>
              <span className={styles.stepNo}>{String(i + 1).padStart(2, "0")}</span>
              <span className={styles.stepText}>{step}</span>
            </li>
          ))}
        </ol>
        <span className={styles.note}>{dict.home.libraryNote}</span>
      </div>
    </section>
  );
}
