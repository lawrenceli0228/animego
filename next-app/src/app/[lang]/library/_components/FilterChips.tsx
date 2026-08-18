"use client";

import { mono } from "@/components/landing/shared/hud-tokens";
import { useLang } from "@/lib/lang-client";

export type LibraryFilter =
  | "recent"
  | "new"
  | "inProgress"
  | "done"
  | "almostDone"
  | "stalled"
  | "fresh"
  | null;

export type FilterCounts = Record<Exclude<LibraryFilter, null>, number>;

const PRIMARY_IDS: Exclude<LibraryFilter, null>[] = [
  "recent",
  "new",
  "inProgress",
  "done",
];
const SEMANTIC_IDS: Exclude<LibraryFilter, null>[] = [
  "almostDone",
  "stalled",
  "fresh",
];

const s = {
  // Outer container — single segmented track. Sits inside a faint trench so
  // the row reads as "one control" instead of N independent buttons.
  track: {
    display: "inline-flex",
    flexWrap: "wrap",
    alignItems: "stretch",
    gap: 0,
    padding: 4,
    background: "oklch(14% 0.04 210 / 0.40)",
    border: "1px solid rgba(84,84,88,0.45)",
    borderRadius: 12,
  } as React.CSSProperties,
  segment: (active: boolean, dim: boolean): React.CSSProperties => ({
    fontFamily: "'DM Sans', sans-serif",
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 14px",
    background: active ? "oklch(20% 0.04 210 / 0.60)" : "transparent",
    border: "none",
    borderRadius: 8,
    color: active
      ? "#fff"
      : dim
        ? "rgba(235,235,245,0.30)"
        : "rgba(235,235,245,0.65)",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: active ? 600 : 500,
    transition: "background 150ms ease-out, color 150ms ease-out",
  }),
  // Active segment underline — accent bottom rail. Replaces the filled-blue
  // chip so the row reads as a control panel switcher.
  rail: {
    position: "absolute",
    left: 8,
    right: 8,
    bottom: 1,
    height: 2,
    background: "#0a84ff",
    borderRadius: 9999,
    boxShadow: "0 0 8px rgba(10,132,255,0.55)",
  } as React.CSSProperties,
  count: {
    ...mono,
    fontSize: 10,
    color: "rgba(235,235,245,0.45)",
    fontVariantNumeric: "tabular-nums",
  } as React.CSSProperties,
  countActive: {
    color: "#fff",
  } as React.CSSProperties,
  countZero: {
    color: "rgba(235,235,245,0.18)",
  } as React.CSSProperties,
  divider: {
    width: 1,
    margin: "4px 6px",
    background: "rgba(84,84,88,0.45)",
    flexShrink: 0,
  } as React.CSSProperties,
  clear: {
    ...mono,
    marginLeft: 8,
    padding: "6px 10px",
    background: "transparent",
    border: "none",
    color: "rgba(235,235,245,0.45)",
    cursor: "pointer",
    fontSize: 11,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
  } as React.CSSProperties,
  outer: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 8,
  } as React.CSSProperties,
};

interface FilterChipsProps {
  active: LibraryFilter;
  counts?: FilterCounts;
  onChange: (next: LibraryFilter) => void;
}

/**
 * FilterChips — §5.4 telemetry switcher (segmented control style).
 *
 * Two groups separated by a thin rail:
 *   primary:   最近播放 / 新加入 / 未看完 / 已完结  (always visible)
 *   semantic:  快看完了 / 卡住了 / 刚开始             (visible only when at
 *              least one chip's count > 0 — small libraries skip the noise)
 *
 * Each segment renders its label + a mono count tag. The active segment uses
 * a bottom 2px iOS-Blue underline rather than a filled chip — reads as a
 * control-panel switcher rather than an iOS toggle pill.
 */
function FilterChips({
  active,
  counts,
  onChange,
}: FilterChipsProps) {
  const { t } = useLang();
  const semanticHasAny =
    counts != null &&
    (counts.almostDone > 0 || counts.stalled > 0 || counts.fresh > 0);

  return (
    <div style={s.outer}>
      <div
        style={s.track}
        data-testid="library-filters"
        role="toolbar"
        aria-label={t("library.filter.aria")}
      >
        {PRIMARY_IDS.map((id) => renderSegment(id, active, counts, onChange, t))}
        {semanticHasAny && (
          <>
            <span style={s.divider} aria-hidden />
            {SEMANTIC_IDS.map((id) =>
              renderSegment(id, active, counts, onChange, t),
            )}
          </>
        )}
      </div>
      {active && (
        <button
          type="button"
          data-testid="filter-chip-clear"
          style={s.clear}
          onClick={() => onChange(null)}
        >
          {t("library.filter.clear")}
        </button>
      )}
    </div>
  );
}

const HINT_KEY: Partial<Record<Exclude<LibraryFilter, null>, string>> = {
  almostDone: "library.filter.almostDoneHint",
  stalled: "library.filter.stalledHint",
  fresh: "library.filter.freshHint",
};

function renderSegment(
  id: Exclude<LibraryFilter, null>,
  active: LibraryFilter,
  counts: FilterCounts | undefined,
  onChange: (next: LibraryFilter) => void,
  t: (key: string, opts?: { defaultValue?: string }) => string,
) {
  const isActive = active === id;
  const count = counts?.[id];
  const dim = count != null && count === 0 && !isActive;
  const label = t(`library.filter.${id}`);
  const hintKey = HINT_KEY[id];
  const hint = hintKey ? t(hintKey) : undefined;
  return (
    <button
      key={id}
      type="button"
      data-testid={`filter-chip-${id}`}
      data-active={isActive ? "true" : "false"}
      aria-pressed={isActive}
      title={hint}
      style={s.segment(isActive, dim)}
      onClick={() => onChange(isActive ? null : id)}
    >
      <span>{label}</span>
      {count != null && (
        <span
          style={{
            ...s.count,
            ...(isActive ? s.countActive : null),
            ...(count === 0 ? s.countZero : null),
          }}
          data-testid={`filter-chip-${id}-count`}
        >
          {count}
        </span>
      )}
      {isActive && <span aria-hidden style={s.rail} />}
    </button>
  );
}

export { FilterChips };
export default FilterChips;
