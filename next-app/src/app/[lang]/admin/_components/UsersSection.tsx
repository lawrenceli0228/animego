"use client";

// User management on the single /admin page: the segment chips with their
// sizes, the activity panel's depth filter, search, sort, the table, the
// pager — and the detail drawer every row opens.
//
// State lives here: the committed query, the page it produced, which row's
// menu is open, and which account the drawer shows. None of it is in the
// URL. Next's router owns history and this page is one scroll of sections,
// so the activity panel hands its depth filter over as a window event
// (ADMIN_USERS_DEPTH_EVENT) instead.
//
// Fetching follows ActivitySection's shape: the server renders the default
// query; the effect fetches only when the query (or the reload counter a
// mutation bumps) differs from the one the held page answers; every setState
// happens inside the async helper, never in the effect body; and a request
// that is superseded is aborted rather than raced.
//
// The drawer is loaded with next/dynamic: it is the half of this surface
// that calls toast(), and react-hot-toast touches `document` on import (see
// testImportHygiene.test.ts). Nothing about it belongs in the server HTML.

import dynamic from "next/dynamic";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { fillTemplate } from "@/lib/home/time";
import { useLang } from "@/lib/lang-client";
import {
  ADMIN_USERS_DEPTH_EVENT,
  DEFAULT_USERS_QUERY,
  formatCount,
  parseDepthDetail,
  readUsersPage,
  usersQueryString,
  type AdminUsersQuery,
  type UserDrawerMode,
  type UserDrawerTarget,
} from "@/lib/adminUsers";
import type { AdminUserRow, AdminUserSort, AdminUsersPage } from "../_types/users";
import { CreateUserForm } from "./CreateUserForm";
import { UserRow } from "./UserRow";
import { UsersToolbar } from "./UsersToolbar";
import s from "./users.module.css";

const UserDetailDrawer = dynamic(() => import("./UserDetailDrawer"), { ssr: false });

/** Idle time after the last keystroke before the search is committed. */
const DEBOUNCE_MS = 400;

interface UsersSectionProps {
  /** Null when the server-side fetch failed; the section then fetches on its own. */
  initial: AdminUsersPage | null;
}

