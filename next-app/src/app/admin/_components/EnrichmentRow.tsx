"use client";

// Per-row Client Component for the enrichment management table.
//
// Two render modes:
//   - read mode (default): displays fields plus edit / flag / reset
//     action buttons.
//   - edit mode: inputs for titleChinese / bgmId / bangumiScore with
//     save + cancel buttons.
//
// All mutations route through Server Actions in _actions/enrichment-row.ts.
// useTransition tracks pending state — UI stays interactive but the
// row is visually disabled while a mutation is in flight.

import Link from "next/link";
import { useState, useTransition } from "react";
import {
  flagEnrichmentRow,
  patchEnrichmentRow,
  resetEnrichmentRow,
} from "../_actions/enrichment-row";
import type { EnrichmentFlag, EnrichmentRow as EnrichmentRowData } from "../_types";
import { useLang } from "@/lib/lang-client";

interface EnrichmentRowProps {
  row: EnrichmentRowData;
}

interface EditFormState {
  titleChinese: string;
  bgmId: string;
  bangumiScore: string;
}

// Convert a row's persisted values into editable string form. Input
// fields are always strings; we map nulls back to "" so the cleared
// state round-trips cleanly.
function initialForm(row: EnrichmentRowData): EditFormState {
  return {
    titleChinese: row.titleChinese ?? "",
    // Loose `!= null` checks instead of strict `!== null` — go-api uses
    // JSON omitempty so absent fields arrive as `undefined`, not `null`;
    // strict-equality would let `undefined` slip through into
    // `String(undefined)` and the input would render the literal text
    // "undefined".
    bgmId: row.bgmId != null ? String(row.bgmId) : "",
    bangumiScore: row.bangumiScore != null ? String(row.bangumiScore) : "",
  };
}

// Parse + validate the edit form into a minimal patch object. Returns
// null on validation error (with `error` describing the failure). Only
// fields the user actually changed are included so the backend's
// undefined-is-no-op semantics produce the smallest possible update.
function buildPatch(
  form: EditFormState,
  row: EnrichmentRowData,
  tFn: (key: string) => string,
): { patch: Parameters<typeof patchEnrichmentRow>[1]; error: string | null } {
  const patch: Parameters<typeof patchEnrichmentRow>[1] = {};

  // titleChinese: trim, empty becomes null.
  const tcTrimmed = form.titleChinese.trim();
  const tcNext: string | null = tcTrimmed === "" ? null : tcTrimmed;
  if (tcNext !== row.titleChinese) {
    patch.titleChinese = tcNext;
  }

  // bgmId: positive integer or null.
  const bgmRaw = form.bgmId.trim();
  let bgmNext: number | null;
  if (bgmRaw === "") {
    bgmNext = null;
  } else {
    if (!/^\d+$/.test(bgmRaw)) {
      return { patch, error: tFn("admin.bgmIdMustBePositiveInt") };
    }
    const n = parseInt(bgmRaw, 10);
    if (!Number.isFinite(n) || n <= 0) {
      return { patch, error: tFn("admin.bgmIdMustBePositiveInt") };
    }
    bgmNext = n;
  }
  if (bgmNext !== row.bgmId) {
    patch.bgmId = bgmNext;
  }

  // bangumiScore: 0-10, at most one decimal place, or null.
  const scoreRaw = form.bangumiScore.trim();
  let scoreNext: number | null;
  if (scoreRaw === "") {
    scoreNext = null;
  } else {
    if (!/^\d+(\.\d)?$/.test(scoreRaw)) {
      return { patch, error: tFn("admin.scoreMustBeRange") };
    }
    const n = Number(scoreRaw);
    if (!Number.isFinite(n) || n < 0 || n > 10) {
      return { patch, error: tFn("admin.scoreMustBeRange") };
    }
    scoreNext = n;
  }
  if (scoreNext !== row.bangumiScore) {
    patch.bangumiScore = scoreNext;
  }

  return { patch, error: null };
}

