"use client";

import { useEffect } from "react";
import Image from "next/image";
import Link from "@/components/ui/LocaleLink";
import FadeImage from "@/components/ui/FadeImage";
import { pickTitle } from "@/lib/formatters";
import { useLang } from "@/lib/lang-client";
import type { Lang } from "@/lib/i18n/lang";
import { isMaskedUsername } from "@/lib/publicUsername";
import type { HotDiscussion } from "@/lib/types";
import {
  communityDiscussionTarget,
  trackHotDiscussionOpen,
  trackHotDiscussionsImpressionOnce,
} from "@/lib/communityEngagement";
import styles from "./HotDiscussions.module.css";

// Chinese brackets the number ("第 3 集"), English puts it after the noun.
// A local Record of functions rather than a t() key with a placeholder,
// because the two shapes are different sentences, not one sentence with a
// hole in it.
const EPISODE_KICKER: Record<Lang, (episode: number) => string> = {
  zh: (episode) => `第 ${episode} 集`,
  en: (episode) => `Episode ${episode}`,
  "zh-Hant": (episode) => `第 ${episode} 集`,
};

export default function HotDiscussions({ items }: { items: HotDiscussion[] }) {
  const { lang, t } = useLang();

  useEffect(() => {
    trackHotDiscussionsImpressionOnce(items.length);
  }, [items.length]);

  return (
    <section className={styles.section} aria-labelledby="hot-discussions-title">
      <header className={styles.header}>
        <div>
          <p className={styles.label}>{t("communityDiscovery.label")}</p>
          <h2 id="hot-discussions-title">{t("communityDiscovery.title")}</h2>
        </div>
        <p className={styles.subtitle}>{t("communityDiscovery.subtitle")}</p>
      </header>

      <div id="hot-discussion-list" className={styles.grid}>
        {/* A band, not a card.
          *
          * This is the only explanation of the hardest-to-discover thing the
          * site does, so it earns being seen — but it was 1352×336 sitting on
          * top of a 140px discussion card, which made the biggest object in a
          * section called "正在热议" a download tutorial. It is now a strip:
          * the one shape on this page that is neither a card nor a poster, so
          * it reads as "instructions" before a word of it is read.
          *
          * What went: three step boxes (a numbered list does not need three
          * borders to be a numbered list), the bordered Chrome panel (a
          * one-line caveat was wearing a headline, a logo and a green accent),
          * two decorative labels, and a "LOCAL // DANMAKU" watermark that the
          * illustration panel painted over and sliced mid-word. */}
        <article className={styles.libraryGuide}>
          <div className={styles.guideLead}>
            <p className={styles.guideEyebrow}>
              {t("communityDiscovery.libraryGuidePinned")} ·{" "}
              {t("communityDiscovery.libraryGuideEyebrow")}
            </p>
            <h3>{t("communityDiscovery.libraryGuideTitle")}</h3>
            <p className={styles.guideBody}>
              {t("communityDiscovery.libraryGuideBody")}
            </p>
          </div>

          {/* The rule between items is the sequence. Three equal boxes said
            * "three things"; a connected run says "then, then". */}
          <ol className={styles.guideSteps}>
            <li>
              <span aria-hidden>01</span>
              {t("communityDiscovery.libraryGuideStepDownload")}
            </li>
            <li>
              <span aria-hidden>02</span>
              {t("communityDiscovery.libraryGuideStepFolder")}
            </li>
            <li>
              <span aria-hidden>03</span>
              {t("communityDiscovery.libraryGuideStepRefresh")}
            </li>
          </ol>

          <div className={styles.guideActions}>
            <Link href="/library" prefetch={false} className={styles.guidePrimary}>
              {t("communityDiscovery.libraryGuideCta")}
              <span aria-hidden>→</span>
            </Link>
            <Link href="/player" prefetch={false} className={styles.guideSecondary}>
              {t("communityDiscovery.libraryGuideTrial")}
            </Link>
            {/* A precondition, not a footnote.
              * Demoting it to 10.5px grey with a 14px hand-drawn Chrome mark
              * went too far in the other direction: nobody reads it, and a
              * four-colour logo at that size is a smudge rather than a brand.
              * Someone on Safari who misses this line presses the button and
              * finds out the hard way, so it sits beside the button, at a size
              * that can be read, with the browser name carrying the weight. */}
            <p className={styles.guideNote}>
              {t("communityDiscovery.libraryGuideChrome")}
              <span>{t("communityDiscovery.libraryGuideChromeNote")}</span>
            </p>
          </div>

          <Image
            className={styles.guideMascot}
            src="/mascot-wink.png"
            alt=""
            width={720}
            height={1080}
            sizes="(max-width: 760px) 104px, 132px"
          />
        </article>

        <Link
          href="/welcome"
          prefetch={false}
          className={`${styles.card} ${styles.welcomeCard}`}
        >
          <span className={styles.poster} aria-hidden>
            <FadeImage
              src="/community-welcome.jpg"
              alt=""
              width={84}
              height={118}
              style={{
                width: "100%",
                height: "100%",
                objectFit: "cover",
                objectPosition: "center 38%",
              }}
            />
          </span>

          <span className={styles.copy}>
            <span className={`${styles.kicker} ${styles.welcomeKicker}`}>
              {t("communityDiscovery.welcomePinned")} ·{" "}
              {t("communityDiscovery.welcomeEyebrow")}
            </span>
            <strong id="community-welcome-title">
              {t("communityDiscovery.welcomeTitle")}
            </strong>
            <span className={styles.preview}>
              <b>{t("communityDiscovery.welcomeAuthor")}</b>{" "}
              {t("communityDiscovery.welcomeBody")}
            </span>
          </span>

          <span className={styles.arrow} aria-hidden>
            ↗
          </span>
        </Link>

        {items.length === 0 ? (
          <div className={styles.empty}>
            <p>{t("communityDiscovery.empty")}</p>
            <Link href="/search" prefetch={false}>
              {t("communityDiscovery.start")}
            </Link>
          </div>
        ) : null}

        {items.map((item) => {
          const title = pickTitle(item, lang);
          const target = communityDiscussionTarget(
            item.anilistId,
            item.episode,
            item.latest.id,
          );
          const preview = item.latest.isSpoiler
            ? t("communityDiscovery.spoiler")
            : item.latest.content;
          return (
            <Link
              key={`${item.anilistId}:${item.episode}`}
              href={target}
              prefetch={false}
              className={styles.card}
              onNavigate={() => trackHotDiscussionOpen(item.anilistId, item.episode)}
            >
              <span className={styles.poster} aria-hidden>
                {item.coverImageUrl ? (
                  <FadeImage
                    src={item.coverImageUrl}
                    alt=""
                    width={84}
                    height={118}
                    style={{ width: "100%", height: "100%", objectFit: "cover" }}
                  />
                ) : (
                  title.slice(0, 1).toUpperCase()
                )}
              </span>

              <span className={styles.copy}>
                <span className={styles.kicker}>
                  {EPISODE_KICKER[lang](item.episode)}
                </span>
                <strong>{title}</strong>
                <span className={styles.stats}>
                  💬 {item.commentCount} · {item.participantCount}{" "}
                  {t("communityDiscovery.participants")}
                  {item.reactionCount > 0 ? ` · ♥ ${item.reactionCount}` : ""}
                </span>
                <span
                  className={
                    item.latest.isSpoiler
                      ? `${styles.preview} ${styles.spoiler}`
                      : styles.preview
                  }
                >
                  <b
                    title={
                      isMaskedUsername(item.latest.username)
                        ? t("communityDiscovery.maskedUser")
                        : undefined
                    }
                  >
                    @{item.latest.username}
                  </b>{" "}
                  {preview}
                </span>
              </span>

              <span className={styles.arrow} aria-hidden>
                ↗
              </span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
