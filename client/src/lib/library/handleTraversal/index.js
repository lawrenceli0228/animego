// @ts-check

/**
 * Video and subtitle extensions to collect.
 * Mirrors useVideoFiles.js extension handling.
 */
const VIDEO_EXTS = new Set([
  'mkv', 'mp4', 'avi', 'webm', 'mov', 'm4v', 'flv', 'wmv', 'ts', 'rmvb',
]);

const SUBTITLE_EXTS = new Set([
  'srt', 'ass', 'ssa', 'vtt', 'sup',
]);

const MAX_DEPTH = 12;

/**
 * Return the lowercase extension of a filename (without the dot), or '' if none.
 *
 * @param {string} name
 * @returns {string}
 */
function ext(name) {
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx + 1).toLowerCase() : '';
}

/**
 * Recursively collect video and subtitle files from a FileSystemDirectoryHandle.
 *
 * @param {FileSystemDirectoryHandle} handle - root directory handle
 * @param {{ maxDepth?: number }} [opts]
 * @returns {Promise<{ file: File, relPath: string }[]>}
 */
export async function collectFromHandle(handle, opts = {}) {
  const maxDepth = opts.maxDepth ?? MAX_DEPTH;
  /** @type {{ file: File, relPath: string }[]} */
  const results = [];

  /**
   * @param {any} dirHandle
   * @param {string} prefix
   * @param {number} depth
   */
  async function walk(dirHandle, prefix, depth) {
    if (depth > maxDepth) return;

    for await (const entry of dirHandle.values()) {
      const entryPath = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.kind === 'file') {
        const e = ext(entry.name);
        if (VIDEO_EXTS.has(e) || SUBTITLE_EXTS.has(e)) {
          const file = await entry.getFile();
          results.push({ file, relPath: entryPath });
        }
      } else if (entry.kind === 'directory') {
        await walk(entry, entryPath, depth + 1);
      }
    }
  }

  await walk(handle, '', 0);
  return results;
}
