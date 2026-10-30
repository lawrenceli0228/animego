"use client";

// The controls above the user table: one chip per segment with its size, the
// activity panel's depth filter as a removable chip, the search box and the
// sort select. Presentational — UsersSection owns the query.

import { fillTemplate } from "@/lib/home/time";
import { useLang } from "@/lib/lang-client";
import {
  USER_SEGMENTS,
  USER_SORTS,
  depthChipLabel,
  formatCount,
  isUserSort,
  type AdminUsersDepth,
} from "@/lib/adminUsers";
import type { AdminUserSegment, AdminUserSort } from "../_types/users";
import { useUserWords } from "./userWords";
import s from "./users.module.css";

export interface UsersToolbarProps {
  /** Each segment's size over all accounts; a missing one renders without a count. */
  segments: Partial<Record<AdminUserSegment, number>>;
  segment: AdminUserSegment;
  onSegment: (segment: AdminUserSegment) => void;
  depth: AdminUsersDepth | null;
  onClearDepth: () => void;
  search: string;
  onSearch: (value: string) => void;
  /** Enter in the search box: commit now rather than after the debounce. */
  onSearchSubmit: () => void;
  sort: AdminUserSort;
  onSort: (sort: AdminUserSort) => void;
}

export function UsersToolbar({
  segments,
  segment,
  onSegment,
  depth,
  onClearDepth,
  search,
  onSearch,
  onSearchSubmit,
  sort,
  onSort,
}: UsersToolbarProps) {
  const { t } = useLang();
  const words = useUserWords();
  const depthLabel = depth
    ? depthChipLabel(depth, {
        range: t("admin.userPanel.depthRange"),
        single: t("admin.userPanel.depthSingle"),
      })
    : "";

  return (
    <>
      <div className={s.chips} role="group" aria-label={t("admin.userPanel.segmentsLabel")}>
        {USER_SEGMENTS.map((seg) => {
          const count = segments[seg];
          return (
            <button
              key={seg}
              type="button"
              className={s.chip}
              aria-pressed={segment === seg}
              data-segment={seg}
              onClick={() => onSegment(seg)}
            >
              {words.segment(seg)}
              {/* A real space, so the name reads "全部 4,321"; the flex gap does the visual spacing. */}
              {typeof count === "number" && Number.isFinite(count) ? (
                <>
                  {" "}
                  <span className={s.chipCount}>{formatCount(count)}</span>
                </>
              ) : null}
            </button>
          );
        })}
        {depth ? (
          <button
            type="button"
            className={`${s.chip} ${s.depthChip}`}
            data-depth-chip
            aria-label={fillTemplate(t("admin.userPanel.depthRemove"), { label: depthLabel })}
            onClick={onClearDepth}
          >
            {depthLabel}
            <span className={s.chipX} aria-hidden="true">
              ×
            </span>
          </button>
        ) : null}
      </div>

      <div className={s.tools}>
        <form
          role="search"
          className={s.searchForm}
          onSubmit={(event) => {
            event.preventDefault();
            onSearchSubmit();
          }}
        >
          <svg
            className={s.searchIcon}
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
          <input
            type="search"
            className={s.searchInput}
            value={search}
            onChange={(event) => onSearch(event.target.value)}
            placeholder={t("admin.userSearchPlaceholder")}
            aria-label={t("admin.userPanel.searchLabel")}
          />
        </form>
        <label className={s.sort}>
          {t("admin.userPanel.sortLabel")}
          <select
            className={s.select}
            value={sort}
            onChange={(event) => {
              const next = event.target.value;
              if (isUserSort(next)) onSort(next);
            }}
          >
            {USER_SORTS.map((key) => (
              <option key={key} value={key}>
                {words.sort(key)}
              </option>
            ))}
          </select>
        </label>
      </div>
    </>
  );
}
