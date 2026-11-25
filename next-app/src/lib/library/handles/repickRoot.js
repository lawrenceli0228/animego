// @ts-nocheck
// Replace a library's stored folder handle with one the user picks again.
//
// A handle saved by an older Chrome can stop answering queryPermission (see
// probeRoot.js 'stale'). Requesting permission on it hangs the same way, and
// "add folder" mints a new libraryId, which would file every episode the
// library already holds as a second copy. Re-picking swaps the handle inside
// the existing record instead, so series, episodes and progress keep pointing
// at the same libraryId. Picking a different folder changes nothing.

/**
 * How many of the library's files are looked up in the picked folder. The
 * caller samples the most recently imported rows: a download folder loses
 * its oldest episodes as they are watched and deleted, and file rows outlive
 * the files they point at.
 */
export const VERIFY_SAMPLE_SIZE = 12;

/**
 * Whether `relPath` resolves under `root`, as a file or — for a macOS ExFAT
 * `.mp4` bundle — as a directory.
 *
 * @param {FileSystemDirectoryHandle} root
 * @param {string} relPath
 * @returns {Promise<boolean>}
 */
async function resolves(root, relPath) {
  const segments = relPath.split('/').filter(Boolean);
  if (segments.length === 0 || segments.some((s) => s === '..' || s === '.')) return false;
  const last = segments.pop();
  try {
    let dir = root;
    for (const seg of segments) dir = await dir.getDirectoryHandle(seg);
    try {
      await dir.getFileHandle(last);
    } catch (err) {
      if (err?.name !== 'TypeMismatchError') throw err;
      await dir.getDirectoryHandle(last);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Check that a picked folder is the library's folder: same name, and at
 * least one of the sampled files is where the library recorded it. A library
 * with no files yet is checked by name alone.
 *
 * One hit is enough because rows outlive deleted files; requiring more
 * would refuse the right folder of a library whose files were cleaned up,
 * leaving no way back at all. A same-named folder that also holds one of the
 * library's files at the same relative path is, in practice, that folder.
 *
 * @param {FileSystemDirectoryHandle} handle
 * @param {{ expectedName: string, relPaths: string[] }} expected
 * @returns {Promise<{ ok: boolean, checked: number, found: number }>}
 */
export async function verifyPickedRoot(handle, { expectedName, relPaths }) {
  const sample = relPaths.slice(0, VERIFY_SAMPLE_SIZE);
  let found = 0;
  for (const relPath of sample) {
    if (await resolves(handle, relPath)) found += 1;
  }
  const nameMatches = handle?.name === expectedName;
  const enoughFound = sample.length === 0 || found >= 1;
  return { ok: nameMatches && enoughFound, checked: sample.length, found };
}

/**
 * @typedef {{
 *   status: 'rebound'|'mismatch'|'cancelled'|'missing',
 *   record?: any,
 *   checked?: number,
 *   found?: number,
 * }} RepickResult
 */

/**
 * Open the folder picker and, if the user picks the library's folder, store
 * the new handle under the same libraryId.
 *
 * `pick` runs first, before any await: showDirectoryPicker needs the click's
 * transient activation, and an IndexedDB read in front of it could outlast it.
 *
 * @param {{
 *   libraryId: string,
 *   pick: () => Promise<FileSystemDirectoryHandle>,
 *   findByLibrary: (libraryId: string) => Promise<{ name: string } | null>,
 *   sampleRelPaths: (libraryId: string) => Promise<string[]>,
 *   saveRoot: (handle: FileSystemDirectoryHandle, libraryId: string) => Promise<any>,
 * }} deps
 * @returns {Promise<RepickResult>}
 */
export async function repickRoot({ libraryId, pick, findByLibrary, sampleRelPaths, saveRoot }) {
  let handle;
  try {
    handle = await pick();
  } catch (err) {
    if (err?.name === 'AbortError') return { status: 'cancelled' };
    throw err;
  }

  const existing = await findByLibrary(libraryId);
  if (!existing) return { status: 'missing' };

  const relPaths = await sampleRelPaths(libraryId);
  const { ok, checked, found } = await verifyPickedRoot(handle, {
    expectedName: existing.name,
    relPaths,
  });
  if (!ok) return { status: 'mismatch', checked, found };

  const record = await saveRoot(handle, libraryId);
  return { status: 'rebound', record, checked, found };
}
