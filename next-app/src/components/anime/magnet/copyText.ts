"use client";

/**
 * Put text on the clipboard. The Clipboard API first; where it is missing or
 * refused (an insecure origin, an older WebView), the old route of selecting
 * the text in a hidden field and copying the selection. Resolves to whether
 * either worked, so the caller only confirms a copy that happened.
 */
export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Refused (permissions, focus): the selection route below may still work.
    }
  }
  return copyBySelection(text);
}

function copyBySelection(text: string): boolean {
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.top = "0";
  field.style.opacity = "0";
  document.body.appendChild(field);
  try {
    field.select();
    // iOS selects nothing in a read-only field without an explicit range.
    field.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    field.remove();
    previous?.focus({ preventScroll: true });
  }
}
