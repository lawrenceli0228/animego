const MKV_TIMEOUT_MS = 30000;

/**
 * Decide subtitle source for a playback file.
 *
 * Returns one of:
 *   { kind: 'sync', state: { url, type, content } } — external subtitle, apply immediately
 *   { kind: 'none' } — no subtitle (non-mkv with no external attachment)
 *   { kind: 'mkv', task: { promise, cancel } } — needs async worker extraction
 *
 * The mkv task's promise resolves to:
 *   null — extraction failed / timed out / canceled
 *   { url, type, content, isBlob } — extracted; isBlob=true means caller owns
 *     the blob URL and must revoke when done
 *
 * cancel() terminates the pending worker. No-op once the promise has settled.
 */
export function resolveSubtitle(fileItem, getSubtitleUrl) {
  if (fileItem.subtitle) {
    return {
      kind: 'sync',
      state: {
        url: getSubtitleUrl(fileItem.subtitle.file),
        type: fileItem.subtitle.type,
        content: null,
      },
    };
  }
  if (!/\.mkv$/i.test(fileItem.fileName)) {
    return { kind: 'none' };
  }
  return { kind: 'mkv', task: createMkvExtractionTask(fileItem.file) };
}

function createMkvExtractionTask(file) {
  let worker = null;
  let timer = null;
  let settled = false;
  let resolveFn;

  const promise = new Promise((resolve) => { resolveFn = resolve; });

  const finish = (value) => {
    if (settled) return;
    settled = true;
    if (timer) { clearTimeout(timer); timer = null; }
    if (worker) {
      // Defensive: nullify handlers so a queued message can't fire createObjectURL
      // after we've decided to bail (real worker.terminate has the same race window).
      worker.onmessage = null;
      worker.onerror = null;
      try { worker.terminate(); } catch { /* already gone */ }
      worker = null;
    }
    resolveFn(value);
  };

  worker = new Worker(
    new URL('../workers/mkvSubtitle.worker.js', import.meta.url),
    { type: 'module' },
  );
  timer = setTimeout(() => finish(null), MKV_TIMEOUT_MS);
  worker.onmessage = (e) => {
    const extracted = e?.data?.result;
    if (!extracted) return finish(null);
    const vttText = extracted.type === 'vtt'
      ? extracted.content
      : (extracted.vtt || extracted.content);
    const url = URL.createObjectURL(new Blob([vttText], { type: 'text/vtt' }));
    finish({
      url,
      type: extracted.type,
      content: extracted.type !== 'vtt' ? extracted.content : null,
      isBlob: true,
    });
  };
  worker.onerror = () => finish(null);
  worker.postMessage({ file });

  return { promise, cancel: () => finish(null) };
}
