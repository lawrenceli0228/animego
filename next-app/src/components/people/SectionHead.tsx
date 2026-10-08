// A section's heading row: the title with its rule, the count, and room on
// the right for a control. The detail page's section head, on this page's
// module.

import type { ReactNode } from "react";
import { splitTemplate } from "@/lib/people/template";
import s from "./people.module.css";

interface SectionHeadProps {
  id: string;
  title: string;
  /** The count, as a number, or inside a "{{n}}" template ("本站收录 {{n}} 部"). */
  count?: number;
  countTemplate?: string;
  tools?: ReactNode;
}

export default function SectionHead({ id, title, count, countTemplate, tools }: SectionHeadProps) {
  const [before, after] = splitTemplate(countTemplate ?? "{{n}}", "n");
  return (
    <header className={s.sectionHead}>
      <h2 id={id} className={s.sectionTitle}>
        {title}
      </h2>
      {count !== undefined ? (
        <span className={s.sectionCount}>
          {before}
          <span className={s.num}>{count}</span>
          {after}
        </span>
      ) : null}
      {tools ? <div className={s.sectionTools}>{tools}</div> : null}
    </header>
  );
}
