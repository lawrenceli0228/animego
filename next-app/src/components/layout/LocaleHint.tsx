"use client";

import { useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import { useLang } from "@/lib/lang-client";
import { DEFAULT_LOCALE, LOCALE_LABEL, splitLocale, type Locale } from "@/lib/i18n/locale";
import { preferredLocale } from "@/lib/i18n/preferredLocale";
import "./locale-hint.css";

/**
 * A one-time offer to read the page in the language the browser asks for.
 *
 * This is the Airbnb / Booking pattern, and explicitly NOT apple.com's —
 * Apple carries no banner, no modal and no geo-detection UI anywhere, only
 * the footer control that names the current version (LanguageMenu's `named`
 * variant). Both are in the site now because they answer different questions:
 * the footer one tells a reader where they are, this one tells a reader that
 * somewhere else exists.
 *
 * Four things it deliberately does not do:
 *
 * **It does not redirect.** Google's multi-regional guidance is explicit that
 * automatic language redirects stop users *and crawlers* from reaching the
 * other versions, and Googlebot crawls from one place — a redirect would hide
 * two thirds of this site from the index. It also could not work where it
 * matters: /anime/* is served from the Cloudflare edge cache on a hit, and
 * proxy.ts does not run at all on those requests.
 *
 * **It does not read anything server-side.** No Accept-Language, no
 * CF-IPCountry. The rendered HTML is byte-identical for every visitor, which
 * is what keeps the page cacheable at the edge and keeps a crawler from being
 * served a variant.
 *
 * **It does not enter the layout.** The navbar is `position: sticky`, so a bar
 * inserted above it in flow would push the whole document down after
 * hydration — a layout shift on the first view for every new visitor, which
 * is the one view Core Web Vitals actually measures. This floats below the
 * navbar instead and moves nothing.
 *
 * **It does not take focus.** It appears without being asked for; stealing the
 * caret from someone mid-sentence to offer them a translation is worse than
 * not offering it. `role="status"` announces it politely and leaves the
 * keyboard where it was.
 */

/** Copy for each locale, in that locale. */
const HINT: Record<Locale, { question: string; accept: string; dismiss: string }> = {
  // Never a dictionary lookup, for the same reason LOCALE_LABEL is not one:
  // the entire message is "this exists in your language", and it can only
  // carry that if it is written in the language being offered. A reader on
  // the Simplified tree has to see 繁體字 to know what is on the other side.
  "zh-Hans": { question: "用简体中文浏览？", accept: "切换", dismiss: "关闭" },
  "zh-Hant": { question: "以繁體中文瀏覽？", accept: "切換", dismiss: "關閉" },
  en: { question: "View this page in English?", accept: "Switch", dismiss: "Dismiss" },
};

// Versioned so that changing the copy can re-ask if it is ever worth it.
// Bumping this re-prompts everyone, so it is not something to do casually.
const DECIDED_KEY = "agc:locale-hint:v1";

/** localStorage throws in Safari private mode; a hint is not worth a crash. */
function hasDecided(): boolean {
  try {
    return window.localStorage.getItem(DECIDED_KEY) !== null;
  } catch {
    // Unreadable storage means we cannot promise "once", and showing it on
    // every page load would be worse than never showing it.
    return true;
  }
}

function recordDecision(value: string): void {
  try {
    window.localStorage.setItem(DECIDED_KEY, value);
  } catch {
    // Nothing to do. The hint is already hidden for this page view; the cost
    // of a failed write is that it may return on the next one.
  }
}

/**
 * "Has this visitor already answered?" as an external store.
 *
 * useSyncExternalStore rather than an effect that calls setState, because
 * that is what this actually is: a value the server cannot know, read once on
 * the client, changed by an event. `getServerSnapshot` returning "decided" is
 * what makes the server render nothing without a second pass, so the markup
 * is identical for every visitor and stays cacheable at the edge.
 */
const listeners = new Set<() => void>();
let cached: "unknown" | "decided" | "open" = "unknown";

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

function getSnapshot(): "decided" | "open" {
  if (cached === "unknown") cached = hasDecided() ? "decided" : "open";
  return cached;
}

function getServerSnapshot(): "decided" {
  return "decided";
}

/** Answered — hide it here and in any other copy currently mounted. */
function settle(value: string): void {
  recordDecision(value);
  cached = "decided";
  for (const onChange of listeners) onChange();
}

export function LocaleHint() {
  const pathname = usePathname();
  const { switchTo } = useLang();
  const state = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // Returns on the server and for anyone who has answered before, so nothing
  // below this line ever runs where `navigator` does not exist.
  if (state === "decided") return null;

  const current = pathname ? splitLocale(pathname).locale : DEFAULT_LOCALE;
  const suggested = preferredLocale(navigator.languages, current);
  if (!suggested) return null;

  const copy = HINT[suggested];

  return (
    <div className="agc-locale-hint" role="status">
      <div className="agc-locale-hint-card" lang={suggested}>
        <svg
          className="agc-locale-hint-globe"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="10" />
          <path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20" />
        </svg>

        <span className="agc-locale-hint-text">{copy.question}</span>

        <button
          type="button"
          className="agc-locale-hint-accept"
          onClick={() => {
            settle(suggested);
            switchTo(suggested);
          }}
        >
          {copy.accept}
        </button>

        <button
          type="button"
          className="agc-locale-hint-close"
          aria-label={copy.dismiss}
          onClick={() => settle("dismissed")}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* The offered language named in full, for a reader who wants to be sure
          what "切換" is going to do before pressing it. */}
      <span className="agc-locale-hint-endonym" aria-hidden="true">
        {LOCALE_LABEL[suggested].endonym}
      </span>
    </div>
  );
}
