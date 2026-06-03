"use client";

import { useEffect, useRef } from "react";
import type { RefObject } from "react";

// useHoloTilt — pointer / touch / gyro / keyboard 3D tilt + glare/foil engine.
//
// Ported from simeydotme/pokemon-cards-css (via the agc-pass demo's holo()
// IIFE). Sets live CSS custom properties on the card element; the holo CSS
// reads them for the rotateX/Y transform, the cursor glare origin, and the
// parallax rainbow foil. Children inherit the vars.
//
//   percent      = clamp((100/size) * pos)              → 0..100
//   rotateX      = (50 - py) / 50 * (MAX_DEG / 2) deg   (tilt back/forward)
//   rotateY      = (px - 50) / 50 * (MAX_DEG / 2) deg   (tilt left/right)
//   --px/--py    = percent                              (glare radial origin)
//   --bgx/--bgy  = adjust(percent, 0..100 → 33..67)     (parallax foil)
//   --from-center= clamp(hypot(px-50, py-50)/50, 0, 1)  (glare/foil opacity)
//
// pointerleave springs every var back to rest (~520ms via CSS --dur-slow).
// Reduced-motion: the hook no-ops and the CSS shows a fixed static sheen.

const MAX_DEG = 26;

const clamp = (v: number, lo = 0, hi = 100): number =>
  Math.min(hi, Math.max(lo, v));
const round = (v: number): number => Math.round(v * 100) / 100;
const adjust = (
  v: number,
  fl: number,
  fh: number,
  tl: number,
  th: number,
): number => round(tl + ((th - tl) * (v - fl)) / (fh - fl));

export function useHoloTilt<T extends HTMLElement = HTMLDivElement>(): RefObject<T | null> {
  const ref = useRef<T>(null);

  useEffect(() => {
    const card = ref.current;
    if (!card) return;
    if (
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return; // CSS renders a tasteful static etched sheen instead
    }

    let raf: number | null = null;
    let pending: [number, number] | null = null;

    function apply(px: number, py: number): void {
      if (!card) return;
      const rx = round(((50 - py) / 50) * (MAX_DEG / 2));
      const ry = round(((px - 50) / 50) * (MAX_DEG / 2));
      const bx = adjust(px, 0, 100, 33, 67);
      const by = adjust(py, 0, 100, 33, 67);
      const fc = clamp(Math.hypot(px - 50, py - 50) / 50, 0, 1);
      const s = card.style;
      s.setProperty("--rx", `${rx}deg`);
      s.setProperty("--ry", `${ry}deg`);
      s.setProperty("--px", `${px}%`);
      s.setProperty("--py", `${py}%`);
      s.setProperty("--bgx", `${bx}%`);
      s.setProperty("--bgy", `${by}%`);
      s.setProperty("--from-center", fc.toFixed(3));
    }

    function schedule(px: number, py: number): void {
      pending = [px, py];
      if (raf == null) {
        raf = requestAnimationFrame(() => {
          raf = null;
          if (pending) apply(pending[0], pending[1]);
        });
      }
    }

    function fromXY(clientX: number, clientY: number): void {
      if (!card) return;
      const r = card.getBoundingClientRect();
      schedule(
        clamp((100 / r.width) * (clientX - r.left)),
        clamp((100 / r.height) * (clientY - r.top)),
      );
    }

    function activate(): void {
      if (!card) return;
      card.style.setProperty("--active", "1");
      card.style.transition = "transform 60ms linear"; // snappy while tracking
    }
    function rest(): void {
      if (!card) return;
      card.style.setProperty("--active", "0");
      card.style.transition = ""; // springy return via CSS --dur-slow
      apply(50, 50);
      card.style.setProperty("--from-center", "0");
    }

    const onMove = (e: PointerEvent): void => fromXY(e.clientX, e.clientY);
    const onTouch = (e: TouchEvent): void => {
      if (!e.touches[0]) return;
      activate();
      fromXY(e.touches[0].clientX, e.touches[0].clientY);
    };
    const onFocus = (): void => {
      activate();
      apply(36, 30);
    };
    const onOrient = (e: DeviceOrientationEvent): void => {
      if (e.beta == null || e.gamma == null) return;
      activate();
      schedule(clamp(50 + e.gamma * 1.4), clamp(50 + (e.beta - 40) * 1.1));
    };

    card.addEventListener("pointerenter", activate);
    card.addEventListener("pointermove", onMove);
    card.addEventListener("pointerleave", rest);
    card.addEventListener("touchmove", onTouch, { passive: true });
    card.addEventListener("touchend", rest);
    card.addEventListener("focus", onFocus);
    card.addEventListener("blur", rest);

    // gyro (mobile tilt). iOS needs a user gesture + permission; piggyback
    // on the first touch. Non-iOS / already-granted binds immediately.
    let gyroOn = false;
    const enableGyro = (): void => {
      if (gyroOn) return;
      const DOE = window.DeviceOrientationEvent as
        | (typeof window.DeviceOrientationEvent & {
            requestPermission?: () => Promise<PermissionState>;
          })
        | undefined;
      if (!DOE) return;
      if (typeof DOE.requestPermission === "function") {
        DOE.requestPermission()
          .then((state) => {
            if (state === "granted") {
              window.addEventListener("deviceorientation", onOrient);
              gyroOn = true;
            }
          })
          .catch(() => {});
      } else {
        window.addEventListener("deviceorientation", onOrient);
        gyroOn = true;
      }
    };
    window.addEventListener("touchstart", enableGyro, {
      once: true,
      passive: true,
    });
    enableGyro();

    return () => {
      if (raf != null) cancelAnimationFrame(raf);
      card.removeEventListener("pointerenter", activate);
      card.removeEventListener("pointermove", onMove);
      card.removeEventListener("pointerleave", rest);
      card.removeEventListener("touchmove", onTouch);
      card.removeEventListener("touchend", rest);
      card.removeEventListener("focus", onFocus);
      card.removeEventListener("blur", rest);
      window.removeEventListener("touchstart", enableGyro);
      window.removeEventListener("deviceorientation", onOrient);
    };
  }, []);

  return ref;
}
