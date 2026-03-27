# CLAUDE.md — AnimeGo

## Design System
Always read `DESIGN.md` before making any visual or UI decisions.
All font choices, colors, spacing, border-radius, and aesthetic direction are defined there.
Do not deviate without explicit user approval.
In QA mode, flag any code that doesn't match `DESIGN.md`.

Key rules at a glance:
- **Accent color:** `#0a84ff` (iOS Blue) — the ONLY primary action color. No purple, no gradients on interactive elements.
- **Backgrounds:** `#000000` → `#1c1c1e` → `#2c2c2e` (three-layer Apple True Black)
- **Teal `#5ac8fa`:** secondary accent, information/read-only scenes only — not for clickable actions
- **Fonts:** Sora (display/headings) + DM Sans (body/UI) + JetBrains Mono (code/data)
- **No decorative animations** — motion must serve state comprehension
