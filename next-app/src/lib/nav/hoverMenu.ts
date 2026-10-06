// Open/closed for a menu that opens on hover AND on press — the header's 分类
// dropdown, after AniList's browse menu.
//
// The interesting part is who is allowed to close it. A menu the pointer
// opened by resting on it closes when the pointer leaves. A menu somebody
// pressed open (click, Enter, Space) stays until they press it again or
// dismiss it, so a mouse drifting off the panel cannot snatch it away from a
// keyboard user or from someone who clicked on purpose.
//
// The timers that turn "the pointer is over it" into "pointer-enter" (a short
// intent delay, so sweeping across the bar does not flash the panel) live in
// the component. This is only the transition table.

export type MenuOpenedBy = "pointer" | "press";

export interface HoverMenuState {
  readonly open: boolean;
  readonly by: MenuOpenedBy | null;
}

export type HoverMenuEvent =
  /** The pointer rested on the trigger or the panel long enough to mean it. */
  | "pointer-enter"
  /** The pointer has been off both the trigger and the panel long enough. */
  | "pointer-leave"
  /** Click, Enter or Space on the trigger. */
  | "press"
  /** Escape, a pointer-down outside, or focus leaving the menu. */
  | "dismiss";

export const CLOSED_MENU: HoverMenuState = { open: false, by: null };

/** Milliseconds the pointer must rest before the menu opens. */
export const HOVER_OPEN_DELAY_MS = 120;

/** Milliseconds of grace after the pointer leaves, to cross the gap to the panel. */
export const HOVER_CLOSE_DELAY_MS = 200;

export function hoverMenu(state: HoverMenuState, event: HoverMenuEvent): HoverMenuState {
  switch (event) {
    case "pointer-enter":
      return state.open ? state : { open: true, by: "pointer" };
    case "pointer-leave":
      return state.by === "pointer" ? CLOSED_MENU : state;
    case "press":
      // Pressing what the pointer already opened pins it rather than toggling
      // it shut under the cursor.
      return state.open && state.by === "press" ? CLOSED_MENU : { open: true, by: "press" };
    case "dismiss":
      return CLOSED_MENU;
  }
}
