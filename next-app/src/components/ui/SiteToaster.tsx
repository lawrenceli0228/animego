"use client";

// The site's one toast surface, mounted once by the [lang] layout. Every
// caller keeps using react-hot-toast's toast() / toast.success() /
// toast.error(); this decides how they look and how many show.
//
// One at a time. A new toast takes the place of the one on screen instead of
// stacking beside it: six quick follows on /seasonal used to pile six
// identical "已加入「在看」 · 撤销" pills down from the top of the page, over
// the navigation and the filters, with no telling whose Undo was whose.
// Nothing a replaced toast offered is lost: a followed show keeps its ✓, and
// pressing it again unfollows.
//
// The look is site-toast.css. A message with actions puts them in with
// ToastParts' pieces and the agc-toast-* classes rather than inline styles.

import { useEffect, useRef } from "react";
import { Toaster, resolveValue, toast, useToasterStore, type Toast } from "react-hot-toast";
import { toastsToDismiss } from "./toastLimit";
import "./site-toast.css";

export default function SiteToaster() {
  const { toasts } = useToasterStore();
  const visibleBefore = useRef<ReadonlySet<string>>(new Set());

  useEffect(() => {
    const dismiss = toastsToDismiss(toasts, visibleBefore.current);
    visibleBefore.current = new Set(toasts.filter((t) => t.visible && !dismiss.includes(t.id)).map((t) => t.id));
    for (const id of dismiss) toast.dismiss(id);
  }, [toasts]);

  return (
    <Toaster
      position="bottom-center"
      gutter={8}
      containerStyle={{ bottom: "var(--agc-toast-bottom)" }}
      toastOptions={{ duration: 3500 }}
    >
      {(t) => <SiteToast toast={t} />}
    </Toaster>
  );
}

function SiteToast({ toast: t }: { toast: Toast }) {
  return (
    <div
      className={t.className ? `agc-toast ${t.className}` : "agc-toast"}
      style={t.style}
      data-toast
      data-type={t.type}
      data-visible={t.visible ? "true" : "false"}
    >
      <ToastIcon toast={t} />
      <div className="agc-toast-message" {...t.ariaProps}>
        {resolveValue(t.message, t)}
      </div>
    </div>
  );
}

function ToastIcon({ toast: t }: { toast: Toast }) {
  if (t.icon !== undefined) return t.icon ? <span className="agc-toast-icon">{t.icon}</span> : null;
  if (t.type === "loading") return <span className="agc-toast-spinner" aria-hidden="true" />;
  if (t.type === "success") {
    return (
      <svg className="agc-toast-icon" viewBox="0 0 24 24" fill="none" stroke="#30d158" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="m5 12.5 4.5 4.5L19 7.5" />
      </svg>
    );
  }
  if (t.type === "error") {
    return (
      <svg className="agc-toast-icon" viewBox="0 0 24 24" fill="none" stroke="#ff6961" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7.5v5.5M12 16.5v.01" />
      </svg>
    );
  }
  return null;
}
