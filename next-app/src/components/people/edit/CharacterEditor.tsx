"use client";

// /character/[id]/edit: the character page in its edit state, in the page's
// own layout (EditCast / Mobile-Edit). Every value the page shows is a field
// in its place -- the portrait, the three names, the aliases, the facts, the
// description, each voice row and the role on each title -- then the source.
// What differs from the page as it opened is what is sent (model.ts), and
// the bars count it.

import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useLang } from "@/lib/lang-client";
import {
  bloodTypeOptions,
  characterDraft,
  diffDraft,
  genderOptions,
  LIMITS,
  type CharacterDraft,
} from "@/lib/people/edit/model";
import { characterHeading } from "@/lib/people/seo";
import type { Character } from "@/lib/people/types";
import type { Lang } from "@/lib/i18n/lang";
import ChipEditor from "./ChipEditor";
import EditorFrame, { DesktopBar } from "./EditorFrame";
import PhotoField from "./PhotoField";
import RolesEditor from "./RolesEditor";
import SourceFields from "./SourceFields";
import VoicesEditor from "./VoicesEditor";
import { useEditSubmit } from "./useEditSubmit";
import e from "./edit.module.css";

interface CharacterEditorProps {
  character: Character;
  lang: Lang;
  crumbs: ReactNode;
  pageHref: string;
  hue?: CSSProperties;
}

const changedAttr = (a: string, b: string) => a.trim() !== b.trim();

export default function CharacterEditor({ character, lang, crumbs, pageHref, hue }: CharacterEditorProps) {
  const { t } = useLang();
  const initial = useMemo(() => characterDraft(character, lang), [character, lang]);
  const [draft, setDraft] = useState<CharacterDraft>(initial);
  const diff = useMemo(() => diffDraft(initial, draft), [initial, draft]);
  const { busy, error, sourceError, sourceRef, clearSourceError, submit } = useEditSubmit(draft, diff, pageHref);
  const set = <K extends keyof CharacterDraft>(key: K, value: CharacterDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const heading = characterHeading(character, lang);

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
      <section className={e.header} data-kind="character" aria-labelledby="edit-name">
        <PhotoField
          kind="character"
          current={character.image}
          alt={heading}
          photo={draft.photo}
          onChange={(photo) => set("photo", photo)}
        />
        <div className={e.headMain}>
          <div className={e.titleBlock}>
            <input
              id="edit-name"
              className={e.nameInput}
              aria-label={t("peopleEdit.nameCn")}
              value={draft.nameCn}
              maxLength={LIMITS.name}
              data-changed={changedAttr(draft.nameCn, initial.nameCn)}
              onChange={(event) => set("nameCn", event.target.value)}
            />
            <div className={e.subNames}>
              <input
                className={`${e.subInput} ${e.jp}`}
                lang="ja"
                aria-label={t("peopleEdit.nameNative")}
                value={draft.nameNative}
                maxLength={LIMITS.name}
                data-changed={changedAttr(draft.nameNative, initial.nameNative)}
                onChange={(event) => set("nameNative", event.target.value)}
              />
              <span className={e.dot} aria-hidden="true" />
              <input
                className={`${e.subInput} ${e.latin}`}
                aria-label={t("peopleEdit.nameFull")}
                value={draft.nameFull}
                maxLength={LIMITS.name}
                data-changed={changedAttr(draft.nameFull, initial.nameFull)}
                onChange={(event) => set("nameFull", event.target.value)}
              />
            </div>
            <ChipEditor
              variant="alias"
              chips={draft.aliases.map((a) => ({ value: a, label: a }))}
              onChange={(chips) => set("aliases", chips.map((c) => c.value))}
              label={t("people.aliases")}
              addLabel={t("peopleEdit.add")}
              addLabelPhone={t("peopleEdit.addAlias")}
              inputLabel={t("peopleEdit.newAlias")}
              removeTemplate={t("peopleEdit.removeAlias")}
              maxLength={LIMITS.alias}
              maxCount={LIMITS.aliases}
            />
          </div>
          <DesktopBar count={diff.count} busy={busy} cancelHref={pageHref} />
        </div>

        <div className={e.facts}>
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
          <label className={e.factLabel} htmlFor="edit-age">
            {t("people.age")}
          </label>
          <input
            id="edit-age"
            className={e.field}
            value={draft.age}
            maxLength={LIMITS.age}
            data-changed={changedAttr(draft.age, initial.age)}
            onChange={(event) => set("age", event.target.value)}
          />
          <span className={e.factLabel}>{t("people.birthday")}</span>
          <span className={e.dateParts}>
            <input
              className={`${e.field} ${e.dayInput}`}
              inputMode="numeric"
              placeholder={t("peopleEdit.monthShort")}
              aria-label={t("peopleEdit.birthMonth")}
              value={draft.birthMonth}
              maxLength={2}
              data-changed={changedAttr(draft.birthMonth, initial.birthMonth)}
              onChange={(event) => set("birthMonth", event.target.value)}
            />
            <input
              className={`${e.field} ${e.dayInput}`}
              inputMode="numeric"
              placeholder={t("peopleEdit.dayShort")}
              aria-label={t("peopleEdit.birthDay")}
              value={draft.birthDay}
              maxLength={2}
              data-changed={changedAttr(draft.birthDay, initial.birthDay)}
              onChange={(event) => set("birthDay", event.target.value)}
            />
          </span>
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

        <section className={e.about} aria-labelledby="edit-about">
          <h2 id="edit-about" className={e.aboutTitle}>
            {t("people.description")}
          </h2>
          <textarea
            className={e.textArea}
            aria-labelledby="edit-about"
            value={draft.description}
            maxLength={LIMITS.description}
            data-changed={changedAttr(draft.description, initial.description)}
            onChange={(event) => set("description", event.target.value)}
          />
        </section>
      </section>

      <VoicesEditor voices={draft.voices} onChange={(voices) => set("voices", voices)} />
      <RolesEditor
        appearances={character.appearances}
        roles={draft.roles}
        initial={initial.roles}
        onChange={(roles) => set("roles", roles)}
      />
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
