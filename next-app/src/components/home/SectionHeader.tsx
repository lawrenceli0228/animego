// The header row every homepage section shares. No hooks and no "use client":
// server sections render it directly, client sections import it the same way.

import type { ReactNode } from "react";
import Link from "@/components/ui/LocaleLink";
import { ChevronIcon } from "./icons";
import styles from "./section.module.css";

interface SectionHeaderProps {
  id: string;
  title: string;
  /** A number beside the title (mono). */
  count?: number;
  /** A quiet note after the title: data source, date, grouping rule. */
  note?: ReactNode;
  link?: { href: string; label: string };
  /** Anything else for the right-hand side, e.g. a button. */
  action?: ReactNode;
  /** Parts the phone layout leaves out, where the header has no room for them. */
  phoneHides?: ReadonlyArray<"note" | "link">;
}

export default function SectionHeader({ id, title, count, note, link, action, phoneHides = [] }: SectionHeaderProps) {
  const hide = (part: "note" | "link") => (phoneHides.includes(part) ? ` ${styles.desktopOnly}` : "");
  return (
    <div className={styles.head}>
      <span className={styles.rule} aria-hidden />
      <h2 id={id} className={styles.title}>
        {title}
      </h2>
      {typeof count === "number" ? <span className={styles.count}>{count}</span> : null}
      {note ? <span className={`${styles.note}${hide("note")}`}>{note}</span> : null}
      <span className={styles.spacer} />
      {action}
      {link ? (
        <Link href={link.href} prefetch={false} className={`${styles.link}${hide("link")}`}>
          {link.label}
          <ChevronIcon className={styles.linkIcon} />
        </Link>
      ) : null}
    </div>
  );
}
