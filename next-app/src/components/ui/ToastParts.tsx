// Pieces for a toast message that carries more than a sentence (SiteToaster
// renders them; site-toast.css styles them). A toast's actions are a plain
// <button className="agc-toast-action"> (the white pill) and a
// <Link className="agc-toast-link"> with a ToastChevron (the quiet one).

import type { ReactNode } from "react";

/**
 * "[name] what happened", for a toast about one show: the name quiet and the
 * first to give way on a narrow screen, so an Undo can be told apart from the
 * one it replaced. No name: just what happened.
 */
export function ToastWhat({ name, children }: { name?: string | null; children: ReactNode }) {
  return (
    <span className="agc-toast-what">
      {name ? <span className="agc-toast-name">{name}</span> : null}
      <span className="agc-toast-verb">{children}</span>
    </span>
  );
}

export function ToastChevron() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}
