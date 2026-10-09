// 「编辑」 in a person's or character's header: a link to the page's edit
// state (…/edit). A link and not a button, so the page around it stays a
// static render that knows nothing about the reader; the edit route decides
// who may edit, and sends a signed-out reader to log in and back.
//
// rel="nofollow" and no prefetch: the target is a per-reader page that
// crawlers have no use for and readers rarely open.

import Link from "@/components/ui/LocaleLink";
import s from "./people.module.css";

export default function EditLink({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} prefetch={false} rel="nofollow" className={s.editLink}>
      <svg className={s.editIcon} viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 20h4L19 9l-4-4L4 16z" />
      </svg>
      {label}
    </Link>
  );
}
