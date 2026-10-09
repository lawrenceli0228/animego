"use client";

// The three names in the edit state, in the places the page shows them: the
// one the page leads with in the reader's language is the big field where
// the heading is, the other two sit under it. The order is the page's own
// ladder (lib/people/names.ts) -- Chinese first on the Chinese pages, the
// romanised name first on the English one -- so the field under the reader's
// eye is the name they were reading.

import type { Lang } from "@/lib/i18n/lang";
import { useLang } from "@/lib/lang-client";
import { LIMITS } from "@/lib/people/edit/model";
import e from "./edit.module.css";

export type NameKey = "nameCn" | "nameNative" | "nameFull";
type Names = Record<NameKey, string>;

const LADDER: Record<Lang, readonly NameKey[]> = {
  zh: ["nameCn", "nameNative", "nameFull"],
  en: ["nameFull", "nameNative", "nameCn"],
  "zh-Hant": ["nameCn", "nameNative", "nameFull"],
};

interface NameFieldsProps {
  lang: Lang;
  values: Names;
  initial: Names;
  /** The native name's language, as the page decides it (lib/people/view.ts). */
  nativeLang: "ja" | "zh" | "ko" | null;
  onChange: (key: NameKey, value: string) => void;
}

export default function NameFields({ lang, values, initial, nativeLang, onChange }: NameFieldsProps) {
  const { t } = useLang();
  const label: Record<NameKey, string> = {
    nameCn: t("peopleEdit.nameCn"),
    nameNative: t("peopleEdit.nameNative"),
    nameFull: t("peopleEdit.nameFull"),
  };
  // A Japanese native name in a Japanese face, as on the page; the
  // romanised one in the Latin face.
  const face: Record<NameKey, string> = { nameCn: "", nameNative: nativeLang === "ja" ? e.jp : "", nameFull: e.latin };
  const [lead, ...rest] = LADDER[lang];
  const field = (key: NameKey, className: string, id?: string) => (
    <input
      id={id}
      className={`${className} ${face[key]}`}
      lang={key === "nameNative" && nativeLang ? nativeLang : undefined}
      aria-label={label[key]}
      value={values[key]}
      maxLength={LIMITS.name}
      data-changed={values[key].trim() !== initial[key].trim()}
      onChange={(event) => onChange(key, event.target.value)}
    />
  );
  return (
    <>
      {field(lead, e.nameInput, "edit-name")}
      <div className={e.subNames}>
        {field(rest[0], e.subInput)}
        <span className={e.dot} aria-hidden="true" />
        {field(rest[1], e.subInput)}
      </div>
    </>
  );
}
