// Where Tab goes inside a modal.
//
// Kept apart from the drawer component so the rule can be tested without a
// DOM. The component collects the focusable controls in document order and
// asks this which one, if any, should receive focus instead of letting the
// browser move it out of the dialog.

/**
 * The index to focus when Tab would leave the trapped region, or null when
 * the browser's own Tab order should be left alone.
 *
 * @param count     how many focusable controls the region holds
 * @param current   index of the focused control, or -1 if focus is elsewhere
 * @param backwards true for Shift+Tab
 */
export function trapFocusIndex(count: number, current: number, backwards: boolean): number | null {
  if (count <= 0) return null;
  if (current < 0) return backwards ? count - 1 : 0;
  if (backwards && current === 0) return count - 1;
  if (!backwards && current === count - 1) return 0;
  return null;
}

/**
 * The selector for controls a keyboard can reach. Disabled controls and
 * explicit `tabindex="-1"` are excluded; hidden ones are filtered by the
 * caller, which has the layout to ask.
 */
export const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");
