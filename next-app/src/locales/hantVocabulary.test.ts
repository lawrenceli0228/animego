import { describe, expect, test } from "bun:test";

import zhHant from "./zh-Hant";
import zhHantSpa from "./zh-Hant-spa.js";

// zh-Hant was bootstrapped by running OpenCC `s2twp` over zh.ts, then
// hand-correcting where the converter was wrong. This file pins the
// corrections.
//
// The exposure it closes is narrow and real: the conversion is reproducible,
// so the obvious way to add keys to zh-Hant later is to re-run the converter,
// or to convert one new string with the same tool. Either route puts every
// correction below straight back, and none of them announces itself — the
// output is valid Traditional Chinese with a plausible shape, so a reviewer
// skimming a diff sees Chinese where Chinese belongs.
//
// s2twp is right far more often than it is wrong. It is tuned for technical
// prose, and its vocabulary layer correctly produces 網路 / 影片 / 軟體 /
// 資料夾 / 佇列 / 欄位 / 儲存 / 複製 / 解析度 / 演算法 — all of which are the
// right Taiwanese forms and must NOT be "fixed" back. The entries below are
// the cases where the same tuning misfires on UI copy.
//
// Scanning values rather than file text is load-bearing: zh-Hant.ts documents
// these corrections in its header comment, so a source-text grep would match
// the documentation and pass while the data was wrong.

/** Every string that is actually rendered, with its key path. */
function stringLeaves(obj: unknown, prefix = ""): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [k, v] of Object.entries((obj ?? {}) as Record<string, unknown>)) {
    const path = `${prefix}${k}`;
    if (typeof v === "string") out.push([path, v]);
    else if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (typeof item === "string") out.push([`${path}[${i}]`, item]);
      });
    } else if (v && typeof v === "object") {
      out.push(...stringLeaves(v, `${path}.`));
    }
  }
  return out;
}

const DICTS: Array<[string, unknown]> = [
  ["zh-Hant.ts", zhHant],
  ["zh-Hant-spa.js", zhHantSpa],
];

// `banned` is what s2twp produces; `want` is what a Taiwanese reader expects.
// Keep the reason short enough to read in a failure message — it is the only
// explanation whoever hits this will get.
const CORRECTIONS: Array<{ banned: string; want: string; why: string }> = [
  { banned: "係列", want: "系列", why: "此系->此係 breaks the word 系列" },
  { banned: "隻影響", want: "只影響", why: "只 here means 'only', not the measure word" },
  { banned: "許可權", want: "權限", why: "許可權 is a permission bit; UI wants 權限 / 存取權限" },
  { banned: "釋出", want: "發佈", why: "釋出 ships software; posting a comment is 發佈" },
  { banned: "引數", want: "參數", why: "引數 is the formal CS term; UI wants 參數" },
  { banned: "稽核", want: "審核", why: "稽核 is an audit; moderation is 審核" },
  { banned: "對映", want: "映射", why: "對映 is the maths term; danmaku mapping stays 映射" },
  { banned: "指令碼", want: "腳本", why: "指令碼 is a shell script; a screenwriting credit is 腳本" },
  { banned: "型別", want: "類型", why: "型別 is a data type; a genre picker wants 類型" },
  // The next two were caught while localizing the settings and legal chrome,
  // and are the clearest evidence that this gate earns its keep: both are
  // OpenCC reading a compound it recognises out of one it does not.
  { banned: "頻寬幅", want: "帶寬幅", why: "s2twp read 带宽 (bandwidth) out of 带宽幅 — it is a wide banner" },
  { banned: "版權宣告", want: "版權聲明", why: "宣告 is what you do to a bankruptcy, not a copyright notice" },
  // Not banned, checked and kept: 麵包屑. Taiwanese web copy really does call
  // the navigation pattern 麵包屑導航 — same metaphor, same word, not a misfire.
  // 臺 is not wrong, it is over-formal. Everyday Taiwanese web copy writes
  // 平台 / 後台 / 這台; 臺 belongs on government forms and place names. Two of
  // the occurrences this caught were homeH1 and homeDescription, i.e. SERP
  // surfaces, which is why it earns a gate rather than a style note.
  { banned: "臺", want: "台", why: "over-formal; TW web copy writes 平台 / 後台 / 這台" },
];

