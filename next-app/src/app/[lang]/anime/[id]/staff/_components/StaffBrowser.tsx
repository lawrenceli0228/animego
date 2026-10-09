"use client";

// The 制作 tab: a title's staff grouped by department, with department chips
// to narrow it to one, a search over names and roles, and — for a department
// of dozens or hundreds, like key animation — names only.
//
// The server renders the whole grouping (the API gives every credit at once,
// at most 400), so the cached HTML carries every department; the chips and
// the search filter that in place, with no request.
//
// In the 全部 view each department shows its first few and 「展开全部 N 位」;
// choosing a department, or searching, shows everyone who matches. Every row
// and every name opens the person's page, as the design's rows do; a credit
// written before AniList ids were stored has no page to open and stays text.

import { useDeferredValue, useMemo, useRef, useState } from "react";
import FadeImage from "@/components/ui/FadeImage";
import Link from "@/components/ui/LocaleLink";
import { staffRoleLabel } from "@/lib/contentLabels";
import {
  DEPARTMENT_LABEL,
  PREVIEW_NAMES,
  PREVIEW_PEOPLE,
  groupStaff,
  isNamesOnly,
  normalizeSearch,
  searchStaff,
  staffPeopleCount,
  type DepartmentKey,
  type StaffPerson,
} from "@/lib/detail/staffDepartments";
import { pickStaffName } from "@/lib/formatters";
import { fillTemplate } from "@/lib/home/time";
import type { Lang } from "@/lib/i18n/lang";
import { useLang } from "@/lib/lang-client";
import { personPath } from "@/lib/people/paths";
import type { StaffCredit } from "@/lib/types";
// The section head the overview's sections use (rule, title, count, and
// the 「全部」 link style), so a department reads as one of them.
import x from "../../sections.module.css";
import s from "./StaffBrowser.module.css";

const AVATAR = 46;

type DeptFilter = DepartmentKey | "all";

/** The name first, then the other one — Japanese and English, per the site's ladder. */
function staffNames(p: StaffPerson, lang: Lang): { name: string; alt: string | null } {
  const name = pickStaffName(p, lang) || p.nameCn || "—";
  const alt = [p.nameJa, p.nameEn].find((n) => n && n.trim() && n.trim() !== name) ?? null;
  return { name, alt };
}

function PersonRow({ person, lang }: { person: StaffPerson; lang: Lang }) {
  const { name, alt } = staffNames(person, lang);
  const roles = person.roles.map((r) => staffRoleLabel(r, lang)).join(" · ");
  const body = (
    <>
      {/* alt="": the name is right beside it, and would be read twice. */}
      {person.imageUrl ? (
        <FadeImage src={person.imageUrl} alt="" width={AVATAR} height={AVATAR} className={s.avatar} />
      ) : (
        <span className={s.avatarEmpty} aria-hidden>
          {Array.from(name)[0]}
        </span>
      )}
      <div className={s.personText}>
        <div className={s.personNames}>
          <span className={s.personName}>{name}</span>
          {alt ? <span className={s.personAlt}>{alt}</span> : null}
        </div>
        {roles ? <div className={s.personRoles}>{roles}</div> : null}
      </div>
    </>
  );
  return (
    <li className={s.personItem}>
      {person.staffId != null ? (
        <Link href={personPath(person.staffId)} className={s.person} prefetch={false}>
          {body}
        </Link>
      ) : (
        <div className={s.person}>{body}</div>
      )}
    </li>
  );
}

