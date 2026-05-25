"use client";

// Ported from client/src/components/library/SeriesActionsMenu.jsx.
// §5.6 详情页主动作菜单 — collapses [合并到…] / [拆分此系列] / [重新匹配]
// + optional [操作日志] / [删除] into a dropdown. Self-manages its open state
// and click-outside; parent only attaches callbacks.

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { mono, PLAYER_HUE } from "@/components/landing/shared/hud-tokens";
import { useLang } from "@/lib/lang-client";

const HUE = PLAYER_HUE.stream;

const s = {
  wrap: { position: "relative" } as CSSProperties,
  btn: {
    ...mono,
    padding: "6px 12px",
    background: `oklch(62% 0.17 ${HUE} / 0.20)`,
    border: `1px solid oklch(62% 0.17 ${HUE} / 0.55)`,
    borderRadius: 3,
    color: `oklch(80% 0.13 ${HUE})`,
    cursor: "pointer",
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: "0.12em",
  } as CSSProperties,
  menu: {
    position: "absolute",
    top: 32,
    right: 0,
    minWidth: 180,
    background: `oklch(12% 0.03 ${HUE} / 0.96)`,
    border: `1px solid oklch(46% 0.06 ${HUE} / 0.55)`,
    borderRadius: 3,
    boxShadow: "0 4px 16px oklch(2% 0 0 / 0.5)",
    padding: "4px 0",
    zIndex: 50,
    backdropFilter: "blur(6px)",
    WebkitBackdropFilter: "blur(6px)",
  } as CSSProperties,
  item: {
    ...mono,
    display: "block",
    width: "100%",
    padding: "8px 14px",
    background: "transparent",
    border: "none",
    color: "rgba(235,235,245,0.92)",
    textAlign: "left",
    fontSize: 11,
    cursor: "pointer",
    letterSpacing: "0.05em",
  } as CSSProperties,
  itemDanger: {
    ...mono,
    display: "block",
    width: "100%",
    padding: "8px 14px",
    background: "transparent",
    border: "none",
    borderTop: "1px solid rgba(84,84,88,0.45)",
    color: "oklch(72% 0.18 25)",
    textAlign: "left",
    fontSize: 11,
    cursor: "pointer",
    letterSpacing: "0.05em",
  } as CSSProperties,
};

interface SeriesActionsMenuProps {
  onMerge: () => void;
  onSplit: () => void;
  onRematch: () => void;
  onOpsLog?: () => void;
  onDelete?: () => void;
  label?: string;
}

export function SeriesActionsMenu({
  onMerge,
  onSplit,
  onRematch,
  onOpsLog,
  onDelete,
  label = "Actions ▾",
}: SeriesActionsMenuProps) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    function handleOutside(e: MouseEvent) {
      if (
        wrapRef.current &&
        !wrapRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [open]);

  function fire(fn: () => void) {
    setOpen(false);
    fn();
  }

  return (
    <div style={s.wrap} ref={wrapRef}>
      <button
        type="button"
        data-testid="actions-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={s.btn}
      >
        {label}
      </button>
      {open && (
        <div role="menu" data-testid="actions-menu" style={s.menu}>
          <button
            type="button"
            role="menuitem"
            data-testid="action-merge"
            style={s.item}
            onClick={() => fire(onMerge)}
          >
            {t("library.actionsMenu.mergeTo")}
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="action-split"
            style={s.item}
            onClick={() => fire(onSplit)}
          >
            {t("library.actionsMenu.splitThis")}
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="action-rematch"
            style={s.item}
            onClick={() => fire(onRematch)}
          >
            {t("library.actionsMenu.rematch")}
          </button>
          {onOpsLog && (
            <button
              type="button"
              role="menuitem"
              data-testid="action-opslog"
              style={s.item}
              onClick={() => fire(onOpsLog)}
            >
              {t("library.actionsMenu.opsLog")}
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              role="menuitem"
              data-testid="action-delete"
              style={s.itemDanger}
              onClick={() => fire(onDelete)}
            >
              {t("library.actionsMenu.delete")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
