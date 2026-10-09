"use client";

// 出演作品 in the edit state: the same posters, each with the character's
// role there as a select on the cover (the canvas's .ed-tag): 主角 / 配角 /
// 客串. Not links while editing -- a click is for the select.

import FadeImage from "@/components/ui/FadeImage";
import { formatLabel } from "@/lib/contentLabels";
import { pickTitle } from "@/lib/formatters";
import { useLang } from "@/lib/lang-client";
import { CHARACTER_ROLE_LABEL } from "@/lib/people/labels";
import { fillTemplate } from "@/lib/people/template";
import type { Appearance } from "@/lib/people/types";
import SectionHead from "../SectionHead";
import p from "../people.module.css";
import e from "./edit.module.css";

const ROLES = ["MAIN", "SUPPORTING", "BACKGROUND"] as const;

interface RolesEditorProps {
  appearances: Appearance[];
  roles: Record<number, string>;
  initial: Record<number, string>;
  onChange: (roles: Record<number, string>) => void;
}

export default function RolesEditor({ appearances, roles, initial, onChange }: RolesEditorProps) {
  const { lang, t } = useLang();
  if (appearances.length === 0) return null;
  return (
    <section className={p.section} aria-labelledby="appearances-heading">
      <SectionHead id="appearances-heading" title={t("people.appearances")} count={appearances.length} />
      <div className={e.posterGrid}>
        {appearances.map((a) => {
          const id = a.anime.anilistId;
          const title = pickTitle(a.anime, lang) || a.anime.titleRomaji || "";
          const meta = [a.anime.format ? formatLabel(a.anime.format, lang) : null, a.anime.year]
            .filter((v) => v !== null && v !== "")
            .join(" · ");
          const role = roles[id] ?? "";
          return (
            <div key={id} className={e.posterCard}>
              <div className={e.posterFrame}>
                <FadeImage src={a.anime.coverImageUrl} alt="" width={180} height={270} className={e.posterImage} />
                <select
                  className={e.roleSelect}
                  aria-label={fillTemplate(t("peopleEdit.roleIn"), { title })}
                  value={role}
                  data-changed={role !== (initial[id] ?? "")}
                  onChange={(event) => onChange({ ...roles, [id]: event.target.value })}
                >
                  {role === "" ? <option value="">—</option> : null}
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {CHARACTER_ROLE_LABEL[lang][r]}
                    </option>
                  ))}
                </select>
              </div>
              <div className={e.posterTitle}>{title}</div>
              {meta ? <div className={`${e.posterMeta} ${p.num}`}>{meta}</div> : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
