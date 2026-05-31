import SparkMD5 from 'spark-md5';

self.onmessage = (e) => {
  try {
    const { file } = e.data;
    const chunkSize = 16 * 1024 * 1024; // 16MB
    const slice = file.slice(0, chunkSize);

    const reader = new FileReaderSync();
    const buffer = reader.readAsArrayBuffer(slice);
    const hash = SparkMD5.ArrayBuffer.hash(buffer);

    self.postMessage({ hash });
  } catch {
    // File became unreadable (moved/deleted on disk, or stale ref after page reload).
    // Reply with empty hash so the pool can keep this worker alive for the next request.
    self.postMessage({ hash: '' });
  }
};
