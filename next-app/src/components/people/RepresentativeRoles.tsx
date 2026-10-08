// 代表角色: the few roles a person page leads with (the API picks them: lead
// roles in the most popular titles first, a character once, a title once).
// Row cards on a desktop; a strip of portraits on a phone.

import Link from "@/components/ui/LocaleLink";
import FadeImage from "@/components/ui/FadeImage";
import type { Dict } from "@/lib/i18n";
import type { Lang } from "@/lib/i18n/lang";
import { pickTitle } from "@/lib/formatters";
import { characterDisplayName } from "@/lib/people/names";
import { characterRoleLabel } from "@/lib/people/labels";
import { animePath, characterPath } from "@/lib/people/paths";
import type { VoiceRole } from "@/lib/people/types";
import SectionHead from "./SectionHead";
import c from "./cards.module.css";
import s from "./people.module.css";

interface RepresentativeRolesProps {
  roles: VoiceRole[];
  lang: Lang;
  dict: Dict;
}

export default function RepresentativeRoles({ roles, lang, dict }: RepresentativeRolesProps) {
  if (roles.length === 0) return null;
  return (
    <section className={s.section} aria-labelledby="representative-heading">
      <SectionHead id="representative-heading" title={dict.people.representativeRoles} count={roles.length} />
      <div className={c.repGrid}>
        {roles.map((role) => {
          const name = characterDisplayName(role.character.name, lang) || "—";
          const title = pickTitle(role.anime, lang) || role.anime.titleRomaji || "";
          const roleLabel = characterRoleLabel(role.role, lang);
          const characterHref = characterPath(role.character.anilistId);
          return (
            <article key={`${role.anime.anilistId}-${role.character.anilistId}`} className={c.repCard}>
              <Link href={characterHref} prefetch={false} tabIndex={-1} aria-hidden="true" className={c.repImageLink}>
                <FadeImage src={role.character.image} alt="" width={120} height={180} className={c.repImage} />
              </Link>
              <div className={c.repText}>
                <Link href={characterHref} prefetch={false} className={c.repName}>
                  {name}
                </Link>
                <div className={c.repSub}>
                  <Link href={animePath(role.anime.anilistId)} prefetch={false} className={c.repTitle}>
                    {title}
                  </Link>
                  {roleLabel ? <span className={c.repRole}>{` · ${roleLabel}`}</span> : null}
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
