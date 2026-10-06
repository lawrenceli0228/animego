"use client";

// 完结佳作 — finished, highly rated series, a random handful at a time.
//
// /api/anime/completed-gems returns a fresh random sample on every call; the
// server fetches the first batch so it is in the HTML, and "换一批" fetches the
// next one from the browser (unauthenticated, public data — same as the old
// CompletedGems). The two batches live in two stacked slots and a refresh
// writes into the hidden one and flips, so the swap is a staggered crossfade
// and the outgoing cards keep their content while they fade.
//
// A failed refresh leaves the current batch on screen, as before.

import Link from "@/components/ui/LocaleLink";
import FadeImage from "@/components/ui/FadeImage";
import { useRef, useState, type CSSProperties } from "react";
import { cardToneVars } from "@/lib/home/tone";
import { gemCard, type AnimeRow, type GemCard } from "@/lib/home/viewModels";
import { useLang } from "@/lib/lang-client";
import SectionHeader from "./SectionHeader";
import { RefreshIcon } from "./icons";
import cards from "./cards.module.css";
import section from "./section.module.css";
import styles from "./GemsPanel.module.css";

interface GemsPanelProps {
  initial: GemCard[];
  limit: number;
}

type Vars = CSSProperties & Record<`--${string}`, string>;

function isRowList(value: unknown): value is AnimeRow[] {
  return Array.isArray(value) && value.every((r) => r && typeof r === "object" && typeof (r as AnimeRow).anilistId === "number");
}

export default function GemsPanel({ initial, limit }: GemsPanelProps) {
  const { lang, t } = useLang();
  const [slots, setSlots] = useState<[GemCard[], GemCard[]]>([initial, []]);
  const [front, setFront] = useState<0 | 1>(0);
  const [turns, setTurns] = useState(0);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  if (initial.length === 0) return null;

  const refresh = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setTurns((n) => n + 1);
    try {
      // Cache-buster: the endpoint shuffles per call, but a CDN in between
      // could collapse identical URLs into one cached sample.
      const res = await fetch(`/api/anime/completed-gems?limit=${limit}&_=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) return;
      const body: unknown = await res.json();
      const rows = Array.isArray(body) ? body : (body as { data?: unknown })?.data;
      if (!isRowList(rows) || rows.length === 0) return;
      const next = rows.map((r) => gemCard(r, lang, { epUnit: t("detail.epUnit"), epUnitOne: t("detail.epUnitOne") }));
      const back: 0 | 1 = front === 0 ? 1 : 0;
      setSlots((prev) => (back === 0 ? [next, prev[1]] : [prev[0], next]));
      setFront(back);
    } catch {
      // Keep the current batch; nothing on screen becomes wrong.
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <section className={styles.section} aria-labelledby="home-gems">
      <SectionHeader
        id="home-gems"
        title={t("home.gemsLabel")}
        note={t("home.gemsSub")}
        action={
          <button
            type="button"
            className={section.link}
            onClick={() => void refresh()}
            aria-disabled={busy}
          >
            <span className={styles.refreshIcon} style={{ transform: `rotate(${turns * 180}deg)` }} aria-hidden>
              <RefreshIcon />
            </span>
            {t("home.gemsRefresh")}
          </button>
        }
      />
      <div className={styles.stage}>
        {slots.map((items, slot) => {
          const on = slot === front;
          return (
            <div key={slot} className={styles.page} data-active={on} aria-hidden={!on} inert={!on}>
              {items.map((g, k) => {
                const vars = { ...(cardToneVars(g.hue) as unknown as Vars), "--stagger": `${80 + k * 60}ms` } as Vars;
                return (
                  <Link key={`${slot}-${g.id}`} href={g.href} prefetch={false} className={`${cards.card} ${styles.card}`} style={vars}>
                    <div className={`${cards.cover} ${styles.cover}`}>
                      <span className={cards.zoom}>
                        <FadeImage src={g.cover} alt="" width={96} height={136} className={cards.img} />
                      </span>
                      <span className={cards.rule} aria-hidden />
                    </div>
                    <div className={styles.body}>
                      <span className={`${cards.title} ${cards.clamp2} ${styles.title}`}>{g.title}</span>
                      {g.native ? <span className={`${cards.clamp1} ${styles.native}`}>{g.native}</span> : null}
                      {g.meta ? <span className={`${cards.clamp1} ${styles.meta}`}>{g.meta}</span> : null}
                      {g.score ? (
                        <span className={styles.score}>
                          <span className={`${cards.mono} ${styles.scoreValue}`}>{g.score}</span>
                          <span className={styles.scoreSource}>{g.scoreSource}</span>
                        </span>
                      ) : null}
                    </div>
                  </Link>
                );
              })}
            </div>
          );
        })}
      </div>
    </section>
  );
}
