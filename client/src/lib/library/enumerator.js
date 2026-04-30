// @ts-check
// v3.1 §4 Stage 0 — FSA 文件枚举 + 噪声过滤
// Stage 1/2/3 都消费此 AsyncIterable。
// 纯函数(无 React / 无 IDB / 无 DOM),收一个 root handle,吐流式 entries。

const VIDEO_EXTS = new Set([
  'mkv', 'mp4', 'avi', 'webm', 'mov', 'm4v', 'flv', 'wmv', 'ts', 'rmvb',
]);

const SUBTITLE_EXTS = new Set([
  'srt', 'ass', 'ssa', 'vtt', 'sup',
]);

const NOISE_NAMES = new Set([
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
]);

const MIN_VIDEO_SIZE = 1 * 1024 * 1024;
const MAX_DEPTH = 3;

/**
 * @param {string} name
 * @returns {string}
 */
function ext(name) {
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx + 1).toLowerCase() : '';
}

/**
 * @param {string} name
 */
function hasVideoExt(name) {
  return VIDEO_EXTS.has(ext(name));
}

/**
 * @param {string} name
 */
function hasSubtitleExt(name) {
  return SUBTITLE_EXTS.has(ext(name));
}

/**
 * v3.1 noise predicate: macOS AppleDouble (`._*`) and known sidecars.
 * @param {string} name
 */
function isNoise(name) {
  if (name.startsWith('._')) return true;
  if (NOISE_NAMES.has(name)) return true;
  return false;
}

/**
 * @param {string} relPath
 */
function nfc(relPath) {
  return relPath.normalize('NFC');
}

/**
 * v3.1 macOS ExFAT `.mp4`-package: directory whose name has a video extension.
 * Drill into it once and pick the largest file matching the same extension.
 *
 * @param {any} dirHandle
 * @returns {Promise<{ file: File, name: string } | null>}
 */
async function pickLargestSameExt(dirHandle) {
  const targetExt = ext(dirHandle.name);
  if (!targetExt) return null;

  /** @type {{ file: File, name: string } | null} */
  let pick = null;

  for await (const child of dirHandle.values()) {
    if (child.kind !== 'file') continue;
    if (isNoise(child.name)) continue;
    if (ext(child.name) !== targetExt) continue;

    const file = await child.getFile();
    if (file.size < MIN_VIDEO_SIZE) continue;

    if (!pick || file.size > pick.file.size) {
      pick = { file, name: child.name };
    }
  }

  return pick;
}

/**
 * Enumerate video + subtitle files under a root FileSystemDirectoryHandle,
 * applying the v3.1 Stage 0 ruleset:
 *
 *   - skip:    `._*` AppleDouble, `.DS_Store`, `Thumbs.db`, `desktop.ini`
 *   - skip:    files where size < 1MB (video ext only)
 *   - drill:   directory whose name has a video ext at depth 0/1 → pick largest same-ext child
 *   - recurse: ordinary directory (depth < 3)
 *   - cut:     depth >= 3 directories
 *   - yield:   all relPaths NFC-normalized at the boundary
 *
 * @param {FileSystemDirectoryHandle} root
 * @returns {AsyncGenerator<{ file: File, relPath: string, depth: number, kind: 'video'|'subtitle' }, void, unknown>}
 */
export async function* enumerate(root) {
  yield* walk(root, '', 0);
}

/**
 * @param {any} dirHandle
 * @param {string} prefix
 * @param {number} depth
 * @returns {AsyncGenerator<{ file: File, relPath: string, depth: number, kind: 'video'|'subtitle' }, void, unknown>}
 */
async function* walk(dirHandle, prefix, depth) {
  if (depth > MAX_DEPTH) return;

  for await (const entry of dirHandle.values()) {
    if (isNoise(entry.name)) continue;

    const entryPath = nfc(prefix ? `${prefix}/${entry.name}` : entry.name);

    if (entry.kind === 'file') {
      const e = ext(entry.name);
      const isVid = VIDEO_EXTS.has(e);
      const isSub = SUBTITLE_EXTS.has(e);
      if (!isVid && !isSub) continue;

      const file = await entry.getFile();
      if (isVid && file.size < MIN_VIDEO_SIZE) continue;

      yield { file, relPath: entryPath, depth, kind: isVid ? 'video' : 'subtitle' };
      continue;
    }

    if (entry.kind === 'directory') {
      if (hasVideoExt(entry.name) && depth <= 1) {
        const picked = await pickLargestSameExt(entry);
        if (picked) {
          yield { file: picked.file, relPath: entryPath, depth, kind: 'video' };
        }
        continue;
      }

      if (depth < MAX_DEPTH) {
        yield* walk(entry, entryPath, depth + 1);
      }
    }
  }
}

/**
 * Materialize the full enumeration into an array.
 * Wrapper for callers that need a list (importPipeline / LibraryPage).
 *
 * @param {FileSystemDirectoryHandle} root
 * @returns {Promise<{ file: File, relPath: string, depth: number, kind: 'video'|'subtitle' }[]>}
 */
export async function enumerateAll(root) {
  const out = [];
  for await (const item of enumerate(root)) {
    out.push(item);
  }
  return out;
}

/** Exposed for tests. */
export const _internal = {
  isNoise,
  hasVideoExt,
  hasSubtitleExt,
  ext,
  nfc,
  MIN_VIDEO_SIZE,
  MAX_DEPTH,
};
