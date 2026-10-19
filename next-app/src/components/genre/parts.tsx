"use client";

// Small pieces the hub and the grid share: the section head with its
// "see all" link, the two arrows, and a skeleton cover.

import type { ReactNode } from "react";
import Link from "@/components/ui/LocaleLink";
import states from "@/components/seasonal/browse/states.module.css";
import hub from "./hub.module.css";

export function ChevronRightIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

export function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M15 6l-6 6 6 6" />
    </svg>
  );
}

interface SectionHeadProps {
  id?: string;
  title: string;
  /** The small count beside the title ("84 部"), or nothing. */
  count?: string;
  /** "查看全部 ›" and where it goes. */
  all?: { href: string; label: string; ariaLabel?: string; onNavigate?: () => void; hook: string };
}

export function SectionHead({ id, title, count, all }: SectionHeadProps) {
  return (
    <div className={hub.secHead}>
      <h2 id={id} className={hub.secTitle}>
        {title}
        {count ? <small className={hub.secCount}>{count}</small> : null}
      </h2>
      {all ? (
        <Link
          href={all.href}
          prefetch={false}
          className={hub.all}
          aria-label={all.ariaLabel}
          onNavigate={all.onNavigate}
          data-see-all={all.hook}
        >
          {all.label}
          <ChevronRightIcon />
        </Link>
      ) : null}
    </div>
  );
}

/** One skeleton cover: the seasonal page's shimmer and shapes. */
export function SkeletonCard() {
  return (
    <div className={states.skCard}>
      <div className={`${states.skCover} ${states.sk}`} />
      <div className={`${states.skLine} ${states.sk}`} />
      <div className={`${states.skLine} ${states.skShort} ${states.sk}`} />
    </div>
  );
}

export function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

export function Section({
  children,
  delayMs,
  label,
  labelledBy,
  hook,
}: {
  children: ReactNode;
  delayMs: number;
  label?: string;
  labelledBy?: string;
  hook: string;
}) {
  return (
    <section
      className={hub.sec}
      style={{ animationDelay: `${delayMs}ms` }}
      aria-label={label}
      aria-labelledby={labelledBy}
      data-section={hook}
    >
      {children}
    </section>
  );
}