async function fetchUsersPage(query: string, signal: AbortSignal): Promise<AdminUsersPage> {
  // Same-origin: nginx proxies /api/* to go-api in prod, next dev rewrites it.
  const res = await fetch(`/api/admin/users?${query}`, {
    credentials: "same-origin",
    cache: "no-store",
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const page = readUsersPage(await res.json());
  if (!page) throw new Error("unreadable user list");
  return page;
}

const requestKey = (query: string, reload: number) => `${query}#${reload}`;

export function UsersSection({ initial }: UsersSectionProps) {
  const { t } = useLang();
  const createId = useId();
  const [query, setQuery] = useState<AdminUsersQuery>(DEFAULT_USERS_QUERY);
  const [search, setSearch] = useState("");
  const [data, setData] = useState<AdminUsersPage | null>(initial);
  const [reload, setReload] = useState(0);
  // What `data` answers. Seeded with the server's query so hydration does not
  // refetch the page it was just handed.
  const [loaded, setLoaded] = useState<string | null>(() =>
    initial ? requestKey(usersQueryString(DEFAULT_USERS_QUERY), 0) : null,
  );
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(initial === null);
  const [createOpen, setCreateOpen] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<UserDrawerTarget | null>(null);
  // Where focus goes when the drawer closes: its opener, or the heading after
  // a delete (the opener's row is about to leave the table).
  const openerRef = useRef<HTMLElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  const queryString = usersQueryString(query);
  const wanted = requestKey(queryString, reload);

  useEffect(() => {
    if (wanted === loaded) return;
    const ac = new AbortController();
    const run = async () => {
      setLoading(true);
      setFailed(false);
      try {
        const page = await fetchUsersPage(queryString, ac.signal);
        if (ac.signal.aborted) return;
        setData(page);
        setFailed(false);
      } catch {
        // An abort is a newer query, not a failure.
        if (ac.signal.aborted) return;
        setFailed(true);
      } finally {
        if (!ac.signal.aborted) {
          setLoaded(wanted);
          setLoading(false);
        }
      }
    };
    void run();
    return () => ac.abort();
  }, [wanted, loaded, queryString]);

  // Debounced search: the box updates at once, the query 400ms after typing stops.
  useEffect(() => {
    const next = search.trim();
    if (next === query.q) return;
    const timer = setTimeout(() => {
      setMenuFor(null);
      setQuery((prev) => ({ ...prev, q: next, page: 1 }));
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search, query.q]);

  // The activity panel's depth rows. "Show me that bucket" means the whole
  // bucket, so the segment and the search are cleared with it.
  useEffect(() => {
    const onDepth = (event: Event) => {
      const depth = parseDepthDetail((event as CustomEvent<unknown>).detail);
      if (!depth) return;
      setSearch("");
      setMenuFor(null);
      setQuery((prev) => ({ ...prev, page: 1, q: "", segment: "all", depth }));
    };
    window.addEventListener(ADMIN_USERS_DEPTH_EVENT, onDepth);
    return () => window.removeEventListener(ADMIN_USERS_DEPTH_EVENT, onDepth);
  }, []);

  /** Any filter change goes back to page 1; paging passes its own page. */
  const update = (patch: Partial<AdminUsersQuery>) => {
    setMenuFor(null);
    setQuery((prev) => ({ ...prev, page: 1, ...patch }));
  };

  const refetch = useCallback(() => setReload((n) => n + 1), []);

  const openDrawer = useCallback((user: AdminUserRow, mode: UserDrawerMode, opener: HTMLElement | null) => {
    openerRef.current = opener;
    setMenuFor(null);
    setDrawer({
      id: user._id,
      username: user.username,
      email: user.email,
      role: user.role,
      createdAt: user.createdAt,
      mode,
    });
  }, []);

  const closeDrawer = useCallback(() => setDrawer(null), []);

  // Stable, so the drawer calls it once, as it unmounts. Falls back to the
  // heading when the opener has left the page.
  const restoreFocus = useCallback(() => {
    const opener = openerRef.current;
    const target = opener && opener.isConnected ? opener : headingRef.current;
    target?.focus({ preventScroll: true });
  }, []);

  const afterDelete = useCallback(() => {
    openerRef.current = headingRef.current;
    setDrawer(null);
    setReload((n) => n + 1);
  }, []);

  const rows = data?.data ?? [];
  const today = data?.today ?? "";
  const allUsers = data?.segments?.all ?? data?.total;

  const sortHeader = (label: string, key: AdminUserSort | null, numeric = false) => {
    const sorted = key !== null && query.sort === key;
    return (
      <th
        scope="col"
        className={numeric ? `${s.th} ${s.thNum}` : s.th}
        aria-sort={sorted ? "descending" : undefined}
      >
        {label}
        {sorted ? <span aria-hidden="true"> ↓</span> : null}
      </th>
    );
  };

  return (
    <section id="users" aria-labelledby="users-heading">
      <header className={s.head}>
        <div className={s.titleRow}>
          <h2 id="users-heading" ref={headingRef} tabIndex={-1} className={s.title}>
            {t("admin.usersTitle")}
          </h2>
          {typeof allUsers === "number" ? (
            <span className={s.total}>{fillTemplate(t("admin.totalUsers"), { count: formatCount(allUsers) })}</span>
          ) : null}
        </div>
        <button
          type="button"
          className={s.primary}
          aria-expanded={createOpen}
          aria-controls={createOpen ? createId : undefined}
          onClick={() => setCreateOpen((open) => !open)}
        >
          {createOpen ? t("admin.userPanel.collapse") : t("admin.createUser")}
        </button>
      </header>

      {createOpen ? <CreateUserForm id={createId} onCreated={refetch} /> : null}

      <UsersToolbar
        segments={data?.segments ?? {}}
        segment={query.segment}
        onSegment={(segment) => update({ segment })}
        depth={query.depth}
        onClearDepth={() => update({ depth: null })}
        search={search}
        onSearch={setSearch}
        onSearchSubmit={() => update({ q: search.trim() })}
        sort={query.sort}
        onSort={(sort) => update({ sort })}
      />

      {failed ? (
        <div role="alert" className={s.listError}>
          <span>{t("admin.userPanel.loadError")}</span>
          <button type="button" className={s.btn} onClick={refetch}>
            {t("admin.userPanel.retry")}
          </button>
        </div>
      ) : null}

      {data ? (
        <>
          <div className={s.scroll} aria-busy={loading || undefined}>
            <table className={s.table}>
              <thead>
                <tr>
                  {sortHeader(t("admin.userPanel.colUser"), null)}
                  {sortHeader(t("admin.userPanel.colJoined"), "joined")}
                  {sortHeader(t("admin.userPanel.colLastSeen"), "lastSeen")}
                  {sortHeader(t("admin.userPanel.colRecent"), "activeDays")}
                  {sortHeader(t("admin.userPanel.colSubs"), "subscriptions", true)}
                  {sortHeader(t("admin.userPanel.colRatings"), null, true)}
                  {sortHeader(t("admin.userPanel.colWatched"), "watched", true)}
                  {sortHeader(t("admin.userPanel.colDevice"), null)}
                  <th scope="col" className={s.th}>
                    <span className={s.srOnly}>{t("admin.userPanel.colActions")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td className={s.empty} colSpan={9}>
                      {t("admin.noMatchingUsers")}
                    </td>
                  </tr>
                ) : (
                  rows.map((user) => (
                    <UserRow
                      key={user._id}
                      user={user}
                      today={today}
                      menuOpen={menuFor === user._id}
                      onMenu={setMenuFor}
                      onOpen={openDrawer}
                    />
                  ))
                )}
              </tbody>
            </table>
          </div>

          <footer className={s.pager}>
            <button
              type="button"
              className={s.pageBtn}
              disabled={query.page <= 1}
              onClick={() => update({ page: Math.max(1, query.page - 1) })}
            >
              ← {t("admin.prev")}
            </button>
            <span className={s.pageInfo}>
              {fillTemplate(t("admin.pageIndicator"), { page: query.page, total: formatCount(data.total) })}
            </span>
            <button
              type="button"
              className={s.pageBtn}
              disabled={!data.hasMore}
              onClick={() => update({ page: query.page + 1 })}
            >
              {t("admin.next")} →
            </button>
          </footer>
        </>
      ) : failed ? null : (
        // No page yet: the server's fetch failed and the browser's is out.
        <p className={s.empty} role="status">
          {t("admin.userPanel.loading")}
        </p>
      )}

      {drawer ? (
        <UserDetailDrawer
          key={drawer.id}
          target={drawer}
          onRestoreFocus={restoreFocus}
          onClose={closeDrawer}
          onChanged={refetch}
          onDeleted={afterDelete}
        />
      ) : null}
    </section>
  );
}
