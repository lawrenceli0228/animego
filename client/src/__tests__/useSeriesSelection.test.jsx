// @ts-check
import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import useSeriesSelection from '../hooks/useSeriesSelection.js';

describe('useSeriesSelection', () => {
  afterEach(() => cleanup());

  it('starts empty with selectionMode=false', () => {
    const { result } = renderHook(() => useSeriesSelection());
    expect(result.current.selectionMode).toBe(false);
    expect(result.current.count).toBe(0);
    expect(result.current.ids).toEqual([]);
  });

  it('toggle adds then removes one id', () => {
    const { result } = renderHook(() => useSeriesSelection());
    act(() => result.current.toggle('sr-1'));
    expect(result.current.selectionMode).toBe(true);
    expect(result.current.has('sr-1')).toBe(true);
    expect(result.current.count).toBe(1);

    act(() => result.current.toggle('sr-1'));
    expect(result.current.selectionMode).toBe(false);
    expect(result.current.has('sr-1')).toBe(false);
    expect(result.current.count).toBe(0);
  });

  it('toggle ignores empty/non-string ids', () => {
    const { result } = renderHook(() => useSeriesSelection());
    act(() => result.current.toggle(''));
    act(() => result.current.toggle(/** @type {any} */ (null)));
    act(() => result.current.toggle(/** @type {any} */ (123)));
    expect(result.current.count).toBe(0);
  });

  it('selectMany adds without duplicating', () => {
    const { result } = renderHook(() => useSeriesSelection());
    act(() => result.current.selectMany(['a', 'b']));
    act(() => result.current.selectMany(['b', 'c']));
    expect(result.current.ids.sort()).toEqual(['a', 'b', 'c']);
  });

  it('selectMany ignores empty input', () => {
    const { result } = renderHook(() => useSeriesSelection());
    act(() => result.current.selectMany([]));
    act(() => result.current.selectMany(/** @type {any} */ (null)));
    expect(result.current.count).toBe(0);
  });

  it('selectAll replaces the set', () => {
    const { result } = renderHook(() => useSeriesSelection());
    act(() => result.current.toggle('a'));
    act(() => result.current.selectAll(['x', 'y']));
    expect(result.current.ids.sort()).toEqual(['x', 'y']);
    expect(result.current.has('a')).toBe(false);
  });

  it('selectAll filters out non-string entries', () => {
    const { result } = renderHook(() => useSeriesSelection());
    act(() => result.current.selectAll(['ok', '', /** @type {any} */ (null), 7, 'good']));
    expect(result.current.ids.sort()).toEqual(['good', 'ok']);
  });

  it('clear empties the set and exits selectionMode', () => {
    const { result } = renderHook(() => useSeriesSelection());
    act(() => result.current.selectMany(['a', 'b']));
    expect(result.current.selectionMode).toBe(true);
    act(() => result.current.clear());
    expect(result.current.selectionMode).toBe(false);
    expect(result.current.ids).toEqual([]);
  });

  it('has returns false for unselected ids', () => {
    const { result } = renderHook(() => useSeriesSelection());
    act(() => result.current.toggle('a'));
    expect(result.current.has('b')).toBe(false);
  });
});
