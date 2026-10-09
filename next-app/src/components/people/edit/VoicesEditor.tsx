"use client";

// 声优 in the edit state: each voice row with its line in a field (日配 · 童年),
// 「更换」 to give the row to someone else, × to remove it (and ↺ to take that
// back), and 「+ 添加声优」. A person is named by their page link, an AniList
// staff link or the id, and looked up on GET /api/people/:id -- which answers
// only for someone the site credits, so every row links to a real page.

import { useState, type KeyboardEvent } from "react";
import FadeImage from "@/components/ui/FadeImage";
import { useLang } from "@/lib/lang-client";
import type { VoiceDraft } from "@/lib/people/edit/model";
import { LIMITS, personIdFromInput } from "@/lib/people/edit/model";
import { personDisplayName } from "@/lib/people/names";
import type { PersonRef } from "@/lib/people/types";
import SectionHead from "../SectionHead";
import p from "../people.module.css";
import e from "./edit.module.css";

function XIcon() {
  return (
    <svg className={e.icon} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

function RestoreIcon() {
  return (
    <svg className={e.icon} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 12a8 8 0 1 0 2.3-5.6M4 4v5h5" />
    </svg>
  );
}

/** Find a person by link or id; the person's page data is the answer. */
function PersonLookup({ onFound, onCancel }: { onFound: (ref: PersonRef) => void; onCancel: () => void }) {
  const { t } = useLang();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const look = async () => {
    const id = personIdFromInput(text);
    if (id === null) {
      setFailed(true);
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/people/${id}`, { headers: { Accept: "application/json" } });
      const body = res.ok ? ((await res.json()) as { data?: PersonRef }) : null;
      if (!body?.data) {
        setFailed(true);
        return;
      }
      const { anilistId, name, image } = body.data;
      onFound({ anilistId, name, image });
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void look();
    } else if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
  };

  return (
    <div className={e.lookup}>
      <input
        // The field the reader just asked for, by pressing 更换 or + 添加声优.
        autoFocus
        className={e.field}
        aria-label={t("peopleEdit.personLookup")}
        placeholder={t("peopleEdit.personLookup")}
        value={text}
        maxLength={200}
        onChange={(event) => {
          setText(event.target.value);
          setFailed(false);
        }}
        onKeyDown={onKeyDown}
      />
      <button type="button" className={`${e.btn} ${e.btnSmall}`} disabled={busy} onClick={() => void look()}>
        {t("peopleEdit.lookup")}
      </button>
      <button type="button" className={e.iconButton} aria-label={t("peopleEdit.cancel")} onClick={onCancel}>
        <XIcon />
      </button>
      {failed ? (
        <span className={e.lookupError} role="alert">
          {t("peopleEdit.lookupFailed")}
        </span>
      ) : null}
    </div>
  );
}

interface VoicesEditorProps {
  voices: VoiceDraft[];
  onChange: (voices: VoiceDraft[]) => void;
}

/** A row's identity in the list: its key, or the added person. */
const rowId = (v: VoiceDraft) => v.key ?? `new:${v.person.anilistId}`;

export default function VoicesEditor({ voices, onChange }: VoicesEditorProps) {
  const { lang, t } = useLang();
  const [replacing, setReplacing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const update = (id: string, next: (v: VoiceDraft) => VoiceDraft) =>
    onChange(voices.map((v) => (rowId(v) === id ? next(v) : v)));

  const remove = (v: VoiceDraft) => {
    // An added row simply goes; a credited one is marked, so it can be restored.
    if (v.key === null) onChange(voices.filter((x) => x !== v));
    else update(rowId(v), (x) => ({ ...x, removed: !x.removed }));
  };

  const add = (ref: PersonRef) => {
    setAdding(false);
    if (voices.some((v) => v.key === null && v.person.anilistId === ref.anilistId)) return;
    onChange([...voices, { key: null, person: ref, initialPersonId: null, line: "", initialLine: "", removed: false }]);
  };

  return (
    <section className={p.section} aria-labelledby="voices-heading">
      <SectionHead id="voices-heading" title={t("people.voices")} count={voices.filter((v) => !v.removed).length} />
      <div className={e.voiceGrid}>
        {voices.map((v) => {
          const id = rowId(v);
          const changed =
            v.key === null || v.removed || v.person.anilistId !== v.initialPersonId || v.line.trim() !== v.initialLine.trim();
          const name = personDisplayName(v.person.name, lang) || `#${v.person.anilistId}`;
          return (
            <div key={id} className={e.voiceRow} data-changed={changed} data-removed={v.removed}>
              <FadeImage src={v.person.image} alt="" width={46} height={46} className={e.avatar} />
              <div className={e.voiceMain}>
                {replacing === id ? (
                  <PersonLookup
                    onFound={(ref) => {
                      setReplacing(null);
                      update(id, (x) => ({ ...x, person: ref }));
                    }}
                    onCancel={() => setReplacing(null)}
                  />
                ) : (
                  <div className={e.voiceName}>{name}</div>
                )}
                <input
                  className={`${e.field} ${e.lineInput}`}
                  aria-label={t("peopleEdit.voiceNote")}
                  value={v.line}
                  maxLength={LIMITS.line}
                  disabled={v.removed}
                  onChange={(event) => update(id, (x) => ({ ...x, line: event.target.value }))}
                />
              </div>
              {!v.removed && replacing !== id ? (
                <button type="button" className={`${e.btn} ${e.btnSmall} ${e.ghost}`} onClick={() => setReplacing(id)}>
                  {t("peopleEdit.replace")}
                </button>
              ) : null}
              <button
                type="button"
                className={e.iconButton}
                aria-label={v.removed ? t("peopleEdit.restoreVoice") : t("peopleEdit.removeVoice")}
                onClick={() => remove(v)}
              >
                {v.removed ? <RestoreIcon /> : <XIcon />}
              </button>
            </div>
          );
        })}
        {adding ? (
          <div className={e.voiceRow}>
            <div className={e.voiceMain}>
              <PersonLookup onFound={add} onCancel={() => setAdding(false)} />
            </div>
          </div>
        ) : (
          <button type="button" className={e.addTile} onClick={() => setAdding(true)}>
            {t("peopleEdit.addVoice")}
          </button>
        )}
      </div>
    </section>
  );
}
