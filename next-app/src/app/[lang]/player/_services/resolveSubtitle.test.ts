import { describe, expect, test } from "bun:test";

import {
  convertSidecarSubtitle,
  resolveSubtitle,
  type PlaybackFileItemLike,
} from "./resolveSubtitle";

// The invariant under test: whatever url leaves this module is a WebVTT
// document.
//
// VideoPlayer hands it to artplayer as `{ type: "vtt" }`, and artplayer 5.4
// dispatches on `t.type || V(t.url)` — "vtt" means the bytes go to the browser
// verbatim, so its own SRT and ASS readers never run. A sidecar `.srt` used to
// arrive here as a raw blob url of the original file: no `WEBVTT` header, the
// TextTrack parser rejects the whole file, and the reader gets NO subtitles.
// Not badly styled ones. None.
//
// Sidecar matching prefers .ass first (`SUB_PRIORITY` in useVideoFiles), so
// the format most likely to be picked was the one guaranteed to render
// nothing.
//
// No Worker is constructed by any test here: `createMkvWorker` only runs for a
// .mkv with no sidecar, and nothing below is that.

const SRT = ["1", "00:00:01,000 --> 00:00:03,000", "{\\an8}顶部字幕", ""].join("\n");

const ASS = [
  "[Script Info]",
  "Title: fixture",
  "[Events]",
  "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  "Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\an8}顶部字幕",
].join("\n");

function videoWithSidecar(
  name: string,
  text: string,
  type: string,
): PlaybackFileItemLike {
  return {
    file: new File(["video"], "ep01.mp4"),
    fileName: "ep01.mp4",
    subtitle: { file: new File([text], name), type },
  };
}

/** Stands in for useVideoFiles' cached object-url factory. */
const rawUrl = () => "blob:raw-passthrough";

/**
 * Run `fn` while capturing every Blob handed to `URL.createObjectURL`.
 *
 * Deliberately NOT `fetch(blobUrl)`. bun:test shares one process across every
 * spec file, and several of them install a global fetch mock that counts its
 * calls — reading a blob back through fetch passed in isolation and failed
 * the moment the whole suite ran, with `fetch called more times than mocked`
 * pointing at a file that has nothing to do with subtitles. Taking the Blob at
 * the source touches no global anyone else owns.
 */
async function withCapturedBlobs<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; blobs: Blob[] }> {
  const blobs: Blob[] = [];
  const real = URL.createObjectURL;
  URL.createObjectURL = ((value: Blob) => {
    blobs.push(value);
    return real.call(URL, value);
  }) as typeof URL.createObjectURL;
  try {
    return { result: await fn(), blobs };
  } finally {
    URL.createObjectURL = real;
  }
}

describe("convertSidecarSubtitle", () => {
  test("srt becomes VTT and loses its override tags", () => {
    const { vtt, assContent } = convertSidecarSubtitle(SRT, "srt");
    expect(vtt.startsWith("WEBVTT")).toBe(true);
    expect(vtt).not.toContain("{\\an8}");
    expect(vtt).toContain("顶部字幕");
    expect(assContent).toBeNull();
  });

  test("★ ass yields BOTH a stripped VTT and the untouched original", () => {
    // The two are not redundant. The VTT is the fallback layer artplayer
    // renders, and it must be plain text. `assContent` is what jassub gets,
    // and it must still carry the override tags — stripping them there would
    // throw away the typesetting that is the entire reason libass exists.
    const { vtt, assContent } = convertSidecarSubtitle(ASS, "ass");
    expect(vtt.startsWith("WEBVTT")).toBe(true);
    expect(vtt).not.toContain("{\\an8}");
    expect(assContent).toBe(ASS);
    expect(assContent).toContain("{\\an8}");
  });

  test("ssa is treated as ass, not as an unknown format", () => {
    const { vtt, assContent } = convertSidecarSubtitle(ASS, "ssa");
    expect(vtt.startsWith("WEBVTT")).toBe(true);
    expect(assContent).toBe(ASS);
  });

  test("format matching is case-insensitive", () => {
    expect(convertSidecarSubtitle(SRT, "SRT").vtt.startsWith("WEBVTT")).toBe(true);
    expect(convertSidecarSubtitle(ASS, "ASS").assContent).toBe(ASS);
  });

  test("an unrecognised format passes through untouched", () => {
    // Pre-existing behaviour for an extension we do not know: hand it over and
    // let the parser decide. Better than mangling it on a guess.
    expect(convertSidecarSubtitle("whatever", "xyz")).toEqual({
      vtt: "whatever",
      assContent: null,
    });
  });
});

