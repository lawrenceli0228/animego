// The top of a person or character page: the portrait, the name in the
// reader's language with the other two under it, aliases, tags, the profile
// facts, and (characters) the description.
//
// `actions` is the slot the canvas's 「编辑」 goes in (EditLink, passed by the
// two views). It renders nothing when nothing is passed.

import type { ReactNode } from "react";
import FadeImage from "@/components/ui/FadeImage";
import s from "./people.module.css";

export interface Fact {
  label: string;
  /** Null renders an em dash: an absent fact is itself information. */
  value: string | null;
}

interface ProfileHeaderProps {
  kind: "person" | "character";
  image: string | null;
  heading: string;
  native: string | null;
  /** The native name's language, when known: lang attribute and typeface. */
  nativeLang?: "ja" | "zh" | "ko" | null;
  romaji: string | null;
  aliases?: string[];
  aliasLabel?: string;
  tags?: string[];
  /** Omitted when there is no profile to take them from. */
  facts?: Fact[];
  about?: { title: string; body: ReactNode } | null;
  actions?: ReactNode;
}

/** The portrait sizes the canvas draws, which are also AniList's large image. */
const PORTRAIT = {
  character: { width: 230, height: 345 },
  person: { width: 200, height: 300 },
} as const;

export default function ProfileHeader({
  kind,
  image,
  heading,
  native,
  nativeLang = null,
  romaji,
  aliases = [],
  aliasLabel,
  tags = [],
  facts,
  about,
  actions,
}: ProfileHeaderProps) {
  const size = PORTRAIT[kind];
  return (
    <section className={s.header} data-kind={kind} aria-labelledby="profile-name">
      <div className={s.portraitSlot}>
        <FadeImage
          src={image}
          alt={heading}
          width={size.width}
          height={size.height}
          priority
          className={s.portrait}
        />
      </div>

      <div className={s.headMain}>
        <div className={s.titleBlock}>
          <h1 id="profile-name" className={s.name}>
            {heading}
          </h1>
          {native || romaji ? (
            <div className={s.subNames}>
              {native ? (
                <span
                  className={nativeLang === "ja" ? `${s.nativeName} ${s.jp}` : s.nativeName}
                  lang={nativeLang ?? undefined}
                >
                  {native}
                </span>
              ) : null}
              {native && romaji ? <span className={s.dot} aria-hidden="true" /> : null}
              {romaji ? (
                <span className={s.romajiName}>{romaji}</span>
              ) : null}
            </div>
          ) : null}
          {aliases.length > 0 ? (
            <div className={s.aliasRow}>
              {aliasLabel ? <span className={s.aliasLabel}>{aliasLabel}</span> : null}
              {aliases.map((a) => (
                <span key={a} className={s.alias}>
                  {a}
                </span>
              ))}
            </div>
          ) : null}
          {tags.length > 0 ? (
            <div className={s.tags}>
              {tags.map((t) => (
                <span key={t} className={s.tag}>
                  {t}
                </span>
              ))}
            </div>
          ) : null}
        </div>
        {actions ? <div className={s.actions}>{actions}</div> : null}
      </div>

      {facts && facts.length > 0 ? (
        <dl className={s.facts}>
          {facts.map((f) => (
            <div key={f.label} className={s.factPair}>
              <dt className={s.factLabel}>{f.label}</dt>
              <dd className={`${s.factValue} ${f.value ? "" : s.factEmpty}`}>{f.value ?? "—"}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {about ? (
        <section className={s.about} aria-labelledby="profile-about">
          <h2 id="profile-about" className={s.aboutTitle}>
            {about.title}
          </h2>
          {about.body}
        </section>
      ) : null}
    </section>
  );
}
