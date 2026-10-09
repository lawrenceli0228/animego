// /admin/edits — the review queue for readers' edits to person and
// character pages (the canvas's ReviewQueue board). The admin layout above
// already requires an admin; go-api requires one again on every call.
//
// The list and the selected submission come from the URL (?status, ?kind,
// ?page, ?id), so a reviewed item, a filter and a page can be linked to and
// survive a reload. With no ?id the first submission in the list is shown.

import type { Metadata } from "next";
import Link from "@/components/ui/LocaleLink";
import { apiGet } from "@/lib/api";
import { fill } from "@/lib/i18n";
import { resolveLocale } from "@/lib/i18n/route";
import { pickTitle } from "@/lib/formatters";
import { characterDisplayName, personDisplayName } from "@/lib/people/names";
import { panelKey, UUID, type EditList, type EditListItem, type EditSubmission } from "@/lib/people/edit/review";
import ReviewPanel from "./_components/ReviewPanel";
import q from "./edits.module.css";

export async function generateMetadata({ params }: PageProps<"/[lang]/admin/edits">): Promise<Metadata> {
  const { dict } = await resolveLocale(params);
  return { title: dict.editReview.title, robots: { index: false, follow: false } };
}

type Status = "pending" | "reviewed";
type Kind = "" | "character" | "person";

interface Query {
  status: Status;
  kind: Kind;
  page: number;
  id: string | null;
}

function readQuery(sp: Record<string, string | string[] | undefined>): Query {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  const status = one(sp.status) === "reviewed" ? "reviewed" : "pending";
  const kindRaw = one(sp.kind);
  const kind: Kind = kindRaw === "character" || kindRaw === "person" ? kindRaw : "";
  const page = Math.max(1, Math.min(1000, Number.parseInt(one(sp.page), 10) || 1));
  const id = UUID.test(one(sp.id)) ? one(sp.id) : null;
  return { status, kind, page, id };
}

function href(query: Query, patch: Partial<Query>): string {
  const next = { ...query, ...patch };
  const params = new URLSearchParams();
  if (next.status !== "pending") params.set("status", next.status);
  if (next.kind) params.set("kind", next.kind);
  if (next.page > 1) params.set("page", String(next.page));
  if (next.id) params.set("id", next.id);
  const qs = params.toString();
  return qs ? `/admin/edits?${qs}` : "/admin/edits";
}

async function load<T>(path: string): Promise<T | null> {
  try {
    return await apiGet<T>(path, { cache: "no-store" });
  } catch {
    return null;
  }
}

export default async function AdminEditsPage({ params, searchParams }: PageProps<"/[lang]/admin/edits">) {
  const [{ lang, dict }, sp] = await Promise.all([resolveLocale(params), searchParams]);
  const query = readQuery(sp);
  const d = dict.editReview;

  const listParams = new URLSearchParams({ status: query.status, page: String(query.page) });
  if (query.kind) listParams.set("kind", query.kind);
  const list = await load<EditList>(`/api/admin/edits?${listParams}`);
  const selectedId = query.id ?? list?.items[0]?.id ?? null;
  const selected = selectedId ? await load<EditSubmission>(`/api/admin/edits/${selectedId}`) : null;

  const itemTitle = (item: Pick<EditListItem, "kind" | "entityId" | "snapshot">) => {
    const name =
      item.kind === "person" ? personDisplayName(item.snapshot.name, lang) : characterDisplayName(item.snapshot.name, lang);
    const work = item.snapshot.work;
    return [name || `#${item.entityId}`, work ? pickTitle(work, lang) || work.titleRomaji : null].filter(Boolean).join(" · ");
  };
  const itemDetail = (item: EditListItem) =>
    [
      item.kind === "person" ? d.kindPersonOne : d.kindCharacterOne,
      fill(d.changes, { n: item.itemCount }) + (item.hasImage ? d.withImage : ""),
      item.submitter.username,
      item.submitter.accepted > 0 ? fill(d.acceptedBefore, { n: item.submitter.accepted }) : fill(d.nth, { n: item.submitter.nth }),
    ].join(" · ");

  return (
    <div className={q.page}>
      <nav className={q.crumbs} aria-label={dict.people.breadcrumb}>
        <Link href="/admin" prefetch={false}>
          {dict.admin.title}
        </Link>
        <span aria-hidden="true">›</span>
        <span aria-current="page">{d.title}</span>
      </nav>
      <div className={q.titleRow}>
        <h1 className={q.title}>{d.title}</h1>
        {list ? <span className={`${q.state} ${q.stateTone}`}>{fill(d.pendingCount, { n: list.pendingCount })}</span> : null}
        <span className={q.spacer} />
        <nav className={q.segment} aria-label={d.statusFilter}>
          {(["pending", "reviewed"] as const).map((s) => (
            <Link
              key={s}
              href={href(query, { status: s, page: 1, id: null })}
              prefetch={false}
              aria-current={query.status === s ? "page" : undefined}
            >
              {s === "pending" ? d.statusPending : d.statusReviewed}
            </Link>
          ))}
        </nav>
        <nav className={q.segment} aria-label={d.kindFilter}>
          {(["", "character", "person"] as const).map((k) => (
            <Link
              key={k || "all"}
              href={href(query, { kind: k, page: 1, id: null })}
              prefetch={false}
              aria-current={query.kind === k ? "page" : undefined}
            >
              {k === "" ? d.kindAll : k === "character" ? d.kindCharacter : d.kindPerson}
            </Link>
          ))}
        </nav>
      </div>

      <div className={q.grid}>
        <section className={q.list} aria-label={d.listLabel}>
          {!list ? (
            <p className={q.empty}>{d.loadFailed}</p>
          ) : list.items.length === 0 ? (
            <p className={q.empty}>{query.status === "pending" ? d.empty : d.emptyReviewed}</p>
          ) : (
            list.items.map((item) => (
              <Link
                key={item.id}
                href={href(query, { id: item.id })}
                prefetch={false}
                className={q.listItem}
                aria-current={item.id === selectedId ? "true" : undefined}
              >
                <span>
                  <span className={q.itemTitle}>{itemTitle(item)}</span>
                  <span className={q.itemDetail}>{itemDetail(item)}</span>
                </span>
                <span>
                  <span className={item.status === "pending" ? `${q.state} ${q.stateTone}` : q.state}>
                    {item.status === "pending" ? d.statusPending : d.statusReviewed}
                  </span>
                </span>
              </Link>
            ))
          )}
          {list && (query.page > 1 || list.hasMore) ? (
            <div className={q.pager}>
              {query.page > 1 ? (
                <Link href={href(query, { page: query.page - 1, id: null })} prefetch={false}>
                  {d.prevPage}
                </Link>
              ) : (
                <span />
              )}
              {list.hasMore ? (
                <Link href={href(query, { page: query.page + 1, id: null })} prefetch={false}>
                  {d.nextPage}
                </Link>
              ) : null}
            </div>
          ) : null}
        </section>
        <section>{selected ? <ReviewPanel key={panelKey(selected)} submission={selected} /> : null}</section>
      </div>
    </div>
  );
}