describe("s2twp misfires stay corrected", () => {
  for (const { banned, want, why } of CORRECTIONS) {
    test(`no ${banned} (want ${want}) — ${why}`, () => {
      const hits: string[] = [];
      for (const [name, dict] of DICTS) {
        for (const [path, value] of stringLeaves(dict)) {
          if (value.includes(banned)) hits.push(`${name} ${path}: ${value}`);
        }
      }
      expect(hits).toEqual([]);
    });
  }
});

// ── The other direction: Simplified that never got converted at all ────────
//
// CORRECTIONS above catches s2twp converting something WRONGLY. This catches
// it not running at all — a key hand-written straight into zh-Hant in
// Simplified, or copy-pasted across from zh.ts. That is a different mistake
// with the same symptom (Simplified text on a Traditional page) and the table
// above cannot see it: every entry there is a Traditional string.
//
// Spot check, NOT a converter. The list is the handful of characters that
// actually recur in this product's UI copy, each with its Traditional form —
// enough to catch a whole string pasted over untranslated, which is the real
// threat model. A single stray character in a long sentence can still slip
// through, and that is an accepted limit rather than an oversight.
const SIMPLIFIED_ONLY: Array<[string, string]> = [
  ["标", "標"],
  ["题", "題"],
  ["语", "語"],
  ["并", "並"],
  ["间", "間"],
  ["数", "數"],
  ["单", "單"],
  ["页", "頁"],
  ["设", "設"],
  ["评", "評"],
  ["论", "論"],
  ["讨", "討"],
  ["选", "選"],
  ["关", "關"],
  ["电", "電"],
  ["视", "視"],
  ["剧", "劇"],
  ["载", "載"],
  ["间", "間"],
  ["个", "個"],
];

describe("no Simplified characters survive in zh-Hant", () => {
  for (const [simp, trad] of SIMPLIFIED_ONLY) {
    test(`no ${simp} (want ${trad})`, () => {
      const hits: string[] = [];
      for (const [name, dict] of DICTS) {
        for (const [path, value] of stringLeaves(dict)) {
          if (value.includes(simp)) hits.push(`${name} ${path}: ${value}`);
        }
      }
      expect(hits).toEqual([]);
    });
  }
});

describe("the corrected forms are actually present", () => {
  // A banned-substring check alone would also pass if the key were deleted.
  // These assert the positive side for the corrections that map to a specific
  // visible string, so a "fix" by deletion fails too.
  const EXPECTED: Array<[string, string]> = [
    ["系列", "the library split/merge copy talks about 系列"],
    ["權限", "permission-denied copy"],
    ["發佈", "the comment submit button"],
    ["參數", "backend parameter-validation errors"],
    ["映射", "the danmaku episode-mapping step"],
    ["類型", "the genre picker"],
  ];

  for (const [form, where] of EXPECTED) {
    test(`${form} appears (${where})`, () => {
      const found = DICTS.some(([, dict]) =>
        stringLeaves(dict).some(([, value]) => value.includes(form)),
      );
      expect(found).toBe(true);
    });
  }
});

describe("no Simplified characters survived the conversion", () => {
  // A missed value is the other failure mode, and it is quieter than a
  // mistranslation: Simplified text on a Traditional page reads as a broken
  // site to the audience the locale exists for. This is a spot check on the
  // highest-frequency Simplified-only forms rather than a full table — the
  // full guarantee is hantDictParity.test.ts plus the conversion being total.
  const SIMPLIFIED_ONLY = [
    "这", "个", "对", "过", "说", "时", "现", "间", "开", "关",
    "发", "为", "话", "长", "点", "击", "网", "页", "样", "验",
  ];

  for (const [name, dict] of DICTS) {
    test(name, () => {
      const hits: string[] = [];
      for (const [path, value] of stringLeaves(dict)) {
        // Values carrying Japanese kana are copied through untouched on
        // purpose (OpenCC destroys Japanese); hantDictParity.test.ts pins
        // those byte-for-byte, and they may legitimately contain kanji that
        // looks Simplified.
        if (/[぀-ヿ]/.test(value)) continue;
        for (const ch of SIMPLIFIED_ONLY) {
          if (value.includes(ch)) hits.push(`${path}: ${value}  [${ch}]`);
        }
      }
      expect(hits).toEqual([]);
    });
  }
});
