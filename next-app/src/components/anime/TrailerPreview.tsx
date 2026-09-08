"use client";

import Image from "next/image";
import { createPortal } from "react-dom";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  youtubeEmbedUrl,
  youtubeThumbnailUrl,
  youtubeWatchUrl,
} from "@/lib/youtubeTrailer";
import styles from "./TrailerPreview.module.css";

export interface TrailerPreviewLabels {
  official: string;
  watch: string;
  watchAria: string;
  close: string;
  openYouTube: string;
}

interface TrailerPreviewProps {
  trailerId: string;
  title: string;
  labels: TrailerPreviewLabels;
  variant: "card" | "button";
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M8.6 6.4v11.2L18 12 8.6 6.4Z" fill="currentColor" />
    </svg>
  );
}

/**
 * A lite YouTube preview: the page loads only a still until the visitor asks
 * to play. The actual iframe is created inside the dialog after the click,
 * avoiding YouTube's scripts, cookies and player weight on the detail page's
 * critical path.
 */
export default function TrailerPreview({
  trailerId,
  title,
  labels,
  variant,
}: TrailerPreviewProps) {
  const [open, setOpen] = useState(false);
  const [thumbnailQuality, setThumbnailQuality] =
    useState<"maxresdefault" | "hqdefault">("maxresdefault");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const headingId = useId();

  const close = useCallback(() => {
    setOpen(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!open) return;

    const previousOverflow = document.body.style.overflow;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
        return;
      }

      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), iframe, [tabindex]:not([tabindex="-1"])',
        ),
      );
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    window.requestAnimationFrame(() => closeRef.current?.focus());

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [close, open]);

  const watchAria = labels.watchAria.replace("{{title}}", title);
  const trigger =
    variant === "card" ? (
      <div className={styles.cardRoot}>
        <button
          ref={triggerRef}
          type="button"
          className={styles.card}
          onClick={() => setOpen(true)}
          aria-label={watchAria}
          aria-haspopup="dialog"
          aria-expanded={open}
        >
          <Image
            src={youtubeThumbnailUrl(trailerId, thumbnailQuality)}
            alt=""
            aria-hidden
            fill
            quality={85}
            sizes="(min-width: 980px) 460px, 1px"
            className={styles.thumbnail}
            onError={() => setThumbnailQuality("hqdefault")}
          />
          <span className={styles.cardScrim} aria-hidden />
          <span className={styles.cardPlay} aria-hidden>
            <PlayIcon />
          </span>
          <span className={styles.cardFooter}>
            <span>{labels.watch}</span>
            <span className={styles.cardArrow} aria-hidden>
              ↗
            </span>
          </span>
        </button>
      </div>
    ) : (
      <button
        ref={triggerRef}
        type="button"
        className={styles.buttonRoot}
        onClick={() => setOpen(true)}
        aria-label={watchAria}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span className={styles.buttonPlay} aria-hidden>
          <PlayIcon />
        </span>
        {labels.watch}
      </button>
    );

  const dialog = open ? (
    <div
      className={styles.backdrop}
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) close();
      }}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        className={styles.dialog}
      >
        <header className={styles.dialogHeader}>
          <div className={styles.dialogTitleBlock}>
            <span className={styles.dialogEyebrow}>{labels.official}</span>
            <h2 id={headingId}>{title}</h2>
          </div>
          <div className={styles.dialogActions}>
            <a
              href={youtubeWatchUrl(trailerId)}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.youtubeLink}
            >
              {labels.openYouTube}
              <span aria-hidden>↗</span>
            </a>
            <button
              ref={closeRef}
              type="button"
              onClick={close}
              className={styles.close}
              aria-label={labels.close}
            >
              <span aria-hidden>×</span>
            </button>
          </div>
        </header>
        <div className={styles.stage}>
          <iframe
            src={youtubeEmbedUrl(trailerId)}
            title={`${labels.official} · ${title}`}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            referrerPolicy="strict-origin-when-cross-origin"
            allowFullScreen
          />
        </div>
      </section>
    </div>
  ) : null;

  return (
    <>
      {trigger}
      {dialog && createPortal(dialog, document.body)}
    </>
  );
}
