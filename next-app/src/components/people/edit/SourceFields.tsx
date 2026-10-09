"use client";

// 来源 *: the link the edit rests on (required) and an optional note, last
// on the page as on the canvas.

import type { Ref } from "react";
import { useLang } from "@/lib/lang-client";
import { LIMITS } from "@/lib/people/edit/model";
import p from "../people.module.css";
import e from "./edit.module.css";

interface SourceFieldsProps {
  source: string;
  note: string;
  invalid: boolean;
  sourceRef: Ref<HTMLInputElement>;
  onSource: (value: string) => void;
  onNote: (value: string) => void;
}

export default function SourceFields({ source, note, invalid, sourceRef, onSource, onNote }: SourceFieldsProps) {
  const { t } = useLang();
  return (
    <section className={p.section} aria-labelledby="source-heading">
      <header className={p.sectionHead}>
        <h2 id="source-heading" className={p.sectionTitle}>
          {t("peopleEdit.source")} <span className={e.required}>*</span>
        </h2>
      </header>
      <div className={e.sourceGrid}>
        <div>
          <div className={e.box} data-invalid={invalid}>
            <input
              ref={sourceRef}
              type="url"
              inputMode="url"
              required
              className={e.boxInput}
              aria-label={t("peopleEdit.sourceLink")}
              aria-invalid={invalid}
              aria-describedby={invalid ? "source-error" : undefined}
              value={source}
              maxLength={LIMITS.source}
              onChange={(event) => onSource(event.target.value)}
            />
          </div>
          {invalid ? (
            <p id="source-error" className={e.fieldError}>
              {source.trim() ? t("peopleEdit.errors.sourceInvalid") : t("peopleEdit.errors.sourceRequired")}
            </p>
          ) : null}
        </div>
        <div className={e.box}>
          <input
            className={e.boxInput}
            aria-label={t("peopleEdit.noteLabel")}
            placeholder={t("peopleEdit.sourceNote")}
            value={note}
            maxLength={LIMITS.note}
            onChange={(event) => onNote(event.target.value)}
          />
        </div>
      </div>
    </section>
  );
}
