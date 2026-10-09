"use client";

// The portrait in the edit state: the picture with 「更换图片」 across its foot
// (the canvas's .ph .ov), and under it the picker -- 粘贴链接 or 上传图片. A
// pasted link previews as the link itself; an upload is scaled down and
// re-encoded in the browser first (lib/people/edit/photo.ts) and previews as
// what will be sent. Neither is public until an admin accepts it.

import { useState, type ChangeEvent } from "react";
import FadeImage from "@/components/ui/FadeImage";
import { useLang } from "@/lib/lang-client";
import type { PhotoDraft } from "@/lib/people/edit/model";
import { preparePhoto } from "@/lib/people/edit/photo";
import e from "./edit.module.css";

interface PhotoFieldProps {
  kind: "person" | "character";
  current: string | null;
  alt: string;
  photo: PhotoDraft | null;
  onChange: (photo: PhotoDraft | null) => void;
}

const SIZE = {
  character: { width: 230, height: 345 },
  person: { width: 200, height: 300 },
} as const;

/** A link worth previewing: https with a host. */
function previewable(url: string): boolean {
  try {
    const u = new URL(url.trim());
    return u.protocol === "https:" && u.hostname.includes(".");
  } catch {
    return false;
  }
}

export default function PhotoField({ kind, current, alt, photo, onChange }: PhotoFieldProps) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"url" | "upload">("url");
  const [link, setLink] = useState("");
  const [failed, setFailed] = useState(false);

  const preview = photo?.kind === "upload" ? photo.dataUrl : photo?.kind === "url" ? photo.url.trim() : null;
  const size = SIZE[kind];

  const onLink = (event: ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value;
    setLink(value);
    setFailed(false);
    onChange(previewable(value) ? { kind: "url", url: value } : null);
  };

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const prepared = await preparePhoto(file);
    setFailed(!prepared);
    onChange(prepared ? { kind: "upload", ...prepared } : null);
  };

  return (
    <div className={e.photoSlot}>
      <div className={e.photoFrame} data-kind={kind}>
        <FadeImage
          key={preview ?? current ?? "none"}
          src={preview ?? current}
          alt={alt}
          width={size.width}
          height={size.height}
          priority
          className={e.photo}
          unoptimized={preview !== null || undefined}
        />
        <button
          type="button"
          className={e.photoButton}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <svg className={e.icon} viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 7h3l2-3h6l2 3h3v13H4zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z" />
          </svg>
          {t("peopleEdit.changePhoto")}
        </button>
      </div>
      {open ? (
        <div className={e.picker}>
          <div className={e.segment} role="group" aria-label={t("peopleEdit.photoMode")}>
            <button
              type="button"
              className={e.segmentButton}
              aria-pressed={mode === "url"}
              onClick={() => setMode("url")}
            >
              {t("peopleEdit.pasteLink")}
            </button>
            <button
              type="button"
              className={e.segmentButton}
              aria-pressed={mode === "upload"}
              onClick={() => setMode("upload")}
            >
              {t("peopleEdit.upload")}
            </button>
          </div>
          <div className={e.pickerRow}>
            {mode === "url" ? (
              <div className={e.box}>
                <input
                  type="url"
                  inputMode="url"
                  className={e.boxInput}
                  aria-label={t("peopleEdit.photoLink")}
                  value={link}
                  maxLength={2000}
                  onChange={onLink}
                />
              </div>
            ) : (
              <label className={e.fileButton}>
                {t("peopleEdit.chooseFile")}
                <input type="file" accept="image/*" className={e.fileInput} onChange={onFile} />
              </label>
            )}
          </div>
          {failed ? (
            <p className={e.fieldError} role="alert">
              {t("peopleEdit.errors.imageUnreadable")}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
