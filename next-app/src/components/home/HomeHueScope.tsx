"use client";

// The homepage wears the colour of whichever hero is in focus.
//
// This is the one piece of client state the page-level colour needs, and the
// only reason the wrapper is a client component. Everything inside it is still
// rendered on the server and passed through as `children` — the sections keep
// fetching nothing on the client (see the islanding note in page.tsx).
//
// The ground, surface and tone strings are built in TS (lib/home/tone.ts) and
// written onto THIS element, the one whose descendants read them. Nothing
// assembles a colour from a hue declared on another element, which is the
// silent failure DESIGN.md documents under "陷阱".

import { createContext, useContext, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { pageToneVars } from "@/lib/home/tone";
import styles from "./HomeHueScope.module.css";

interface HeroFocus {
  active: number;
  setActive: (index: number) => void;
}

const HeroFocusContext = createContext<HeroFocus>({ active: 0, setActive: () => {} });

export function useHeroFocus(): HeroFocus {
  return useContext(HeroFocusContext);
}

interface HomeHueScopeProps {
  /** One hue per hero slide, in order; null renders neutral. */
  hues: Array<number | null>;
  children: ReactNode;
}

export default function HomeHueScope({ hues, children }: HomeHueScopeProps) {
  const [active, setActive] = useState(0);
  const value = useMemo(() => ({ active, setActive }), [active]);
  const vars = pageToneVars(hues[active] ?? null) as unknown as CSSProperties;

  return (
    <HeroFocusContext.Provider value={value}>
      <main className={styles.scope} style={vars}>
        {children}
      </main>
    </HeroFocusContext.Provider>
  );
}
