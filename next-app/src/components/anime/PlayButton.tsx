"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "@/components/ui/LocaleLink";
import { useLang } from "@/lib/lang-client";
import styles from "./PlayButton.module.css";

interface PlayButtonProps {
  ariaLabel: string;
  children: string;
  onOpenDownloads: () => void;
}

/**
 * Entry point for local danmaku playback.
 *
 * Opening /library immediately made the button feel broken for signed-out
 * visitors: the auth proxy sent them to login before they had learned that
 * this is a local-file workflow. The lightweight explainer keeps torrent
 * search available to everyone, then makes the one-time library-folder setup
 * explicit before an authenticated surface is opened.
 */
export default function PlayButton({
  ariaLabel,
  children,
  onOpenDownloads,
}: PlayButtonProps) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!open) return;

    const originalOverflow = document.body.style.overflow;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };

    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    window.requestAnimationFrame(() => closeRef.current?.focus());

    return () => {
      document.body.style.overflow = originalOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [close, open]);

  const openDownloads = () => {
    setOpen(false);
    onOpenDownloads();
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={styles.trigger}
      >
        {children}
      </button>

      {open ? (
        <div
          className={styles.backdrop}
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) close();
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="player-guide-title"
            className={styles.dialog}
          >
            <div className={styles.topline}>
              <span className={styles.eyebrow}>
                {t("playerGuide.eyebrow")}
              </span>
              <button
                ref={closeRef}
                type="button"
                onClick={close}
                className={styles.close}
                aria-label={t("playerGuide.close")}
              >
                ×
              </button>
            </div>

            <div className={styles.headingRow}>
              <div>
                <h2 id="player-guide-title">{t("playerGuide.title")}</h2>
                <p>{t("playerGuide.body")}</p>
              </div>
              <span className={styles.chromeBadge}>
                <span aria-hidden>◉</span>
                {t("playerGuide.chrome")}
              </span>
            </div>

            <ol className={styles.steps}>
              <li>
                <span className={styles.stepNumber}>01</span>
                <span>
                  <strong>{t("playerGuide.downloadTitle")}</strong>
                  <small>{t("playerGuide.downloadBody")}</small>
                </span>
              </li>
              <li>
                <span className={styles.stepNumber}>02</span>
                <span>
                  <strong>{t("playerGuide.folderTitle")}</strong>
                  <small>{t("playerGuide.folderBody")}</small>
                </span>
              </li>
              <li>
                <span className={styles.stepNumber}>03</span>
                <span>
                  <strong>{t("playerGuide.refreshTitle")}</strong>
                  <small>{t("playerGuide.refreshBody")}</small>
                </span>
              </li>
            </ol>

            <div className={styles.notice}>
              <span aria-hidden>●</span>
              <p>
                <strong>{t("playerGuide.noticeTitle")}</strong>
                {t("playerGuide.noticeBody")}
              </p>
            </div>

            <div className={styles.actions}>
              <button
                type="button"
                className={styles.primary}
                onClick={openDownloads}
              >
                {t("playerGuide.downloadCta")}
                <span aria-hidden>→</span>
              </button>
              <Link
                href="/player"
                prefetch={false}
                className={styles.secondary}
              >
                {t("playerGuide.trialCta")}
              </Link>
              <Link
                href="/library"
                prefetch={false}
                className={styles.tertiary}
              >
                {t("playerGuide.libraryCta")}
              </Link>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
