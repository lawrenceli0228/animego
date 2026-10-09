// The canvas's line icons (Social and WriteReview boards), drawn at the
// .icon size. Decorative: every button that carries one also carries text.

import s from "./community.module.css";

export function ReplyIcon() {
  return (
    <svg className={s.icon} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 5h16v11H8l-4 4z" />
    </svg>
  );
}

export function HeartIcon({ filled = false }: { filled?: boolean }) {
  return (
    <svg className={s.icon} viewBox="0 0 24 24" aria-hidden="true" style={filled ? { fill: "currentColor" } : undefined}>
      <path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" />
    </svg>
  );
}

export function PenIcon() {
  return (
    <svg className={s.icon} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 20h4L19 9l-4-4L4 16z" />
    </svg>
  );
}

export function PlusIcon() {
  return (
    <svg className={s.icon} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function ThumbIcon({ filled = false }: { filled?: boolean }) {
  return (
    <svg className={s.icon} viewBox="0 0 24 24" aria-hidden="true" style={filled ? { fill: "currentColor" } : undefined}>
      <path d="M7 10v10H4V10zM7 10l4-7c1.7 0 2.6 1.2 2.2 2.8L12.6 9H19a2 2 0 0 1 2 2.3l-1.2 7A2 2 0 0 1 17.8 20H7" />
    </svg>
  );
}

export function QuoteIcon() {
  return (
    <svg className={s.icon} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 7h4v6H5V9a2 2 0 0 1 2-2zM15 7h4v6h-6V9a2 2 0 0 1 2-2z" />
    </svg>
  );
}
