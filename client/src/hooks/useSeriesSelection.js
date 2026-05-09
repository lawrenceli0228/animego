// @ts-check
import { useCallback, useMemo, useState } from 'react';

/**
 * useSeriesSelection — drives §5.6 multi-select mode for the library grid.
 *
 * Contract:
 *   - `selectionMode` is true iff at least one item is selected (single-state model:
 *     the toolbar appears the moment something is picked, disappears when set is empty).
 *   - `toggle(id)` flips membership for one id.
 *   - `selectMany(ids)` adds all ids (Shift-click range).
 *   - `selectAll(ids)` replaces the set with the given ids.
 *   - `clear()` empties the set; toolbar disappears.
 *   - `has(id)` is the read accessor cards use to render the selected ring.
 *   - `ids` is a memoized `string[]` snapshot for callers that need to iterate
 *     (e.g. bulk-merge button).
 *
 * Why a custom hook: keeps the page component free of Set-mutation noise and
 * means the same primitive can be reused once the detail page grows its own
 * bulk-action surface (e.g. multi-select within a season).
 *
 * @returns {{
 *   selectionMode: boolean,
 *   ids: string[],
 *   count: number,
 *   has: (id: string) => boolean,
 *   toggle: (id: string) => void,
 *   selectMany: (ids: string[]) => void,
 *   selectAll: (ids: string[]) => void,
 *   clear: () => void,
 * }}
 */
export default function useSeriesSelection() {
  const [set, setSet] = useState(/** @type {Set<string>} */ (new Set()));

  const toggle = useCallback((id) => {
    if (typeof id !== 'string' || !id) return;
    setSet((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectMany = useCallback((ids) => {
    if (!Array.isArray(ids) || ids.length === 0) return;
    setSet((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (typeof id === 'string' && id) next.add(id);
      }
      return next;
    });
  }, []);

  const selectAll = useCallback((ids) => {
    setSet(new Set(Array.isArray(ids) ? ids.filter((x) => typeof x === 'string' && x) : []));
  }, []);

  const clear = useCallback(() => setSet(new Set()), []);

  const has = useCallback((id) => set.has(id), [set]);

  const ids = useMemo(() => Array.from(set), [set]);

  return {
    selectionMode: set.size > 0,
    ids,
    count: set.size,
    has,
    toggle,
    selectMany,
    selectAll,
    clear,
  };
}
