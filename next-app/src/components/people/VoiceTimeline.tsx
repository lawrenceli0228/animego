"use client";

// 配音作品: every voice role, by year, newest first — a character's portrait
// with the title's cover in its corner, the character's name, its role and the
// title. Two controls, both from the canvas: 新到旧 / 只看主角 in the heading
// row, and 「查看全部 N 部」 under a first view of CARDS_SHOWN_COLLAPSED cards.
//
// A client component for those two controls only. The data comes from the
// server render whole (the API answers with every role), so neither control
// fetches anything, and the first view is in the server HTML.

import { Fragment, useState } from "react";
import Link from "@/components/ui/LocaleLink";
import FadeImage from "@/components/ui/FadeImage";
import { useLang } from "@/lib/lang-client";
import type { Lang } from "@/lib/i18n/lang";
import { pickTitle } from "@/lib/formatters";
import { characterDisplayName } from "@/lib/people/names";
import { characterRoleLabel } from "@/lib/people/labels";
import { animePath, characterPath } from "@/lib/people/paths";
import { fillTemplate } from "@/lib/people/template";
import {
  CARDS_SHOWN_COLLAPSED,
  countItems,
  filterVoiceYears,
  isMainRole,
  offersMainFilter,
  takeItems,
  voiceWorkCount,
  type VoiceFilter,
} from "@/lib/people/timeline";
import type { VoiceRole, VoiceYear } from "@/lib/people/types";
import SectionHead from "./SectionHead";
import c from "./cards.module.css";
import s from "./people.module.css";

const rolesOf = (y: VoiceYear) => y.roles;
const withRoles = (y: VoiceYear, roles: VoiceRole[]): VoiceYear => ({ ...y, roles });

interface VoiceTimelineProps {
  years: VoiceYear[];
  /** Distinct titles across every role: the heading's count. */
  workCount: number;
}

export default function VoiceTimeline({ years, workCount }: VoiceTimelineProps) {
  const { lang, t } = useLang();
  const [filter, setFilter] = useState<VoiceFilter>("all");
  const [expanded, setExpanded] = useState(false);

  const filtered = filterVoiceYears(years, filter);
  const collapsed = !expanded && countItems(filtered, rolesOf) > CARDS_SHOWN_COLLAPSED;
  const shown = collapsed ? takeItems(filtered, rolesOf, withRoles, CARDS_SHOWN_COLLAPSED) : filtered;

  const tools = offersMainFilter(years) ? (
    <div role="group" aria-label={t("people.filterLabel")} className={s.segment}>
      {(
        [
          ["all", t("people.filterNewest")],
          ["main", t("people.filterMain")],
        ] as const
      ).map(([value, label]) => (
        <button
          key={value}
          type="button"
          // Toggles, not tabs: the list under them is the same region either
          // way, filtered. Same choice as the detail page's episode-title
          // switch (EpisodesGrid).
          aria-pressed={filter === value}
          className={s.segmentButton}
          onClick={() => setFilter(value)}
        >
          {label}
        </button>
      ))}
    </div>
  ) : null;

  return (
    <section className={s.section} aria-labelledby="voice-roles-heading">
      <SectionHead
        id="voice-roles-heading"
        title={t("people.voiceRoles")}
        count={workCount}
        countTemplate={t("people.workCount")}
        tools={tools}
      />
      {shown.map((y) => (
        <Fragment key={y.year ?? "undated"}>
          <h3 className={c.yearHead}>{y.year ?? t("people.yearUnknown")}</h3>
          <div className={c.roleGrid}>
            {y.roles.map((role) => (
              <VoiceRoleCard key={`${role.anime.anilistId}-${role.character.anilistId}`} role={role} lang={lang} />
            ))}
          </div>
        </Fragment>
      ))}
      {collapsed ? (
        <button type="button" className={s.loadMore} onClick={() => setExpanded(true)}>
          {fillTemplate(t("people.viewAll"), { n: voiceWorkCount(filtered) })}
        </button>
      ) : null}
    </section>
  );
}

function VoiceRoleCard({ role, lang }: { role: VoiceRole; lang: Lang }) {
  const name = characterDisplayName(role.character.name, lang) || "—";
  const title = pickTitle(role.anime, lang) || role.anime.titleRomaji || "";
  const roleLabel = characterRoleLabel(role.role, lang);
  const characterHref = characterPath(role.character.anilistId);
  const animeHref = animePath(role.anime.anilistId);
  return (
    <article className={c.roleCard}>
      <div className={c.roleFrame}>
        {/* The pictures repeat the two text links below, so they are out of
            the tab order and the accessibility tree: one stop per destination. */}
        <Link href={characterHref} prefetch={false} tabIndex={-1} aria-hidden="true" className={c.roleImageLink}>
          <FadeImage src={role.character.image} alt="" width={180} height={270} className={c.roleImage} />
        </Link>
        <Link href={animeHref} prefetch={false} tabIndex={-1} aria-hidden="true" className={c.roleCoverLink}>
          <FadeImage src={role.anime.coverImageUrl} alt="" width={72} height={108} className={c.roleCover} />
        </Link>
      </div>
      <Link href={characterHref} prefetch={false} className={c.roleName}>
        {name}
      </Link>
      <div className={c.roleSub}>
        {roleLabel ? (
          <>
            <span className={isMainRole(role.role) ? c.roleMain : undefined}>{roleLabel}</span>
            {" · "}
          </>
        ) : null}
        <Link href={animeHref} prefetch={false} className={c.roleTitle}>
          {title}
        </Link>
      </div>
    </article>
  );
}
