// @ts-check
import { describe, it, expect, afterEach } from 'vitest';
import { isFsaSupported } from '../lib/library/handles/fsaFeatureCheck.js';

describe('isFsaSupported', () => {
  afterEach(() => {
    // Restore after each test
    delete globalThis.window?.showDirectoryPicker;
  });

  it('returns false when window is undefined (SSR)', () => {
    const original = globalThis.window;
    // @ts-ignore
    delete globalThis.window;
    expect(isFsaSupported()).toBe(false);
    globalThis.window = original;
  });

  it('returns false when showDirectoryPicker is not a function', () => {
    delete globalThis.showDirectoryPicker;
    // jsdom does not have showDirectoryPicker
    const result = isFsaSupported();
    expect(result).toBe(false);
  });

  it('returns true when showDirectoryPicker is a function', () => {
    // Polyfill the function on the window
    globalThis.showDirectoryPicker = () => Promise.resolve({});
    expect(isFsaSupported()).toBe(true);
    delete globalThis.showDirectoryPicker;
  });

  it('returns false when showDirectoryPicker is not a function (string)', () => {
    // @ts-ignore
    globalThis.showDirectoryPicker = 'not-a-function';
    expect(isFsaSupported()).toBe(false);
    delete globalThis.showDirectoryPicker;
  });
});
