"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import "./photo-crop.css";

// PhotoCropModal — the single adjustment step before a photo becomes the card
// face. Pan + zoom + wheel to frame the image inside a 5:7 window (everything
// dimmed outside is cut); Confirm bakes that region to a canvas and returns a
// JPEG data URL. Geometry is held in a ref and written straight to the DOM so
// React never re-renders mid-drag. Ported from agc-pass photoCrop().

const OUT_W = 520;

interface Geom {
  nw: number;
  nh: number;
  SW: number;
  SH: number;
  CW: number;
  CH: number;
  WL: number;
  WT: number;
  dispW: number;
  dispH: number;
  ix: number;
  iy: number;
  coverScale: number;
}

interface PhotoCropModalProps {
  open: boolean;
  /** Downscaled original image data URL. */
  src: string | null;
  /** Card art aspect ratio, H : W. Defaults to 7 / 5. */
  aspect?: number;
  onConfirm: (croppedDataUrl: string) => void;
  onCancel: () => void;
}

export default function PhotoCropModal({
  open,
  src,
  aspect = 7 / 5,
  onConfirm,
  onCancel,
}: PhotoCropModalProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const winRef = useRef<HTMLDivElement>(null);
  const g = useRef<Geom>({
    nw: 1,
    nh: 1,
    SW: 0,
    SH: 0,
    CW: 0,
    CH: 0,
    WL: 0,
    WT: 0,
    dispW: 0,
    dispH: 0,
    ix: 0,
    iy: 0,
    coverScale: 1,
  });
  const [zoom, setZoom] = useState(100);

  const render = useCallback(() => {
    const img = imgRef.current;
    if (!img) return;
    const { dispW, dispH, ix, iy } = g.current;
    img.style.width = `${dispW}px`;
    img.style.height = `${dispH}px`;
    img.style.left = `${ix}px`;
    img.style.top = `${iy}px`;
  }, []);

  const clampPan = useCallback(() => {
    const c = g.current;
    c.ix = Math.min(c.WL, Math.max(c.WL + c.CW - c.dispW, c.ix));
    c.iy = Math.min(c.WT, Math.max(c.WT + c.CH - c.dispH, c.iy));
  }, []);

  const layout = useCallback(() => {
    const stage = stageRef.current;
    const win = winRef.current;
    if (!stage || !win) return;
    const r = stage.getBoundingClientRect();
    const c = g.current;
    c.SW = r.width;
    c.SH = r.height;
    c.CH = Math.min(c.SH * 0.88, c.SW * 0.88 * aspect);
    c.CW = c.CH / aspect;
    c.WL = (c.SW - c.CW) / 2;
    c.WT = (c.SH - c.CH) / 2;
    win.style.width = `${c.CW}px`;
    win.style.height = `${c.CH}px`;
  }, [aspect]);

  const applyZoom = useCallback(
    (z: number, ax?: number, ay?: number) => {
      const c = g.current;
      const cx = ax == null ? c.WL + c.CW / 2 : ax;
      const cy = ay == null ? c.WT + c.CH / 2 : ay;
      const fx = c.dispW ? (cx - c.ix) / c.dispW : 0.5;
      const fy = c.dispH ? (cy - c.iy) / c.dispH : 0.5;
      c.dispW = c.nw * c.coverScale * z;
      c.dispH = c.nh * c.coverScale * z;
      c.ix = cx - fx * c.dispW;
      c.iy = cy - fy * c.dispH;
      clampPan();
      render();
    },
    [clampPan, render],
  );

  // Initialise geometry whenever the modal opens with a source image.
  useEffect(() => {
    if (!open || !src) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const im = new Image();
    im.onload = () => {
      const c = g.current;
      c.nw = im.naturalWidth || 1;
      c.nh = im.naturalHeight || 1;
      requestAnimationFrame(() => {
        layout();
        c.coverScale = Math.max(c.CW / c.nw, c.CH / c.nh);
        c.dispW = c.nw * c.coverScale;
        c.dispH = c.nh * c.coverScale;
        c.ix = c.WL + (c.CW - c.dispW) / 2;
        c.iy = c.WT + (c.CH - c.dispH) / 2;
        clampPan();
        render();
        setZoom(100);
      });
    };
    im.src = src;

    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [open, src, layout, clampPan, render]);

  // Pan (window-bound listeners; no setPointerCapture so card transforms can't
  // steal the gesture with a pointercancel).
  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      const ox = g.current.ix;
      const oy = g.current.iy;
      const move = (ev: PointerEvent) => {
        g.current.ix = ox + (ev.clientX - startX);
        g.current.iy = oy + (ev.clientY - startY);
        clampPan();
        render();
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [clampPan, render],
  );

  // Wheel zoom anchored at the cursor.
  useEffect(() => {
    const stage = stageRef.current;
    if (!open || !stage) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const next = Math.max(
        1,
        Math.min(4, (zoom / 100) * (e.deltaY < 0 ? 1.08 : 0.926)),
      );
      const r = stage.getBoundingClientRect();
      setZoom(Math.round(next * 100));
      applyZoom(next, e.clientX - r.left, e.clientY - r.top);
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [open, zoom, applyZoom]);

  // Escape closes.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  const handleConfirm = useCallback(() => {
    if (!src) return;
    const c = g.current;
    const scale = c.dispW / c.nw; // displayed px per natural px
    const sx = (c.WL - c.ix) / scale;
    const sy = (c.WT - c.iy) / scale;
    const sw = c.CW / scale;
    const sh = c.CH / scale;
    const outH = Math.round(OUT_W * aspect);
    const cv = document.createElement("canvas");
    cv.width = OUT_W;
    cv.height = outH;
    const ctx = cv.getContext("2d");
    if (!ctx) {
      onConfirm(src);
      return;
    }
    const im = new Image();
    im.onload = () => {
      ctx.drawImage(im, sx, sy, sw, sh, 0, 0, OUT_W, outH);
      let cropped: string;
      try {
        cropped = cv.toDataURL("image/jpeg", 0.9);
      } catch {
        cropped = src;
      }
      onConfirm(cropped);
    };
    im.src = src;
  }, [src, aspect, onConfirm]);

  if (!open || !src) return null;

  return (
    <div
      className="agcpass-crop-modal"
      role="dialog"
      aria-modal="true"
      aria-label="裁切照片"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="agcpass-crop-sheet">
        <div className="agcpass-crop-head">
          <span className="agcpass-crop-title">裁切照片做卡面</span>
          <span className="agcpass-crop-sub">
            拖动移动 · 滑杆 / 滚轮缩放 · 亮框内即卡面，框外会被裁掉
          </span>
        </div>
        <div
          className="agcpass-crop-stage"
          ref={stageRef}
          onPointerDown={onPointerDown}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="agcpass-crop-img" ref={imgRef} src={src} alt="待裁切的照片" />
          <div className="agcpass-crop-window" ref={winRef} aria-hidden="true" />
        </div>
        <div className="agcpass-crop-ctrls">
          <span className="cz-ico">A</span>
          <input
            type="range"
            min={100}
            max={400}
            value={zoom}
            aria-label="缩放"
            onChange={(e) => {
              const z = Number(e.target.value);
              setZoom(z);
              applyZoom(z / 100);
            }}
          />
          <span className="cz-ico big">A</span>
        </div>
        <div className="agcpass-crop-actions">
          <button
            type="button"
            className="agcpass-crop-cancel"
            onClick={onCancel}
          >
            取消
          </button>
          <button
            type="button"
            className="agcpass-crop-confirm"
            onClick={handleConfirm}
          >
            确认 · 用这张做卡面
          </button>
        </div>
      </div>
    </div>
  );
}
