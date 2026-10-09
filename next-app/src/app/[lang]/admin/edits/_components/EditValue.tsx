"use client";

// One side of a reviewed change -- the value the submitter saw, or the one
// they propose -- drawn for its field: text, a list, a birthday, a photo, a
// voice row with its person, a role.
//
// Photos are plain <img>: the proposed one is an admin-only route that needs
// the session cookie (the optimizer would fetch it without one), and a
// review page has no reason to resize either.

import type { Lang } from "@/lib/i18n/lang";
import { formatProfileDate } from "@/lib/people/dates";
import { bloodTypeLabel, characterRoleLabel, genderLabel, voiceLine } from "@/lib/people/labels";
import { personDisplayName } from "@/lib/people/names";
import type { EditItem, ImageValue, VoiceValue } from "@/lib/people/edit/review";
import type { FuzzyDate } from "@/lib/people/types";
import q from "../edits.module.css";
import { anilistImgProps } from "@/lib/images/anilistImg";

interface EditValueProps {
  item: EditItem;
  side: "old" | "new";
  lang: Lang;
  labels: { oldImage: string; newImage: string };
}

const EMPTY = "—";

function text(value: unknown): string {
  return typeof value === "string" && value.trim() ? value : EMPTY;
}

export default function EditValue({ item, side, lang, labels }: EditValueProps) {
  const value = side === "old" ? item.old : item.new;
  const tone = side === "old" ? q.old : q.new;

  switch (item.field) {
    case "image": {
      if (side === "old") {
        return typeof value === "string" ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img {...anilistImgProps(value, 80, 120)} alt={labels.oldImage} className={`${q.image} ${q.oldImage}`} />
        ) : (
          <span className={tone}>{EMPTY}</span>
        );
      }
      const img = value as ImageValue | null;
      return (
        <span>
          {item.previewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={item.previewUrl} alt={labels.newImage} className={`${q.image} ${q.newImage}`} />
          ) : null}
          {img ? <span className={q.dims}>{`${img.width}×${img.height}`}</span> : null}
        </span>
      );
    }
    case "aliases":
    case "occupations": {
      const list = Array.isArray(value) ? (value as string[]) : [];
      return <span className={tone}>{list.length > 0 ? list.join("、") : EMPTY}</span>;
    }
    case "birth":
      return <span className={tone}>{formatProfileDate(value as FuzzyDate | null, lang) ?? EMPTY}</span>;
    case "gender":
      return <span className={tone}>{genderLabel(value as string | null, lang) ?? EMPTY}</span>;
    case "bloodType":
      return <span className={tone}>{bloodTypeLabel(value as string | null, lang) ?? EMPTY}</span>;
    case "role":
      return <span className={tone}>{characterRoleLabel(value as string | null, lang) ?? EMPTY}</span>;
    case "description":
      return <div className={`${tone} ${q.longText}`}>{text(value)}</div>;
    case "voice": {
      const v = value as VoiceValue | null;
      if (!v) return <span className={tone}>{EMPTY}</span>;
      const line = v.line?.trim() || voiceLine(v.language, v.roleNotes, lang);
      return (
        <span className={`${q.person} ${tone}`}>
          {v.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img {...anilistImgProps(v.image, 28, 28)} alt="" className={q.avatar} />
          ) : null}
          <span>
            {personDisplayName(v.name, lang) || `#${v.personId}`}
            {line ? ` · ${line}` : ""}
          </span>
        </span>
      );
    }
    default:
      return <span className={tone}>{text(value)}</span>;
  }
}
