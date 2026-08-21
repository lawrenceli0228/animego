"use client";

import { useEffect } from "react";
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
