import { renderHook, act } from '@testing-library/react';
import useVideoFiles from '../hooks/useVideoFiles';

// jsdom lacks URL.createObjectURL / revokeObjectURL
let urlSeq = 0;
const createObjectURL = vi.fn(() => `blob:mock-${++urlSeq}`);
const revokeObjectURL = vi.fn();

beforeAll(() => {
  global.URL.createObjectURL = createObjectURL;
  global.URL.revokeObjectURL = revokeObjectURL;
});

beforeEach(() => {
  urlSeq = 0;
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
});

function makeFile(name, relPath = null) {
  const f = new File(['x'], name, { type: 'application/octet-stream' });
  if (relPath) Object.defineProperty(f, 'webkitRelativePath', { value: relPath });
  return f;
}

describe('useVideoFiles', () => {
  it('returns empty set when no video files present', () => {
    const { result } = renderHook(() => useVideoFiles());
    let ret;
    act(() => { ret = result.current.processFiles([makeFile('readme.txt')]); });
    expect(ret).toEqual({ files: [], keyword: '' });
    expect(result.current.videoFiles).toEqual([]);
  });

  it('filters non-video files and sorts by episode number', () => {
    const { result } = renderHook(() => useVideoFiles());
    const files = [
      makeFile('Show - 03.mkv'),
      makeFile('Show - 01.mkv'),
      makeFile('notes.pdf'),
      makeFile('Show - 02.mkv'),
    ];
    act(() => { result.current.processFiles(files); });
    const eps = result.current.videoFiles.map(v => v.episode);
    expect(eps).toEqual([1, 2, 3]);
  });

  it('matches subtitle files to videos by episode number', () => {
    const { result } = renderHook(() => useVideoFiles());
    const files = [
      makeFile('Show - 01.mkv'),
      makeFile('Show - 01.ass'),
      makeFile('Show - 02.mkv'),
      makeFile('Show - 02.srt'),
    ];
    act(() => { result.current.processFiles(files); });
    expect(result.current.videoFiles[0].subtitle.type).toBe('ass');
    expect(result.current.videoFiles[1].subtitle.type).toBe('srt');
  });

  it('prefers ASS subtitles over SRT when both match the same episode', () => {
    const { result } = renderHook(() => useVideoFiles());
    const files = [
      makeFile('Show - 01.mkv'),
      makeFile('Show - 01.srt'),
      makeFile('Show - 01.ass'),
    ];
    act(() => { result.current.processFiles(files); });
    expect(result.current.videoFiles[0].subtitle.type).toBe('ass');
  });

  it('leaves subtitle null when no match exists', () => {
    const { result } = renderHook(() => useVideoFiles());
    act(() => { result.current.processFiles([makeFile('Show - 01.mkv')]); });
    expect(result.current.videoFiles[0].subtitle).toBeNull();
  });

  it('extracts keyword from folder name when available', () => {
    const { result } = renderHook(() => useVideoFiles());
    const files = [makeFile('01.mkv', 'My Anime Folder/01.mkv')];
    let ret;
    act(() => { ret = result.current.processFiles(files); });
    expect(ret.keyword).toBeTruthy();
    expect(result.current.keyword).toBe(ret.keyword);
  });

  it('getVideoUrl creates a stable blob URL per file and does not revoke for different files', () => {
    const { result } = renderHook(() => useVideoFiles());
    const a = makeFile('a.mkv');
    const b = makeFile('b.mkv');

    let url1, url2;
    act(() => { url1 = result.current.getVideoUrl(a); });
    expect(url1).toBe('blob:mock-1');
    expect(revokeObjectURL).not.toHaveBeenCalled();

    act(() => { url2 = result.current.getVideoUrl(b); });
    expect(url2).toBe('blob:mock-2');
    // New contract: different files each get their own URL; no revocation on a fresh fileId.
    expect(revokeObjectURL).not.toHaveBeenCalled();

    // Calling again with the same file returns the cached URL without creating a new one.
    let url1Again;
    act(() => { url1Again = result.current.getVideoUrl(a); });
    expect(url1Again).toBe(url1);
    expect(createObjectURL).toHaveBeenCalledTimes(2); // only 2 total, not 3
  });

  it('getSubtitleUrl tracks its own blob independent of video blob, no cross-revocation', () => {
    const { result } = renderHook(() => useVideoFiles());
    act(() => { result.current.getVideoUrl(makeFile('v.mkv')); });
    act(() => { result.current.getSubtitleUrl(makeFile('s.ass')); });
    // Second subtitle call with a different file — no revocation under new Map contract.
    act(() => { result.current.getSubtitleUrl(makeFile('s2.ass')); });
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it('clear() revokes active URLs and resets state', () => {
    const { result } = renderHook(() => useVideoFiles());
    act(() => { result.current.processFiles([makeFile('Show - 01.mkv')]); });
    act(() => { result.current.getVideoUrl(makeFile('Show - 01.mkv')); });
    act(() => { result.current.getSubtitleUrl(makeFile('Show - 01.ass')); });

    act(() => { result.current.clear(); });

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-1');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-2');
    expect(result.current.videoFiles).toEqual([]);
    expect(result.current.keyword).toBe('');
  });

  it('cleans up blobs when unmounted', () => {
    const { result, unmount } = renderHook(() => useVideoFiles());
    act(() => { result.current.getVideoUrl(makeFile('v.mkv')); });
    act(() => { result.current.getSubtitleUrl(makeFile('s.ass')); });

    revokeObjectURL.mockClear();
    unmount();

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-1');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-2');
  });
});