export default function StaffBrowser({ credits }: { credits: StaffCredit[] }) {
  const { lang, t } = useLang();
  const departments = useMemo(() => groupStaff(credits), [credits]);
  const [dept, setDept] = useState<DeptFilter>("all");
  // What the box shows, and the query the list is filtered by. They differ
  // while an input method composes: pinyin or kana is not a name yet, and
  // filtering by it empties the list under the reader's fingers (#129).
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const composingRef = useRef(false);
  const [expanded, setExpanded] = useState<ReadonlySet<DepartmentKey>>(() => new Set());
  // Filtering 400 credits is cheap, but not free on a slow phone; typing
  // stays responsive and the list catches up.
  const deferredQuery = useDeferredValue(query);
  const searching = normalizeSearch(deferredQuery) !== "";
  const matched = useMemo(
    () => searchStaff(departments, deferredQuery, lang),
    [departments, deferredQuery, lang],
  );
  const visible = dept === "all" ? matched : matched.filter((d) => d.key === dept);
  const countOf = (key: DepartmentKey) => matched.find((d) => d.key === key)?.people.length ?? 0;

  const toggle = (key: DepartmentKey) =>
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <section className={s.root} aria-labelledby="staff-heading">
      <h2 className={s.srOnly} id="staff-heading">
        {t("detail.staffHeading")}
      </h2>

      {departments.length === 0 ? (
        <div className={s.empty}>
          <p className={s.emptyText}>{t("detail.staffNone")}</p>
        </div>
      ) : (
        <>
          {/* Announces how many people a chip or the search leaves. */}
          <p className={s.srOnly} aria-live="polite">
            {fillTemplate(t("detail.resultCount"), { n: staffPeopleCount(visible) })}
          </p>

          <div className={s.toolbar}>
            <div className={s.chips} role="group" aria-label={t("detail.deptFilterAria")}>
              <button
                type="button"
                className={s.chip}
                aria-pressed={dept === "all"}
                onClick={() => setDept("all")}
              >
                {t("detail.filterAll")} <span className={s.chipCount}>{staffPeopleCount(matched)}</span>
              </button>
              {departments.map((d) => (
                <button
                  key={d.key}
                  type="button"
                  className={s.chip}
                  aria-pressed={dept === d.key}
                  onClick={() => setDept(d.key)}
                >
                  {DEPARTMENT_LABEL[lang][d.key]} <span className={s.chipCount}>{countOf(d.key)}</span>
                </button>
              ))}
            </div>
            <label className={s.searchBox}>
              <svg className={s.searchIcon} viewBox="0 0 24 24" aria-hidden>
                <circle cx="11" cy="11" r="7" />
                <path d="M20 20l-3.5-3.5" />
              </svg>
              <input
                className={s.searchInput}
                type="search"
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  if (!composingRef.current) setQuery(e.target.value);
                }}
                onCompositionStart={() => {
                  composingRef.current = true;
                }}
                // Read the value here as well as on change: Chrome and Safari
                // order the last input event and compositionend differently.
                onCompositionEnd={(e) => {
                  composingRef.current = false;
                  setInput(e.currentTarget.value);
                  setQuery(e.currentTarget.value);
                }}
                // A compositionend that never comes must not freeze the list.
                onBlur={(e) => {
                  if (!composingRef.current) return;
                  composingRef.current = false;
                  setQuery(e.currentTarget.value);
                }}
                placeholder={t("detail.searchStaff")}
                aria-label={t("detail.searchStaff")}
                maxLength={64}
                enterKeyHint="search"
              />
            </label>
          </div>

          {visible.length === 0 ? (
            <div className={s.empty}>
              <p className={s.emptyText}>{t("detail.staffEmpty")}</p>
            </div>
          ) : (
            visible.map((d) => {
              const namesOnly = isNamesOnly(d);
              const cap = namesOnly ? PREVIEW_NAMES : PREVIEW_PEOPLE;
              const capped = dept === "all" && !searching && !expanded.has(d.key);
              const people = capped ? d.people.slice(0, cap) : d.people;
              const canExpand = dept === "all" && !searching && d.people.length > cap;
              const headingId = `dept-${d.key}`;
              return (
                <section key={d.key} className={s.dept} aria-labelledby={headingId}>
                  <header className={x.head}>
                    <h3 className={x.headTitle} id={headingId}>
                      {DEPARTMENT_LABEL[lang][d.key]}
                    </h3>
                    <span className={x.headCount}>{d.people.length}</span>
                    {canExpand ? (
                      <button
                        type="button"
                        className={`${x.headMore} ${s.expand}`}
                        aria-expanded={!capped}
                        onClick={() => toggle(d.key)}
                      >
                        {capped
                          ? fillTemplate(t("detail.expandAll"), { n: d.people.length })
                          : t("detail.collapse")}
                      </button>
                    ) : null}
                  </header>
                  {namesOnly ? (
                    <ul className={s.names}>
                      {people.map((p) => {
                        const roles = p.roles.map((r) => staffRoleLabel(r, lang)).join(" · ");
                        // The roles are a tooltip for a mouse and text for a
                        // screen reader; a touch screen has neither, and the
                        // department heading says most of it.
                        const text = (
                          <>
                            {staffNames(p, lang).name}
                            {roles ? <span className={s.srOnly}> {roles}</span> : null}
                          </>
                        );
                        return (
                          <li key={p.key}>
                            {p.staffId != null ? (
                              <Link
                                href={personPath(p.staffId)}
                                className={s.nameChip}
                                title={roles || undefined}
                                prefetch={false}
                              >
                                {text}
                              </Link>
                            ) : (
                              <span className={s.nameChip} title={roles || undefined}>
                                {text}
                              </span>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <ul className={s.people}>
                      {people.map((p) => (
                        <PersonRow key={p.key} person={p} lang={lang} />
                      ))}
                    </ul>
                  )}
                </section>
              );
            })
          )}
        </>
      )}
    </section>
  );
}
