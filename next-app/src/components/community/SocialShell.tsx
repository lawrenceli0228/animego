// ┌──────────────────────────────────────────────────────────────────────┐
// │ THE SWAP POINT. This is the one wrapper the community tab renders     │
// │ inside, and it is meant to be replaced: the full detail-page hero    │
// │ and the 概览 / 角色 / 制作 / 社区 tab bar are being built as a shared │
// │ shell for every /anime/[id]/* route on another branch. When that      │
// │ lands, app/[lang]/anime/[id]/social/page.tsx renders                  │
// │ <SocialTab/> inside that shell instead of this, and this file and    │
// │ SocialShell.module.css are deleted. Nothing else imports them.        │
// └──────────────────────────────────────────────────────────────────────┘
//
// Until then it is deliberately small: the anime's title and cover, a link
// back to the overview, and the tab marker — enough for the page to have an
// <h1> and a way out. HeroAccent wraps the whole page, as on the overview,
// because it is what puts this anime's hue (--poster-hue) on everything
// below it, the tab body included.
//
// A server component: it renders anonymous, cacheable markup only.

import type { ReactNode } from "react";
import Link from "@/components/ui/LocaleLink";
import HeroAccent from "@/components/anime/HeroAccent";
import FadeImage from "@/components/ui/FadeImage";
import { pickTitle } from "@/lib/formatters";
import type { Dict } from "@/lib/i18n";
import type { Lang } from "@/lib/i18n/lang";
import type { AnimeDetail } from "@/lib/types";
import s from "./SocialShell.module.css";

export interface SocialShellProps {
  detail: AnimeDetail;
  lang: Lang;
  dict: Dict;
  /** Shown beside 社区 in the tab marker, when known. */
  communityCount?: number | null;
  children: ReactNode;
}

export default function SocialShell({ detail, lang, dict, communityCount, children }: SocialShellProps) {
  const title = pickTitle(detail, lang);
  const original = detail.titleNative || detail.titleRomaji;
  const overview = `/anime/${detail.anilistId}`;
  return (
    <HeroAccent
      anilistId={detail.anilistId}
      coverImageUrl={detail.coverImageUrl}
      posterAccent={detail.posterAccent ?? null}
      posterAccentRgb={detail.posterAccentRgb ?? null}
    >
      <main className={s.page}>
        <header className={s.header}>
          <div className={`container ${s.inner}`}>
            <Link href={overview} className={s.coverLink} prefetch={false} aria-hidden="true" tabIndex={-1}>
              {detail.coverImageUrl ? (
                <FadeImage src={detail.coverImageUrl} alt="" width={64} height={92} className={s.cover} />
              ) : (
                <span className={s.cover} />
              )}
            </Link>
            <div className={s.titles}>
              <h1 className={s.title}>{title}</h1>
              {original && original !== title ? <p className={s.original}>{original}</p> : null}
            </div>
          </div>
        </header>
        <nav className={s.tabs} aria-label={dict.community.tabsLabel}>
          <div className={`container ${s.tabsInner}`}>
            <Link href={overview} className={s.tab} prefetch={false}>
              {dict.community.tabOverview}
            </Link>
            <Link href={`${overview}/social`} className={s.tabOn} aria-current="page" prefetch={false}>
              {dict.community.tabSocial}
              {typeof communityCount === "number" ? <span className={s.count}>{communityCount}</span> : null}
            </Link>
          </div>
        </nav>
        {children}
      </main>
    </HeroAccent>
  );
}
