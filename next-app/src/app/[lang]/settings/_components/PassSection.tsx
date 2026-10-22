"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useLang } from "@/lib/lang-client";
import FallbackImg from "@/components/ui/FallbackImg";
import type { BackdropOption } from "@/components/profile/backdropTypes";
import { DEFAULT_AVATAR_IMAGE, DEFAULT_BACKDROP_IMAGE, DEFAULT_CARD_IMAGE } from "@/lib/cardDefaults";
import { fillTemplate } from "@/lib/home/time";
import type { PassEditor } from "./settingsState";
import "./settings-pass.css";

/** Tiles shown before 显示全部 N 部. */
const FIRST_TILES = 9;

// The widths these images are drawn at (settings.css), which pick the size
// of the AniList variant FallbackImg asks the optimizer for.
const TILE_BANNER_WIDTH = 360;
const TILE_COVER_WIDTH = 60;
const PREVIEW_BANNER_WIDTH = 720;
const PREVIEW_AVATAR_WIDTH = 44;

interface PassSectionProps {
  /** The live member pass, for the phone: on a desktop it is in the aside. */
  passCard: ReactNode;
  /** Backdrop choices: only anime with a wide banner, which a cover stretched wide is not. */
  options: BackdropOption[];
  editor: PassEditor;
  /** The display name as currently typed. */
  name: string;
  /** The face the profile shows: the photo, else the chosen cover. */
  avatarSrc: string;
  previewBanner: string;
  onPhotoFile: (file: File | undefined) => void;
}

function CheckGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

export default function PassSection({
  passCard,
  options,
  editor,
  name,
  avatarSrc,
  previewBanner,
  onPhotoFile,
}: PassSectionProps) {
  const { t } = useLang();
  const backdropLabelId = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const uploadRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const firstRevealedRef = useRef<HTMLButtonElement>(null);
  const revealing = useRef(false);

  // Opens on the whole list when the saved choice is past the first nine, so
  // the tile wearing the check is on screen.
  const [expanded, setExpanded] = useState(
    () => options.findIndex((o) => o.anilistId === editor.edited.backdrop) >= FIRST_TILES,
  );
  const shown = expanded ? options : options.slice(0, FIRST_TILES);

  // 显示全部 unmounts itself; its focus goes to the first tile it revealed.
  useEffect(() => {
    if (!expanded || !revealing.current) return;
    revealing.current = false;
    firstRevealedRef.current?.focus();
  }, [expanded]);

  // The save bar goes away once the pass is saved or reverted. Focus that was
  // on one of its buttons goes to the section heading, not to nowhere.
  const barHasFocus = () => barRef.current?.contains(document.activeElement) ?? false;
  const settleFocus = () => headingRef.current?.focus({ preventScroll: true });

  const revert = () => {
    if (barHasFocus()) settleFocus();
    editor.revert();
  };

  const save = async () => {
    const hadFocus = barHasFocus();
    if ((await editor.save()) && hadFocus) settleFocus();
  };

  return (
    <section className="set-sec" id="pass" aria-labelledby="set-pass-h">
      <div className="set-sec-head">
        <h2 className="set-sec-title" id="set-pass-h" ref={headingRef} tabIndex={-1}>
          {t("settings.passTitle")}
        </h2>
      </div>
      <div className="set-card">
        <div className="set-pass-phone">{passCard}</div>

        <div className="set-blk">
          <span className="set-label">{t("settings.photoLabel")}</span>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(event) => {
              onPhotoFile(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
          <div className="set-photo">
            <button
              ref={uploadRef}
              type="button"
              className="set-btn ghost sm"
              onClick={() => fileRef.current?.click()}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <path d="M17 8l-5-5-5 5" />
                <path d="M12 3v13" />
              </svg>
              {t("settings.uploadPhoto")}
            </button>
            {editor.edited.photo && (
              <button
                type="button"
                className="set-btn quiet sm"
                onClick={(event) => {
                  // This button goes with the photo; its focus moves next door.
                  if (event.currentTarget === document.activeElement) uploadRef.current?.focus();
                  editor.setPhoto(null);
                }}
              >
                {t("settings.removePhoto")}
              </button>
            )}
          </div>
        </div>

        <div className="set-blk">
          <span className="set-label" id={backdropLabelId}>
            {t("settings.backdropLabel")}
          </span>
          {/* A picture of the profile header: everything in it is said elsewhere. */}
          <div className="set-prev" aria-hidden="true">
            <FallbackImg
              key={previewBanner}
              className="set-prev-bn"
              src={previewBanner}
              fallback={DEFAULT_BACKDROP_IMAGE}
              width={PREVIEW_BANNER_WIDTH}
            />
            <div className="set-prev-me">
              <FallbackImg
                key={avatarSrc}
                className="set-prev-av"
                src={avatarSrc}
                fallback={DEFAULT_AVATAR_IMAGE}
                width={PREVIEW_AVATAR_WIDTH}
              />
              <span className="set-prev-name">{name}</span>
            </div>
          </div>
          {options.length === 0 ? (
            <p className="set-empty">{t("settings.backdropEmpty")}</p>
          ) : (
            <div className="set-bk-grid" role="group" aria-labelledby={backdropLabelId}>
              {shown.map((option, index) => {
                const selected = option.anilistId === editor.edited.backdrop;
                return (
                  <button
                    key={option.anilistId}
                    ref={index === FIRST_TILES ? firstRevealedRef : undefined}
                    type="button"
                    className="set-bk"
                    aria-pressed={selected}
                    aria-label={fillTemplate(t("settings.backdropPick"), { title: option.title })}
                    onClick={() => editor.setBackdrop(option.anilistId)}
                  >
                    <FallbackImg
                      className="set-bk-bn"
                      src={option.bannerUrl ?? DEFAULT_BACKDROP_IMAGE}
                      fallback={DEFAULT_BACKDROP_IMAGE}
                      width={TILE_BANNER_WIDTH}
                    />
                    <span className="set-bk-in">
                      <FallbackImg
                        className="set-bk-cv"
                        src={option.coverUrl ?? DEFAULT_CARD_IMAGE}
                        fallback={DEFAULT_CARD_IMAGE}
                        width={TILE_COVER_WIDTH}
                      />
                      <span className="set-bk-nm">{option.title}</span>
                    </span>
                    {selected && (
                      <span className="set-bk-ck" aria-hidden="true">
                        <CheckGlyph />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
          {!expanded && options.length > FIRST_TILES && (
            <button
              type="button"
              className="set-btn quiet sm set-more"
              onClick={() => {
                revealing.current = true;
                setExpanded(true);
              }}
            >
              {fillTemplate(t("settings.showAllBackdrops"), { n: options.length })}
            </button>
          )}
        </div>

        {editor.dirty && (
          <div className="set-savebar" ref={barRef}>
            <span className="set-savebar-text">{t("settings.passDirty")}</span>
            <button type="button" className="set-btn quiet sm" onClick={revert}>
              {t("settings.revert")}
            </button>
            <button type="button" className="set-btn sm" onClick={() => void save()}>
              {t("settings.save")}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
