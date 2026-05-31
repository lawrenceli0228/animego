/**
 * Flatten a drop event's `dataTransfer` into a `File[]`, recursing into any
 * dropped folders via `webkitGetAsEntry()` (Chrome/Safari/Edge). Falls back to
 * `dataTransfer.files` (top-level only) when the items API isn't available.
 *
 * Why: `dataTransfer.files` does NOT recurse into folders — only the
 * `<input webkitdirectory>` path does. Without this helper, dropping a
 * folder of episodes silently yields zero video files.
 *
 * Ported from legacy client/src/utils/dropFiles.js (P6.6).
 */

// FileSystemEntry shape — DOM lib stops short of the legacy webkit entries
// API; declare just enough to type the few branches we exercise.
interface WebkitEntry {
  isFile: boolean;
  isDirectory: boolean;
  fullPath?: string;
  file?: (
    onSuccess: (file: File) => void,
    onError?: (e: unknown) => void,
  ) => void;
  createReader?: () => WebkitEntryReader;
}

interface WebkitEntryReader {
  readEntries: (
    onSuccess: (entries: WebkitEntry[]) => void,
    onError?: (e: unknown) => void,
  ) => void;
}

// Folders deeper than MAX_DEPTH are skipped. The Entries API does not expose
// symlink info, so a self-referential symlinked folder would otherwise recurse
// until the tab OOMs. 12 covers any realistic anime release tree.
const MAX_DEPTH = 12;

export async function flattenDropFiles(
  dataTransfer: DataTransfer | null | undefined,
): Promise<File[]> {
  if (!dataTransfer) return [];

  const items = dataTransfer.items;
  if (
    !items ||
    !items.length ||
    typeof (items[0] as DataTransferItem & {
      webkitGetAsEntry?: () => WebkitEntry | null;
    }).webkitGetAsEntry !== "function"
  ) {
    return Array.from(dataTransfer.files || []);
  }

  // Snapshot entries synchronously — DataTransferItemList becomes stale once
  // the drop handler returns control (notably on Safari).
  const entries: WebkitEntry[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as DataTransferItem & {
      webkitGetAsEntry?: () => WebkitEntry | null;
    };
    const entry = item.webkitGetAsEntry?.();
    if (entry) entries.push(entry);
  }

  const out: File[] = [];
  for (const entry of entries) {
    await collectEntry(entry, out, 0);
  }
  return out;
}

async function collectEntry(
  entry: WebkitEntry | null,
  out: File[],
  depth: number,
): Promise<void> {
  if (!entry || depth > MAX_DEPTH) return;

  if (entry.isFile) {
    const file = await new Promise<File | null>((resolve) => {
      try {
        if (!entry.file) return resolve(null);
        entry.file(
          (f) => resolve(f),
          () => resolve(null),
        );
      } catch {
        resolve(null);
      }
    });
    if (!file) return;
    // Stamp webkitRelativePath so episodeParser folder-aware logic still works
    // for files that came from a dropped folder.
    if (entry.fullPath && !file.webkitRelativePath) {
      try {
        Object.defineProperty(file, "webkitRelativePath", {
          value: entry.fullPath.replace(/^\//, ""),
          configurable: true,
        });
      } catch {
        // Property may be readonly in some browsers — non-fatal.
      }
    }
    out.push(file);
    return;
  }

  if (entry.isDirectory && entry.createReader) {
    const reader = entry.createReader();
    const children = await readAllEntries(reader);
    for (const child of children) {
      await collectEntry(child, out, depth + 1);
    }
  }
}

// readEntries is paginated — must be called repeatedly until it returns [].
function readAllEntries(reader: WebkitEntryReader): Promise<WebkitEntry[]> {
  return new Promise((resolve) => {
    const acc: WebkitEntry[] = [];
    const next = () => {
      reader.readEntries(
        (batch) => {
          if (!batch.length) {
            resolve(acc);
            return;
          }
          acc.push(...batch);
          next();
        },
        () => resolve(acc),
      );
    };
    next();
  });
}
