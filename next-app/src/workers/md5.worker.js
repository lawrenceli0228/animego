import { md5 } from 'hash-wasm';

// MD5 of a file's first 16MB: dandanplay's file hash, and the content half of
// a library file's id. WebAssembly rather than plain JS: about four times
// faster here, so an import is held up by reading the drive, not by this.
self.onmessage = async (e) => {
  try {
    const { file } = e.data;
    const chunkSize = 16 * 1024 * 1024; // 16MB
    const slice = file.slice(0, chunkSize);

    const reader = new FileReaderSync();
    const buffer = reader.readAsArrayBuffer(slice);
    const hash = await md5(new Uint8Array(buffer));

    self.postMessage({ hash });
  } catch {
    // File became unreadable (moved/deleted on disk, or stale ref after page reload).
    // Reply with empty hash so the pool can keep this worker alive for the next request.
    self.postMessage({ hash: '' });
  }
};
