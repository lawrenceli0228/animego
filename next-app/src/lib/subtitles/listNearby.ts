// Subtitle files near a library video, read from the File System Access
// handle of the library root at play time.
//
// The library import walks subtitles but never stores them (rescanService:
// "playback resolves subs from the folder at play time"), and until this
// existed nothing did, so an episode played from the library never had a
// sidecar. Pure over a structural handle type so it is testable with plain
// objects; useFileHandles wires it to the stored root.

export interface FileLike {
  kind: "file";
  name: string;
  getFile(): Promise<File>;
}

export interface DirLike {
  kind: "directory";
  name: string;
  getDirectoryHandle(name: string): Promise<DirLike>;
  values(): AsyncIterable<FileLike | DirLike>;
}

const SUBTITLE_EXT = /\.(ass|ssa|srt|vtt|sup)$/i;

/**
 * Subtitle files in the folder `relPath` sits in, and in the folders
 * directly inside it (`Subs/`, `SC/`, `字幕/`). Paths come back relative to
 * the root, like `relPath`. Never throws: a folder that cannot be listed
 * means no sidecars, not an episode that will not play.
 */
export async function listSubtitlesNear(
  root: DirLike,
  relPath: string,
): Promise<{ file: File; relPath: string }[]> {
  try {
    const segments = relPath.split("/").filter(Boolean);
    if (segments.some((seg) => seg === ".." || seg === ".")) return [];
    segments.pop();
    let dir = root;
    for (const seg of segments) dir = await dir.getDirectoryHandle(seg);
    const prefix = segments.length ? `${segments.join("/")}/` : "";
    const out: { file: File; relPath: string }[] = [];
    for await (const entry of dir.values()) {
      if (entry.kind === "file" && SUBTITLE_EXT.test(entry.name)) {
        out.push({ file: await entry.getFile(), relPath: `${prefix}${entry.name}` });
      } else if (entry.kind === "directory") {
        for await (const inner of entry.values()) {
          if (inner.kind === "file" && SUBTITLE_EXT.test(inner.name)) {
            out.push({ file: await inner.getFile(), relPath: `${prefix}${entry.name}/${inner.name}` });
          }
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}
