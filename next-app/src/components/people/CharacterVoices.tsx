// 声优: every voice of a character, across its titles and languages, with
// the notes that tell them apart (日配 · 童年). Cards on a desktop; a list
// with a chevron on a phone. Each one goes to the person's page.

import Link from "@/components/ui/LocaleLink";
import FadeImage from "@/components/ui/FadeImage";
import type { Dict } from "@/lib/i18n";
import type { Lang } from "@/lib/i18n/lang";
import { personDisplayName } from "@/lib/people/names";
import { voiceLine } from "@/lib/people/labels";
import { personPath } from "@/lib/people/paths";
import type { CharacterVoice } from "@/lib/people/types";
import SectionHead from "./SectionHead";
import c from "./cards.module.css";
import s from "./people.module.css";

interface CharacterVoicesProps {
  voices: CharacterVoice[];
  lang: Lang;
  dict: Dict;
}

export default function CharacterVoices({ voices, lang, dict }: CharacterVoicesProps) {
  if (voices.length === 0) return null;
  return (
    <section className={s.section} aria-labelledby="voices-heading">
      <SectionHead id="voices-heading" title={dict.people.voices} count={voices.length} />
      <div className={c.voiceGrid}>
        {voices.map((v) => {
          const name = personDisplayName(v.person.name, lang) || "—";
          const line = voiceLine(v.language, v.roleNotes, lang);
          return (
            <Link
              key={`${v.person.anilistId}-${v.language ?? ""}-${v.roleNotes ?? ""}`}
              href={personPath(v.person.anilistId)}
              prefetch={false}
              className={c.voiceCard}
            >
              <FadeImage src={v.person.image} alt="" width={46} height={46} className={c.avatar} />
              <div className={c.voiceText}>
                <div className={c.voiceName}>{name}</div>
                {line ? <div className={c.voiceSub}>{line}</div> : null}
              </div>
              <svg className={c.chevron} viewBox="0 0 24 24" aria-hidden="true">
                <path d="M9 6l6 6-6 6" />
              </svg>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
