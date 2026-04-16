import SparkMD5 from 'spark-md5';

self.onmessage = (e) => {
  const { file } = e.data;
  const chunkSize = 16 * 1024 * 1024; // 16MB
  const slice = file.slice(0, chunkSize);

  const reader = new FileReaderSync();
  const buffer = reader.readAsArrayBuffer(slice);
  const hash = SparkMD5.ArrayBuffer.hash(buffer);

  self.postMessage({ hash });
};
