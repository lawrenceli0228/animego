// The last box in the schedule's aside: next season's new shows, how many
// the catalogue already has, and the month they start. Server component.

import Link from "@/components/ui/LocaleLink";
import { ChevronIcon } from "@/components/home/icons";
import styles from "./aside.module.css";

interface NextSeasonLinkProps {
  href: string;
  /** "2027 冬季新番" */
  title: string;
  /** "已公布 47 部 · 1 月开播" — already joined by the page. */
  sub: string;
}

export default function NextSeasonLink({ href, title, sub }: NextSeasonLinkProps) {
  return (
    <Link href={href} prefetch={false} className={`${styles.box} ${styles.next}`}>
      <span className={styles.nextText}>
        <span className={styles.nextTitle}>{title}</span>
        <span className={styles.nextSub}>{sub}</span>
      </span>
      <ChevronIcon size={18} className={styles.chevron} />
    </Link>
  );
}
