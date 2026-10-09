"use client";

// /person/[id]/edit: the person page in its edit state (EditPerson /
// Mobile-EditPerson) -- the photo, the names, the occupations, birthday,
// gender, home town and blood type in place; 代表角色 shown as on the page
// (it is the server's rendering, passed in, and not edited); then the source.

import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useLang } from "@/lib/lang-client";
import {
  bloodTypeOptions,
  diffDraft,
  genderOptions,
  LIMITS,
  personDraft,
  type PersonDraft,
} from "@/lib/people/edit/model";
import { personHeading } from "@/lib/people/seo";
import type { Person } from "@/lib/people/types";
import type { Lang } from "@/lib/i18n/lang";
import { nativeLanguage } from "@/lib/people/view";
import ChipEditor from "./ChipEditor";
import NameFields from "./NameFields";
import EditorFrame, { DesktopBar } from "./EditorFrame";
import PhotoField from "./PhotoField";
import SourceFields from "./SourceFields";
import { useEditSubmit } from "./useEditSubmit";
import e from "./edit.module.css";

interface PersonEditorProps {
  person: Person;
  lang: Lang;
  crumbs: ReactNode;
  /** 代表角色, rendered by the page as it is on the person page. */
  representative: ReactNode;
  pageHref: string;
  hue?: CSSProperties;
}

const changedAttr = (a: string, b: string) => a.trim() !== b.trim();

export default function PersonEditor({ person, lang, crumbs, representative, pageHref, hue }: PersonEditorProps) {
  const { t } = useLang();
  const initial = useMemo(() => personDraft(person, lang), [person, lang]);
  const [draft, setDraft] = useState<PersonDraft>(initial);
  const diff = useMemo(() => diffDraft(initial, draft), [initial, draft]);
  const { busy, error, sourceError, sourceRef, clearSourceError, submit } = useEditSubmit(draft, diff, pageHref);
  const set = <K extends keyof PersonDraft>(key: K, value: PersonDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const heading = personHeading(person, lang);
  const dateField = (key: "birthYear" | "birthMonth" | "birthDay", label: string, className: string, max: number) => (
    <input
      className={`${e.field} ${className}`}
      inputMode="numeric"
      aria-label={label}
      value={draft[key]}
      maxLength={max}
      data-changed={changedAttr(draft[key], initial[key])}
      onChange={(event) => set(key, event.target.value)}
    />
  );

  return (
    <EditorFrame
      heading={heading}
      hue={hue}
      crumbs={crumbs}
      error={error}
      onSubmit={() => void submit()}
      count={diff.count}
      busy={busy}
      cancelHref={pageHref}
    >
      <section className={e.header} data-kind="person" aria-labelledby="edit-name">
        <PhotoField
          kind="person"
          current={person.image}
          alt={heading}
          photo={draft.photo}
          onChange={(photo) => set("photo", photo)}
        />
        <div className={e.headMain}>
          <div className={e.titleBlock}>
            <NameFields
              lang={lang}
              values={draft}
              initial={initial}
              nativeLang={nativeLanguage(person.name.native, person.profile?.language)}
              onChange={(key, value) => set(key, value)}
            />
            <ChipEditor
              variant="tag"
              chips={draft.occupations}
              onChange={(chips) => set("occupations", chips)}
              addLabel={t("peopleEdit.add")}
              addLabelPhone={t("peopleEdit.addOccupation")}
              inputLabel={t("peopleEdit.newOccupation")}
              removeTemplate={t("peopleEdit.removeOccupation")}
              maxLength={LIMITS.occupation}
              maxCount={LIMITS.occupations}
            />
          </div>
          <DesktopBar count={diff.count} busy={busy} cancelHref={pageHref} />
        </div>

        <div className={e.facts}>
          <span className={e.factLabel}>{t("people.birthday")}</span>
          <span className={e.dateParts}>
            {dateField("birthYear", t("peopleEdit.birthYear"), e.yearInput, 4)}
            {dateField("birthMonth", t("peopleEdit.birthMonth"), e.dayInput, 2)}
            {dateField("birthDay", t("peopleEdit.birthDay"), e.dayInput, 2)}
          </span>
          <label className={e.factLabel} htmlFor="edit-gender">
            {t("people.gender")}
          </label>
          <select
            id="edit-gender"
            className={e.field}
            value={draft.gender}
            data-changed={changedAttr(draft.gender, initial.gender)}
            onChange={(event) => set("gender", event.target.value)}
          >
            <option value="">—</option>
            {genderOptions(initial.gender, lang).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <label className={e.factLabel} htmlFor="edit-hometown">
            {t("people.homeTown")}
          </label>
          <input
            id="edit-hometown"
            className={e.field}
            value={draft.homeTown}
            maxLength={LIMITS.homeTown}
            data-changed={changedAttr(draft.homeTown, initial.homeTown)}
            onChange={(event) => set("homeTown", event.target.value)}
          />
          <label className={e.factLabel} htmlFor="edit-blood">
            {t("people.bloodType")}
          </label>
          <select
            id="edit-blood"
            className={e.field}
            value={draft.bloodType}
            data-changed={changedAttr(draft.bloodType, initial.bloodType)}
            onChange={(event) => set("bloodType", event.target.value)}
          >
            <option value="">—</option>
            {bloodTypeOptions(initial.bloodType, lang).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </section>

      {representative}

      <SourceFields
        source={draft.sourceUrl}
        note={draft.note}
        invalid={sourceError}
        sourceRef={sourceRef}
        onSource={(value) => {
          clearSourceError();
          set("sourceUrl", value);
        }}
        onNote={(value) => set("note", value)}
      />
    </EditorFrame>
  );
}
