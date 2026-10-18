// Which toasts to take off screen so that only one is ever showing.
//
// Pure, and importing nothing: react-hot-toast pulls goober, which touches
// `document` while the module is evaluated, so anything that imports it cannot
// run under bun:test. SiteToaster feeds this the store's toasts.

export interface ToastLike {
  id: string;
  visible: boolean;
}

/**
 * The visible toasts to dismiss, keeping the one that turned up last.
 *
 * "Last" is the one that became visible since the previous look, not the
 * newest created: the store lists toasts newest first, but a toast updated by
 * id (a loading toast reporting progress, `toast.success(…, { id })`) keeps its
 * place in the list while it reappears. Several new at once: the store's first,
 * the newest. Nothing new (a re-render, or the one we kept): the store's first.
 */
export function toastsToDismiss(toasts: readonly ToastLike[], visibleBefore: ReadonlySet<string>): string[] {
  const visible = toasts.filter((t) => t.visible);
  if (visible.length <= 1) return [];
  const keep = (visible.find((t) => !visibleBefore.has(t.id)) ?? visible[0]).id;
  return visible.filter((t) => t.id !== keep).map((t) => t.id);
}
