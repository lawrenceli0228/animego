"use client";

// 制作作品: a person's production credits, one card per title with every role
// they hold there, by year, newest first. The canvas draws this section for
// no one in particular (its person is a voice actor), so it borrows the
// character page's title cards and the voice timeline's years and
// 「查看全部」; there is no lead-role filter, because a credit has no lead.

import { Fragment, useState } from "react";
import Link from "@/components/ui/LocaleLink";
import FadeImage from "@/components/ui/FadeImage";
import { useLang } from "@/lib/lang-client";
import { pickTitle } from "@/lib/formatters";
import { staffRoleLabel } from "@/lib/contentLabels";
import { animePath } from "@/lib/people/paths";
import { fillTemplate } from "@/lib/people/template";
import { CARDS_SHOWN_COLLAPSED, countItems, takeItems } from "@/lib/people/timeline";
import type { StaffWork, StaffYear } from "@/lib/people/types";
import SectionHead from "./SectionHead";
import c from "./cards.module.css";
import s from "./people.module.css";

const worksOf = (y: StaffYear) => y.works;
const withWorks = (y: StaffYear, works: StaffWork[]): StaffYear => ({ ...y, works });

interface StaffTimelineProps {
  years: StaffYear[];
  workCount: number;
}

export default function StaffTimeline({ years, workCount }: StaffTimelineProps) {
  const { lang, t } = useLang();
  const [expanded, setExpanded] = useState(false);
  const collapsed = !expanded && countItems(years, worksOf) > CARDS_SHOWN_COLLAPSED;
  const shown = collapsed ? takeItems(years, worksOf, withWorks, CARDS_SHOWN_COLLAPSED) : years;

  return (
    <section className={s.section} aria-labelledby="staff-works-heading">
      <SectionHead
        id="staff-works-heading"
        title={t("people.staffWorks")}
        count={workCount}
        countTemplate={t("people.workCount")}
      />
      {shown.map((y) => (
        <Fragment key={y.year ?? "undated"}>
          <h3 className={c.yearHead}>{y.year ?? t("people.yearUnknown")}</h3>
          <div className={c.posterGrid}>
            {y.works.map((w) => {
              const title = pickTitle(w.anime, lang) || w.anime.titleRomaji || "";
              return (
                <Link
                  key={w.anime.anilistId}
                  href={animePath(w.anime.anilistId)}
                  prefetch={false}
                  className={c.posterCard}
                >
                  <div className={c.posterFrame}>
                    <FadeImage
                      src={w.anime.coverImageUrl}
                      alt={title}
                      width={180}
                      height={270}
                      className={c.posterImage}
                    />
                  </div>
                  <div className={c.posterTitle}>{title}</div>
                  <div className={c.posterMeta}>{w.roles.map((r) => staffRoleLabel(r, lang)).join(" · ")}</div>
                </Link>
              );
            })}
          </div>
        </Fragment>
      ))}
      {collapsed ? (
        <button type="button" className={s.loadMore} onClick={() => setExpanded(true)}>
          {fillTemplate(t("people.viewAll"), { n: workCount })}
        </button>
      ) : null}
    </section>
  );
}
