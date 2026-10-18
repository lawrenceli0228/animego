// The seasonal page's glyphs, drawn as in the approved artboards. All
// decorative: every control that carries one also carries a name.

export function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4 4" />
    </svg>
  );
}

export function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 10l5 5 5-5" />
    </svg>
  );
}

export function CheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

export function PlusIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function SlidersIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="17" r="2" />
    </svg>
  );
}

export function CloseIcon() {
  return (
    <svg viewBox="0 0 10 10" aria-hidden="true">
      <path d="M2 2l6 6M8 2L2 8" />
    </svg>
  );
}

export function SortIcon() {
  return (
    <svg viewBox="0 0 10 14" aria-hidden="true">
      <path d="M5 0l4 5H1zM5 14L1 9h8z" />
    </svg>
  );
}

export function TagsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 16" aria-hidden="true">
      <path d="M1 2.6C1 1.7 1.7 1 2.6 1h5.1c.42 0 .83.17 1.13.47l5.7 5.7c.62.62.62 1.64 0 2.26l-4.6 4.6c-.62.62-1.64.62-2.26 0l-5.7-5.7C1.17 8.03 1 7.62 1 7.2V2.6zm3.4 3.2a1.4 1.4 0 1 0 0-2.8 1.4 1.4 0 0 0 0 2.8z" />
      <path d="M11.4 1h1.1c.42 0 .83.17 1.13.47l5.7 5.7c.62.62.62 1.64 0 2.26l-4.6 4.6c-.3.3-.68.45-1.07.46l4.98-4.98a.8.8 0 0 0 0-1.13L11.4 1z" />
    </svg>
  );
}

export function GridIcon() {
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true">
      {[0, 6.7, 13.4].flatMap((y) =>
        [0, 6.7, 13.4].map((x) => <rect key={`${x}-${y}`} x={x} y={y} width="4.6" height="4.6" rx="1" />),
      )}
    </svg>
  );
}

export function ChartIcon() {
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true">
      <rect x="0" y="0" width="8" height="8" rx="1.4" />
      <rect x="10" y="0" width="8" height="8" rx="1.4" />
      <rect x="0" y="10" width="8" height="8" rx="1.4" />
      <rect x="10" y="10" width="8" height="8" rx="1.4" />
    </svg>
  );
}

export function ListIcon() {
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true">
      {[0.5, 6.7, 12.9].map((y) => (
        <g key={y}>
          <rect x="0" y={y} width="4.6" height="4.6" rx="1" />
          <rect x="6.6" y={y} width="11.4" height="4.6" rx="1" />
        </g>
      ))}
    </svg>
  );
}

/**
 * The score face: one circle, two eyes and three mouths, of which the
 * stylesheet shows the one for the score's band.
 */
export function FaceIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9.2" />
      <path data-face="eye" d="M9 10h.01M15 10h.01" />
      <path data-face="high" d="M8.4 14.2c.9 1.5 2.1 2.3 3.6 2.3s2.7-.8 3.6-2.3" />
      <path data-face="mid" d="M9 15h6" />
      <path data-face="low" d="M8.4 16.4c.9-1.5 2.1-2.3 3.6-2.3s2.7.8 3.6 2.3" />
    </svg>
  );
}
