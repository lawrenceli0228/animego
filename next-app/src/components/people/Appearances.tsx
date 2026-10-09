// 出演作品: the titles a character is on, earliest first, with the
// character's role in each on the cover and "format · year" under the title.
// A grid on a desktop; a strip to swipe on a phone.

import Link from "@/components/ui/LocaleLink";
import FadeImage from "@/components/ui/FadeImage";
import type { Dict } from "@/lib/i18n";
import type { Lang } from "@/lib/i18n/lang";
import { pickTitle } from "@/lib/formatters";
import { formatLabel } from "@/lib/contentLabels";
import { characterRoleLabel } from "@/lib/people/labels";
import { animePath } from "@/lib/people/paths";
import type { Appearance } from "@/lib/people/types";
import SectionHead from "./SectionHead";
import c from "./cards.module.css";
import s from "./people.module.css";

interface AppearancesProps {
  appearances: Appearance[];
  lang: Lang;
  dict: Dict;
}

export default function Appearances({ appearances, lang, dict }: AppearancesProps) {
  if (appearances.length === 0) return null;
  return (
    <section className={s.section} aria-labelledby="appearances-heading">
      <SectionHead id="appearances-heading" title={dict.people.appearances} count={appearances.length} />
      <div className={`${c.posterGrid} ${c.posterStrip}`}>
        {appearances.map((a) => {
          const title = pickTitle(a.anime, lang) || a.anime.titleRomaji || "";
          const role = characterRoleLabel(a.role, lang);
          const meta = [a.anime.format ? formatLabel(a.anime.format, lang) : null, a.anime.year]
            .filter((v) => v !== null && v !== "")
            .join(" · ");
          return (
            <Link key={a.anime.anilistId} href={animePath(a.anime.anilistId)} prefetch={false} className={c.posterCard}>
              <div className={c.posterFrame}>
                <FadeImage src={a.anime.coverImageUrl} alt={title} width={180} height={270} className={c.posterImage} />
                {role ? <span className={c.posterTag}>{role}</span> : null}
              </div>
              <div className={c.posterTitle}>{title}</div>
              {meta ? <div className={`${c.posterMeta} ${s.num}`}>{meta}</div> : null}
            </Link>
          );
        })}
      </div>
    </section>
  );
}
