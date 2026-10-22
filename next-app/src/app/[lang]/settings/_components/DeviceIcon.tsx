import type { DeviceKind } from "./deviceSessions";

// The device tile's glyph, one per kind the sessions API reports. Stroke
// widths and colours come from settings.css (.set-dv-ico svg). Decorative: the
// tile names the device in words.
export default function DeviceIcon({ kind }: { kind: DeviceKind }) {
  switch (kind) {
    case "laptop":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="3.5" y="5" width="17" height="11" rx="1.8" />
          <path d="M2 19h20" />
        </svg>
      );
    case "phone":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="6.5" y="2.5" width="11" height="19" rx="2.6" />
          <path d="M10.5 18.5h3" />
        </svg>
      );
    case "tablet":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="4" y="2.5" width="16" height="19" rx="2.4" />
          <path d="M11 18.5h2" />
        </svg>
      );
    case "desktop":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="2.5" y="3.5" width="19" height="13" rx="2" />
          <path d="M8 20.5h8M12 16.5v4" />
        </svg>
      );
    case "unknown":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M9.6 9.4a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1.1.8-1.1 1.5v.4" />
          <path d="M12 16.9h.01" />
        </svg>
      );
  }
}