function FlagBadge({ flag, tFn }: { flag: EnrichmentFlag; tFn: (key: string) => string }) {
  if (flag === "needs-review") {
    return (
      <span style={{ ...styles.badge, ...styles.badgeWarn }}>{tFn("admin.needsReviewBadge")}</span>
    );
  }
  if (flag === "manually-corrected") {
    return (
      <span style={{ ...styles.badge, ...styles.badgeOk }}>{tFn("admin.correctedBadge")}</span>
    );
  }
  return <span style={styles.dim}>—</span>;
}

function VersionBadge({ version }: { version: number }) {
  let bg = "#3a1f25";
  let fg = "#ff453a";
  if (version >= 3) {
    bg = "#1c3845";
    fg = "#5ac8fa";
  } else if (version === 2) {
    bg = "#1d3a25";
    fg = "#30d158";
  } else if (version === 1) {
    bg = "#3a2b15";
    fg = "#ff9f0a";
  }
  return (
    <span style={{ ...styles.badge, background: bg, color: fg }}>
      v{version}
    </span>
  );
}

export function EnrichmentRow({ row }: EnrichmentRowProps) {
  const { t } = useLang();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<EditFormState>(() => initialForm(row));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const startEdit = () => {
    setForm(initialForm(row));
    setError(null);
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setError(null);
  };

  const handleSave = () => {
    const { patch, error: validationError } = buildPatch(form, row, t);
    if (validationError) {
      setError(validationError);
      return;
    }
    if (Object.keys(patch).length === 0) {
      // Nothing changed — just exit edit mode without a network call.
      setEditing(false);
      setError(null);
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        await patchEnrichmentRow(row.anilistId, patch);
        setEditing(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : t("admin.updateFailed"));
      }
    });
  };

  const handleFlag = (next: EnrichmentFlag) => {
    setError(null);
    startTransition(async () => {
      try {
        await flagEnrichmentRow(row.anilistId, next);
      } catch (err) {
        setError(err instanceof Error ? err.message : t("admin.flagFailed"));
      }
    });
  };

  const handleReset = () => {
    if (!window.confirm("Reset enrichment? Will re-queue V1 re-enrich.")) {
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        await resetEnrichmentRow(row.anilistId);
      } catch (err) {
        setError(err instanceof Error ? err.message : t("admin.resetFailed"));
      }
    });
  };

  const rowStyle: React.CSSProperties = pending
    ? { ...styles.row, opacity: 0.6, pointerEvents: "none" }
    : styles.row;

  return (
    <>
      <tr style={rowStyle}>
        <td style={styles.td}>
          <Link href={`/anime/${row.anilistId}`} style={styles.idLink}>
            {row.anilistId}
          </Link>
        </td>
        <td style={{ ...styles.td, ...styles.titleCell }}>
          {row.titleRomaji ?? <span style={styles.dim}>—</span>}
        </td>
        <td style={styles.td}>
          {editing ? (
            <input
              type="text"
              value={form.titleChinese}
              onChange={(e) =>
                setForm({ ...form, titleChinese: e.target.value })
              }
              placeholder={t("admin.cnTitlePlaceholder")}
              style={styles.input}
              disabled={pending}
            />
          ) : row.titleChinese != null ? (
            row.titleChinese
          ) : (
            <span style={styles.dim}>—</span>
          )}
        </td>
        <td style={styles.td}>
          {editing ? (
            <input
              type="text"
              inputMode="numeric"
              value={form.bgmId}
              onChange={(e) => setForm({ ...form, bgmId: e.target.value })}
              placeholder="BGM ID"
              style={{ ...styles.input, width: 96 }}
              disabled={pending}
            />
          ) : row.bgmId != null ? (
            row.bgmId
          ) : (
            <span style={styles.dim}>—</span>
          )}
        </td>
        <td style={styles.td}>
          <VersionBadge version={row.bangumiVersion} />
        </td>
        <td style={styles.td}>
          {editing ? (
            <input
              type="text"
              inputMode="decimal"
              value={form.bangumiScore}
              onChange={(e) =>
                setForm({ ...form, bangumiScore: e.target.value })
              }
              placeholder={t("admin.scorePlaceholder")}
              style={{ ...styles.input, width: 72 }}
              disabled={pending}
            />
          ) : typeof row.bangumiScore === "number" ? (
            // typeof check rather than `!== null` because go-api uses
            // JSON omitempty — absent score arrives as `undefined`,
            // not `null`, and `undefined.toFixed(...)` was crashing SSR.
            row.bangumiScore.toFixed(1)
          ) : (
            <span style={styles.dim}>—</span>
          )}
        </td>
        <td style={styles.td}>
          <FlagBadge flag={row.adminFlag} tFn={t} />
        </td>
        <td style={styles.td}>
          <div style={styles.actions}>
            {editing ? (
              <>
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={pending}
                  style={styles.saveBtn}
                >
                  {t("admin.save")}
                </button>
                <button
                  type="button"
                  onClick={cancelEdit}
                  disabled={pending}
                  style={styles.btn}
                >
                  {t("admin.cancel")}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={startEdit}
                  disabled={pending}
                  style={styles.btn}
                >
                  {t("admin.edit")}
                </button>
                <button
                  type="button"
                  onClick={handleReset}
                  disabled={pending}
                  style={styles.resetBtn}
                >
                  {t("admin.reset")}
                </button>
                {row.adminFlag !== "needs-review" && (
                  <button
                    type="button"
                    onClick={() => handleFlag("needs-review")}
                    disabled={pending}
                    style={styles.btn}
                  >
                    {t("admin.flagNeedsReview")}
                  </button>
                )}
                {row.adminFlag !== "manually-corrected" && (
                  <button
                    type="button"
                    onClick={() => handleFlag("manually-corrected")}
                    disabled={pending}
                    style={styles.btn}
                  >
                    {t("admin.flagCorrected")}
                  </button>
                )}
                {row.adminFlag != null && (
                  <button
                    type="button"
                    onClick={() => handleFlag(null)}
                    disabled={pending}
                    style={styles.btn}
                  >
                    {t("admin.clearFlag")}
                  </button>
                )}
              </>
            )}
          </div>
        </td>
      </tr>
      {error && (
        <tr style={styles.errorRow}>
          <td colSpan={8} style={styles.errorCell}>
            {error}
          </td>
        </tr>
      )}
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  row: {
    background: "#15151f",
    borderBottom: "1px solid #1f1f2a",
  },
  td: {
    padding: "10px 12px",
    fontSize: 13,
    color: "#cfcfdc",
    verticalAlign: "middle",
  },
  titleCell: {
    color: "#f4f4f8",
    fontWeight: 500,
  },
  idLink: {
    color: "#5ac8fa",
    textDecoration: "none",
    fontFeatureSettings: '"tnum"',
  },
  dim: {
    color: "#5c5c6e",
  },
  badge: {
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: 99,
    fontSize: 11,
    fontWeight: 600,
  },
  badgeWarn: {
    background: "#3a2b15",
    color: "#ff9f0a",
  },
  badgeOk: {
    background: "#1c3845",
    color: "#5ac8fa",
  },
  input: {
    padding: "5px 9px",
    borderRadius: 6,
    fontSize: 13,
    border: "1px solid #2a2a38",
    background: "#0b0b10",
    color: "#f4f4f8",
    outline: "none",
    width: 180,
  },
  actions: {
    display: "flex",
    flexWrap: "wrap",
    gap: 6,
  },
  btn: {
    padding: "4px 10px",
    borderRadius: 6,
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    border: "1px solid #2a2a38",
    background: "transparent",
    color: "#a8a8b8",
  },
  saveBtn: {
    padding: "4px 10px",
    borderRadius: 6,
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    border: "1px solid rgba(10,132,255,0.4)",
    background: "rgba(10,132,255,0.12)",
    color: "#5ac8fa",
  },
  resetBtn: {
    padding: "4px 10px",
    borderRadius: 6,
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    border: "1px solid rgba(255,69,58,0.4)",
    background: "rgba(255,69,58,0.08)",
    color: "#ff453a",
  },
  errorRow: {
    background: "rgba(255,69,58,0.06)",
  },
  errorCell: {
    padding: "8px 12px",
    fontSize: 12,
    color: "#ff453a",
    borderBottom: "1px solid #1f1f2a",
  },
};
