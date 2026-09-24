import { describe, expect, test } from "bun:test";
import { NBSP, titleTokens, tokenDelays } from "./titleTokens";

// The hero title fades in token by token. Each token is an inline-block, and a
// line may break between any two inline-blocks — so the tokenizer IS the
// line-breaking policy: a Latin word split into letters can wrap mid-word
// ("SHE / LL"), and a plain space inside an inline-block collapses to nothing.

describe("titleTokens", () => {
  test("every CJK character is its own token", () => {
    expect(titleTokens("葬送的芙莉莲")).toEqual(["葬", "送", "的", "芙", "莉", "莲"]);
  });

  test("a Latin run stays one token so it never breaks mid-word", () => {
    expect(titleTokens("攻壳机动队 THE GHOST")).toEqual([
      "攻", "壳", "机", "动", "队", NBSP, "THE", NBSP, "GHOST",
    ]);
  });

  test("spaces become one non-breaking token, however many there were", () => {
    expect(titleTokens("A  B")).toEqual(["A", NBSP, "B"]);
    expect(titleTokens("A\tB")).toEqual(["A", NBSP, "B"]);
  });

  test("leading and trailing whitespace is dropped", () => {
    expect(titleTokens("  鬼灭  ")).toEqual(["鬼", "灭"]);
  });

  test("Latin punctuation and digits stay with their word", () => {
    expect(titleTokens("Re:ZERO 4th")).toEqual(["Re:ZERO", NBSP, "4th"]);
    expect(titleTokens("Dr.STONE")).toEqual(["Dr.STONE"]);
  });

  test("accented Latin letters do not split a word", () => {
    expect(titleTokens("Pokémon")).toEqual(["Pokémon"]);
  });

  test("full-width punctuation and kana are single tokens", () => {
    expect(titleTokens("Re：从零")).toEqual(["Re", "：", "从", "零"]);
    expect(titleTokens("これ描いて")).toEqual(["こ", "れ", "描", "い", "て"]);
  });

  test("astral-plane characters are not split into surrogate halves", () => {
    expect(titleTokens("𠮷野家")).toEqual(["𠮷", "野", "家"]);
  });

  test("an empty title has no tokens", () => {
    expect(titleTokens("")).toEqual([]);
    expect(titleTokens("   ")).toEqual([]);
  });

  test("joining the tokens reproduces the title with normalised spaces", () => {
    const title = "BLEACH 千年血戦篇-禍進譚-";
    expect(titleTokens(title).join("").replaceAll(NBSP, " ")).toBe(title);
  });
});

describe("tokenDelays", () => {
  test("staggers 26ms per token after a head start", () => {
    expect(tokenDelays(0)).toEqual({ switchMs: 160, entryMs: 420 });
    expect(tokenDelays(10)).toEqual({ switchMs: 420, entryMs: 680 });
  });

  test("is capped so a long title does not keep the reader waiting", () => {
    expect(tokenDelays(200)).toEqual({ switchMs: 900, entryMs: 1200 });
  });
});
