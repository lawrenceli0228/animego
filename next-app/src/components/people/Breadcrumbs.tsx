// The breadcrumb above a person or character page: the title it hangs under
// (see lib/people/primary.ts for which), that title's cast or staff list,
// and the page itself.

import Link from "@/components/ui/LocaleLink";
import s from "./people.module.css";

export interface Crumb {
  label: string;
  /** Omitted for the page itself, which is the last crumb. */
  href?: string;
}

export default function Breadcrumbs({ items, label }: { items: Crumb[]; label: string }) {
  return (
    <nav aria-label={label}>
      <ol className={s.crumbs}>
        {items.map((c, i) => (
          <li key={`${i}-${c.label}`}>
            {i > 0 ? (
              <span className={s.crumbSep} aria-hidden="true">
                ›
              </span>
            ) : null}
            {c.href ? (
              <Link href={c.href} prefetch={false} className={s.crumbLink}>
                {c.label}
              </Link>
            ) : (
              <span aria-current="page">{c.label}</span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
