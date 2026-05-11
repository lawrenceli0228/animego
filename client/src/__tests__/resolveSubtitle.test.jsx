import { resolveSubtitle } from '../utils/resolveSubtitle';

let urlSeq = 0;
const createObjectURL = vi.fn(() => `blob:mock-${++urlSeq}`);
const revokeObjectURL = vi.fn();

class MockWorker {
  constructor(url, opts) {
    this.url = url;
    this.opts = opts;
    this.terminated = false;
    this.posted = [];
    this.onmessage = null;
    this.onerror = null;
    MockWorker.instances.push(this);
  }
  postMessage(msg) { this.posted.push(msg); }
  terminate() { this.terminated = true; }
}
MockWorker.instances = [];

beforeAll(() => {
  global.URL.createObjectURL = createObjectURL;
  global.URL.revokeObjectURL = revokeObjectURL;
  vi.stubGlobal('Worker', MockWorker);
});

afterAll(() => { vi.unstubAllGlobals(); });

beforeEach(() => {
  urlSeq = 0;
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  MockWorker.instances = [];
});

const getSubtitleUrl = vi.fn((f) => `blob:sub-${f.name}`);

beforeEach(() => { getSubtitleUrl.mockClear(); });

function makeFile(name) {
  return new File(['x'], name, { type: 'video/x-matroska' });
}

describe('resolveSubtitle — sync (external)', () => {
  it('returns sync state with external subtitle url and type, no worker spawned', () => {
    const subFile = new File(['x'], 'sub.ass', { type: 'text/plain' });
    const fileItem = {
      fileName: 'Show - 01.mkv',
      file: makeFile('Show - 01.mkv'),
      subtitle: { file: subFile, type: 'ass' },
    };

    const result = resolveSubtitle(fileItem, getSubtitleUrl);

    expect(result.kind).toBe('sync');
    expect(result.state).toEqual({
      url: 'blob:sub-sub.ass',
      type: 'ass',
      content: null,
    });
    expect(MockWorker.instances).toHaveLength(0);
  });
});

describe('resolveSubtitle — none (non-mkv without external)', () => {
  it('returns kind=none for mp4 with no external subtitle', () => {
    const fileItem = { fileName: 'Show - 01.mp4', file: makeFile('Show - 01.mp4') };
    const result = resolveSubtitle(fileItem, getSubtitleUrl);
    expect(result.kind).toBe('none');
    expect(MockWorker.instances).toHaveLength(0);
  });
});

describe('resolveSubtitle — mkv extraction', () => {
  it('spawns worker and resolves to vtt blob result on success', async () => {
    const fileItem = { fileName: 'Show - 01.mkv', file: makeFile('Show - 01.mkv') };
    const result = resolveSubtitle(fileItem, getSubtitleUrl);

    expect(result.kind).toBe('mkv');
    expect(MockWorker.instances).toHaveLength(1);
    const w = MockWorker.instances[0];
    expect(w.posted[0]).toEqual({ file: fileItem.file });

    w.onmessage({ data: { result: { type: 'vtt', content: 'WEBVTT\n\n' } } });

    const value = await result.task.promise;
    expect(value).toEqual({
      // createObjectURL is called twice per mkv flow now:
      //   #1 — blob URL for the worker script (createMkvWorker)
      //   #2 — blob URL for the extracted VTT (worker.onmessage path)
      // Test asserts the VTT result, so we expect mock-2.
      url: 'blob:mock-2',
      type: 'vtt',
      content: null,
      isBlob: true,
    });
    expect(w.terminated).toBe(true);
  });

  it('preserves ass content alongside the converted vtt blob', async () => {
    const fileItem = { fileName: 'Show - 01.mkv', file: makeFile('Show - 01.mkv') };
    const result = resolveSubtitle(fileItem, getSubtitleUrl);
    const w = MockWorker.instances[0];

    w.onmessage({
      data: {
        result: {
          type: 'ass',
          content: '[Script Info]\nTitle: ...',
          vtt: 'WEBVTT\n\nconverted',
        },
      },
    });

    const value = await result.task.promise;
    expect(value.type).toBe('ass');
    expect(value.content).toBe('[Script Info]\nTitle: ...');
    expect(value.url).toBe('blob:mock-2');
    expect(value.isBlob).toBe(true);
  });

  it('resolves to null when worker errors', async () => {
    const fileItem = { fileName: 'Show - 01.mkv', file: makeFile('Show - 01.mkv') };
    const result = resolveSubtitle(fileItem, getSubtitleUrl);
    const w = MockWorker.instances[0];

    w.onerror(new Error('worker boom'));

    const value = await result.task.promise;
    expect(value).toBeNull();
    expect(w.terminated).toBe(true);
  });

  it('resolves to null when worker reports no result', async () => {
    const fileItem = { fileName: 'Show - 01.mkv', file: makeFile('Show - 01.mkv') };
    const result = resolveSubtitle(fileItem, getSubtitleUrl);
    const w = MockWorker.instances[0];

    w.onmessage({ data: { result: null } });

    const value = await result.task.promise;
    expect(value).toBeNull();
    // Worker spawn creates one blob URL for the worker script itself.
    // We only need to assert that NO ADDITIONAL VTT blob URL was created
    // (i.e. count stays at 1 = the worker URL, not 2).
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  it('cancel() terminates the worker and resolves to null', async () => {
    const fileItem = { fileName: 'Show - 01.mkv', file: makeFile('Show - 01.mkv') };
    const result = resolveSubtitle(fileItem, getSubtitleUrl);
    const w = MockWorker.instances[0];

    result.task.cancel();

    const value = await result.task.promise;
    expect(value).toBeNull();
    expect(w.terminated).toBe(true);
    // Late onmessage after cancel must be a no-op (defensive nullify)
    expect(w.onmessage).toBeNull();
  });

  it('times out and resolves to null after 120s', async () => {
    vi.useFakeTimers();
    try {
      const fileItem = { fileName: 'Show - 01.mkv', file: makeFile('Show - 01.mkv') };
      const result = resolveSubtitle(fileItem, getSubtitleUrl);
      const w = MockWorker.instances[0];

      vi.advanceTimersByTime(120000);

      const value = await result.task.promise;
      expect(value).toBeNull();
      expect(w.terminated).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
