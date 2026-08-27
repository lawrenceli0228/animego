// The one button surface.
//
// Extracted because ShareButton and MagnetButton held byte-identical copies
// of the same style object, each re-implementing hover and focus as React
// state:
//
//     const [hover, setHover] = useState(false);
//     const [focus, setFocus] = useState(false);
//     onMouseEnter={() => setHover(true)} ...
//     style={{ ...baseStyle, background: hover ? ... : ... }}
//
// That is a state update and a re-render per mouse enter, per mouse leave,
// per focus, per blur, for something CSS does for free — and because the
// styles were inline, they beat any stylesheet rule, so no amount of CSS
// written elsewhere could have corrected them.
//
// It also produced a real behavioural difference: `onFocus` fires when a
// button is clicked with a mouse, so the focus ring appeared on click as
// well as on keyboard focus. `:focus-visible` is the thing that
// distinguishes those, and it is not expressible in an inline style at all.
//
// This component is a plain <button> with a class. It takes every native
// button prop, so `disabled`, `aria-live`, `type` and the rest keep working
// exactly as they did on the elements it replaces.

import type { ButtonHTMLAttributes, Ref } from "react";
import styles from "./Button.module.css";

/**
 * - `primary` — the blue CTA. One per surface; more than one and neither reads
 *   as primary.
 * - `outline` — secondary actions sitting beside a primary.
 * - `confirm` — a transient success surface (ShareButton's "copied"). Not a
 *   control: it renders disabled and does not take a pointer cursor.
 */
export type ButtonVariant = "primary" | "outline" | "confirm";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /** Declared explicitly: React 19 passes `ref` as an ordinary prop to
   * function components, but it is not part of ButtonHTMLAttributes. */
  ref?: Ref<HTMLButtonElement>;
}

export default function Button({
  variant = "primary",
  className,
  type = "button",
  ref,
  ...rest
}: ButtonProps) {
  // `type` defaults to "button", not the HTML default of "submit". Every
  // call site in this repo passes type="button" explicitly today; making it
  // the default means a future one inside a <form> cannot submit it by
  // omission.
  return (
    <button
      ref={ref}
      type={type}
      className={className ? `${styles[variant]} ${className}` : styles[variant]}
      {...rest}
    />
  );
}