describe("resolveSubtitle — sidecar files", () => {
  test("★ a .srt sidecar is converted, not handed over raw", async () => {
    const { result: out, blobs } = await withCapturedBlobs(async () => {
      const r = resolveSubtitle(videoWithSidecar("ep01.srt", SRT, "srt"), rawUrl);
      if (r.kind !== "async") throw new Error("expected an async resolution");
      return r.task.promise;
    });

    expect(out).not.toBeNull();
    expect(out!.isBlob).toBe(true);
    expect(out!.url).not.toBe("blob:raw-passthrough");

    expect(blobs).toHaveLength(1);
    const text = await blobs[0].text();
    expect(text.startsWith("WEBVTT")).toBe(true);
    expect(text).not.toContain("{\\an8}");
    expect(text).toContain("顶部字幕");
    URL.revokeObjectURL(out!.url);
  });

  test("★ a .ass sidecar carries content so jassub can mount", async () => {
    // VideoPlayer's gate is `subtitleType !== "ass" || !subtitleContent`.
    // Sidecars used to report `content: null`, so a sidecar .ass could never
    // reach libass no matter how well-formed it was.
    const { result: out, blobs } = await withCapturedBlobs(async () => {
      const r = resolveSubtitle(videoWithSidecar("ep01.ass", ASS, "ass"), rawUrl);
      if (r.kind !== "async") throw new Error("expected an async resolution");
      return r.task.promise;
    });

    expect(out!.type).toBe("ass");
    expect(out!.content).toBe(ASS);

    // The blob is the stripped fallback; `content` is the original. Both, and
    // different from each other — that pairing is the whole handshake.
    const text = await blobs[0].text();
    expect(text.startsWith("WEBVTT")).toBe(true);
    expect(text).not.toContain("{\\an8}");
    URL.revokeObjectURL(out!.url);
  });

  test("a .vtt sidecar stays synchronous — there is nothing to do", async () => {
    // Not just an optimisation: it is the one case with no work, and making it
    // async would insert a frame of missing subtitles for no reason.
    const result = resolveSubtitle(videoWithSidecar("ep01.vtt", "WEBVTT\n\n", "vtt"), rawUrl);
    expect(result.kind).toBe("sync");
    if (result.kind !== "sync") throw new Error("unreachable");
    expect(result.state.url).toBe("blob:raw-passthrough");
    expect(result.state.content).toBeNull();
  });

  test("an unknown sidecar extension keeps the old passthrough", () => {
    const result = resolveSubtitle(videoWithSidecar("ep01.sub", "x", "sub"), rawUrl);
    expect(result.kind).toBe("sync");
  });

  test("cancelling before the read settles yields null and no blob", async () => {
    const result = resolveSubtitle(videoWithSidecar("ep01.srt", SRT, "srt"), rawUrl);
    if (result.kind !== "async") throw new Error("unreachable");
    result.task.cancel();
    expect(await result.task.promise).toBeNull();
  });

  test("cancelling after it settles is a no-op, not a re-resolve", async () => {
    // The caller's stale-task guard owns the blob at that point and revokes
    // it; cancel() must not overwrite the already-delivered result.
    const result = resolveSubtitle(videoWithSidecar("ep01.srt", SRT, "srt"), rawUrl);
    if (result.kind !== "async") throw new Error("unreachable");
    const out = await result.task.promise;
    result.task.cancel();
    expect(await result.task.promise).toBe(out);
    URL.revokeObjectURL(out!.url);
  });

  test("an unreadable sidecar resolves null instead of taking the episode down", async () => {
    const broken = {
      name: "ep01.srt",
      text: () => Promise.reject(new Error("disk gone")),
    } as unknown as File;
    const result = resolveSubtitle(
      {
        file: new File(["video"], "ep01.mp4"),
        fileName: "ep01.mp4",
        subtitle: { file: broken, type: "srt" },
      },
      rawUrl,
    );
    if (result.kind !== "async") throw new Error("unreachable");
    expect(await result.task.promise).toBeNull();
  });
});

describe("resolveSubtitle — no sidecar", () => {
  test("a non-mkv with no sidecar resolves to nothing", () => {
    expect(
      resolveSubtitle(
        { file: new File(["v"], "ep01.mp4"), fileName: "ep01.mp4", subtitle: null },
        rawUrl,
      ).kind,
    ).toBe("none");
  });

  test("a sidecar wins over the container, so no extraction is started", () => {
    // An .mkv WITH a sidecar takes the sidecar branch — which is what keeps
    // this suite from ever constructing a Worker.
    const result = resolveSubtitle(
      {
        file: new File(["v"], "ep01.mkv"),
        fileName: "ep01.mkv",
        subtitle: { file: new File([SRT], "ep01.srt"), type: "srt" },
      },
      rawUrl,
    );
    expect(result.kind).toBe("async");
  });
});
