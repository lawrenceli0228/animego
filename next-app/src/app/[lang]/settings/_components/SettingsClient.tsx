"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import Link from "@/components/ui/LocaleLink";
import { useRouter } from "next/navigation";
import { authFetch } from "@/lib/authFetch";
import { useLang } from "@/lib/lang-client";
import MemberPass from "@/components/profile/MemberPass";
import PhotoCropModal from "@/components/profile/PhotoCropModal";
import { downscaleImage } from "@/components/profile/imageDownscale";
import { memberNo as makeMemberNo, sinceLabel } from "@/components/profile/memberIdentity";
import type { BackdropOption } from "@/components/profile/backdropTypes";
import { DEFAULT_CARD_IMAGE, DEFAULT_BACKDROP_IMAGE } from "@/lib/cardDefaults";
import { cssUrl } from "@/lib/cssUrl";
import FallbackImg from "@/components/ui/FallbackImg";
import { settingsErrorMessage } from "./settingsState";
import BlockedUsersList from "./BlockedUsersList";
import PlaybackSettings from "./PlaybackSettings";
import "./settings.css";
import type { Lang } from "@/lib/i18n/lang";

interface SettingsClientProps {
  username: string;
  /**
   * True when `username` above is a masked handle rather than a name its
   * owner chose — see go-api/internal/pii. Supplied by the API rather than
   * re-derived here on purpose: a second copy of the detection rule would
   * eventually disagree with the Go one, and the failure mode is telling
   * someone their name is fine while the server hides it.
   */
  usernameHidden: boolean;
  userId: string | null;
  createdAt: string | null;
  avatarUrl: string | null;
  backdropAnilistId: number | null;
  backdropOptions: BackdropOption[];
  watchedCount: number;
  topSeason: string | null;
  isPublic: boolean;
}

type Status = { kind: "idle" | "saving" | "ok" | "err"; msg?: string };

interface PatchResult {
  ok: boolean;
  error?: string;
}

// Takes the language rather than an is-Chinese boolean. Two of the three
// strings it can return are fallbacks for a failed request, which is exactly
// the path nobody re-reads — a boolean would have silently handed a third
// language the English copy.
const PATCH_FALLBACK: Record<Lang, { save: string; network: string }> = {
  zh: { save: "保存失败", network: "网络错误" },
  en: { save: "Save failed", network: "Network error" },
  "zh-Hant": { save: "儲存失敗", network: "網路錯誤" },
};

async function patchMe(
  body: Record<string, unknown>,
  lang: Lang,
): Promise<PatchResult> {
  try {
    const r = await authFetch("/api/auth/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      skipRedirectOnFailure: true,
    });
    if (r.ok) return { ok: true };
    const errorBody: unknown = await r.json().catch(() => null);
    return {
      ok: false,
      error: settingsErrorMessage(errorBody, PATCH_FALLBACK[lang].save),
    };
  } catch {
    return { ok: false, error: PATCH_FALLBACK[lang].network };
  }
}

export default function SettingsClient({
  username,
  usernameHidden,
  userId,
  createdAt,
  avatarUrl,
  backdropAnilistId,
  backdropOptions,
  watchedCount,
  topSeason,
  isPublic,
}: SettingsClientProps) {
  const router = useRouter();
  const { lang, t } = useLang();
  const memberNo = makeMemberNo(userId);
  const since = sinceLabel(createdAt);

  const [name, setName] = useState(username);

  // The server decides whether the name is hidden; we never re-derive it.
  // Gated on the field still holding the handle, so the warning clears the
  // moment they type a replacement rather than lingering until the save
  // round-trips.
  const usernameIsHidden = usernameHidden && name.trim() === username;

  const [nameStatus, setNameStatus] = useState<Status>({ kind: "idle" });
  const [photoUrl, setPhotoUrl] = useState<string | null>(avatarUrl);
  const [passStatus, setPassStatus] = useState<Status>({ kind: "idle" });
  const [backdropId, setBackdropId] = useState<number | null>(backdropAnilistId);
  const [cropOpen, setCropOpen] = useState(false);
  const [cropSrc, setCropSrc] = useState<string | null>(null);
  const [publicProfile, setPublicProfile] = useState(isPublic);
  const [privacyStatus, setPrivacyStatus] = useState<Status>({ kind: "idle" });
  const fileRef = useRef<HTMLInputElement>(null);

  const chosen =
    backdropOptions.find((o) => o.anilistId === backdropId) ??
    backdropOptions[0] ??
    null;
  const cardArt = chosen?.coverUrl ?? null;
  const chosenBanner = chosen?.bannerUrl ?? chosen?.coverUrl ?? DEFAULT_BACKDROP_IMAGE;
  // The page backdrop is a WIDE banner — only offer anime that actually have
  // one (a portrait cover stretched wide looks bad).
  const bannerOptions = backdropOptions.filter((o) => o.bannerUrl);

  // ── username ──
  const saveName = useCallback(async () => {
    const v = name.trim();
    if (v.length < 3) {
      setNameStatus({ kind: "err", msg: t("settings.usernameTooShort") });
      return;
    }
    if (v === username) {
      setNameStatus({ kind: "idle" });
      return;
    }
    setNameStatus({ kind: "saving" });
    const res = await patchMe({ username: v }, lang);
    if (res.ok) {
      setNameStatus({ kind: "ok", msg: t("settings.saved") });
      router.refresh();
    } else {
      setNameStatus({ kind: "err", msg: res.error });
    }
  }, [name, username, lang, router, t]);

  // ── photo ──
  const onFile = useCallback((file: File | undefined) => {
    if (!file || !/^image\//.test(file.type)) return;
    const fr = new FileReader();
    fr.onload = () => {
      void downscaleImage(String(fr.result)).then((u) => {
        setCropSrc(u);
        setCropOpen(true);
      });
    };
    fr.readAsDataURL(file);
  }, []);

  // Photo + backdrop edits stay local (live preview + mini-card) until the
  // user clicks 保存 on the 会员通行证 card — mirrors the 账号 section's
  // explicit-save flow.
  const onCropConfirm = useCallback((cropped: string) => {
    setCropOpen(false);
    setPhotoUrl(cropped);
    setPassStatus({ kind: "idle" });
  }, []);

  const removePhoto = useCallback(() => {
    setPhotoUrl(null);
    setPassStatus({ kind: "idle" });
  }, []);

  const pickBackdrop = useCallback((id: number) => {
    setBackdropId(id);
    setPassStatus({ kind: "idle" });
  }, []);

  const photoChanged = (photoUrl ?? null) !== (avatarUrl ?? null);
  const backdropChanged = (backdropId ?? null) !== (backdropAnilistId ?? null);
  const passDirty = photoChanged || backdropChanged;

  const savePass = useCallback(async () => {
    const body: Record<string, unknown> = {};
    if (photoChanged) body.avatarUrl = photoUrl ?? "";
    if (backdropChanged) body.backdropAnilistId = backdropId ?? 0;
    if (Object.keys(body).length === 0) return;
    setPassStatus({ kind: "saving" });
    const res = await patchMe(body, lang);
    if (res.ok) {
      setPassStatus({ kind: "ok", msg: t("settings.saved") });
      router.refresh();
    } else {
      setPassStatus({ kind: "err", msg: res.error });
    }
  }, [photoChanged, backdropChanged, photoUrl, backdropId, lang, router, t]);

  const savePrivacy = useCallback(async () => {
    if (publicProfile === isPublic) return;
    setPrivacyStatus({ kind: "saving" });
    const res = await patchMe({ isPublic: publicProfile }, lang);
    if (res.ok) {
      setPrivacyStatus({ kind: "ok", msg: t("settings.saved") });
      router.refresh();
    } else {
      setPublicProfile(isPublic);
      setPrivacyStatus({ kind: "err", msg: res.error });
    }
  }, [isPublic, publicProfile, router, t, lang]);

  const msgEl = (s: Status) =>
    s.kind === "ok" || s.kind === "err" ? (
      <span className={`set-msg ${s.kind}`}>{s.msg}</span>
    ) : null;

  const idDisplay = useMemo(() => `#${memberNo}`, [memberNo]);

  return (
    <div className="set-page">
      <div className="set-head">
        <div className="set-head-titles">
          <p className="set-kicker">{t("settings.kicker")}</p>
          <h1 className="set-title">{t("settings.pageTitle")}</h1>
        </div>
        {/* live nav mini-card preview: picking a backdrop shows its banner here */}
        <div className="set-minicard">
          {chosenBanner && (
            <div
              className="set-minicard-bg"
              style={{ backgroundImage: cssUrl(chosenBanner, DEFAULT_BACKDROP_IMAGE) }}
              aria-hidden="true"
            />
          )}
          <div className="av">
            <FallbackImg src={photoUrl ?? cardArt ?? DEFAULT_CARD_IMAGE} fallback={DEFAULT_CARD_IMAGE} />
          </div>
          <div className="info">
            <b>{name || username}</b>
            <span>{t("settings.navPreview")}</span>
          </div>
        </div>
      </div>

      <div className="set-grid">
        {/* live preview */}
        <aside className="set-preview">
          <MemberPass
            username={name || username}
            memberNo={memberNo}
            since={since}
            watchedCount={watchedCount}
            topSeason={topSeason}
            artUrl={cardArt}
            photoUrl={photoUrl}
            lang={lang}
          />
          <span className="set-id">{idDisplay}</span>
          <span className="hint">{t("settings.livePreview")}</span>
        </aside>

        <div className="set-cols">
          {/* pass: photo + backdrop */}
          <section className="set-card">
            <h2>{t("settings.passTitle")}</h2>
            <p className="sub">{t("settings.passSubtitle")}</p>

            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                onFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            <div className="set-photo">
              {photoUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img className="set-thumb" src={photoUrl} alt={t("settings.currentCardAlt")} />
              )}
              <div className="set-actions">
                <button type="button" className="set-btn" onClick={() => fileRef.current?.click()}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <path d="M17 8l-5-5-5 5" />
                    <path d="M12 3v13" />
                  </svg>
                  {photoUrl ? t("settings.changePhoto") : t("settings.uploadPhoto")}
                </button>
                {photoUrl && (
                  <button type="button" className="set-btn danger" onClick={removePhoto}>
                    {t("settings.removePhoto")}
                  </button>
                )}
              </div>
            </div>

            <div style={{ marginTop: 18 }}>
              <label style={{ fontSize: 12.5, fontWeight: 600, color: "rgba(235,235,245,0.7)" }}>
                {t("settings.backdropLabel")}
              </label>
              {bannerOptions.length === 0 ? (
                <p className="hint" style={{ marginTop: 8 }}>
                  {t("settings.backdropEmpty")}
                </p>
              ) : (
                <div
                  className="set-grid-thumbs"
                  role="listbox"
                  aria-label={t("settings.backdropListAria")}
                >
                  {bannerOptions.map((o) => (
                    <button
                      key={o.anilistId}
                      type="button"
                      className="set-cell"
                      role="option"
                      aria-selected={o.anilistId === backdropId}
                      title={o.title}
                      onClick={() => pickBackdrop(o.anilistId)}
                    >
                      <FallbackImg
                        src={o.coverUrl ?? o.bannerUrl ?? DEFAULT_CARD_IMAGE}
                        fallback={DEFAULT_CARD_IMAGE}
                        alt={o.title}
                        loading="lazy"
                      />
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div
              className="set-actions"
              style={{ marginTop: 18, borderTop: "1px solid #38383a", paddingTop: 16 }}
            >
              <button
                type="button"
                className="set-btn"
                disabled={!passDirty || passStatus.kind === "saving"}
                onClick={savePass}
              >
                {passStatus.kind === "saving"
                  ? t("settings.saving")
                  : t("settings.savePass")}
              </button>
              {msgEl(passStatus)}
            </div>
          </section>

          {/* account: username */}
          <section className="set-card">
            <h2>{t("settings.accountTitle")}</h2>
            <p className="sub">{t("settings.accountSubtitle").replace("{{id}}", idDisplay)}</p>
            <div className="set-field">
              <label htmlFor="set-username">{t("settings.usernameLabel")}</label>
              <input
                id="set-username"
                className="set-input"
                value={name}
                maxLength={50}
                onChange={(e) => setName(e.target.value)}
                aria-describedby={usernameIsHidden ? "set-username-hidden" : undefined}
              />
            </div>
            {usernameIsHidden && (
              // Each run of copy is a single string expression rather than JSX
              // text. JSX turns a newline + indent into a space, which is
              // correct for English and wrong for Chinese — that is what put
              // stray gaps mid-sentence here before.
              <div id="set-username-hidden" className="set-warn" role="status">
                <p className="set-warn-title">
                  {t("settings.usernameHiddenTitle")}
                </p>
                <p className="set-warn-body">
                  {t("settings.usernameHiddenBody")}
                </p>
                <code className="set-warn-code">{username}</code>
              </div>
            )}
            <div className="set-actions">
              <button
                type="button"
                className="set-btn"
                disabled={nameStatus.kind === "saving" || name.trim() === username}
                onClick={saveName}
              >
                {nameStatus.kind === "saving" ? t("settings.saving") : t("settings.saveUsername")}
              </button>
              {msgEl(nameStatus)}
            </div>
          </section>

          {/* playback: device-local prefs, no server round trip, no Save */}
          <PlaybackSettings />

          {/* community & privacy */}
          <section className="set-card">
            <h2>{t("settings.communityTitle")}</h2>
            <p className="sub">{t("settings.communitySubtitle")}</p>
            <label className="set-toggle" htmlFor="set-public-profile">
              <input
                id="set-public-profile"
                type="checkbox"
                checked={publicProfile}
                onChange={(event) => {
                  setPublicProfile(event.target.checked);
                  setPrivacyStatus({ kind: "idle" });
                }}
              />
              <span>
                <b>{t("settings.publicProfile")}</b>
                <span className="set-toggle-desc">
                  {publicProfile
                    ? t("settings.publicProfileOn")
                    : t("settings.publicProfileOff")}
                </span>
              </span>
            </label>
            <div className="set-actions" style={{ marginTop: 18 }}>
              <button
                type="button"
                className="set-btn"
                disabled={privacyStatus.kind === "saving" || publicProfile === isPublic}
                onClick={() => void savePrivacy()}
              >
                {privacyStatus.kind === "saving"
                  ? t("settings.saving")
                  : t("settings.savePrivacy")}
              </button>
              {msgEl(privacyStatus)}
            </div>
            <BlockedUsersList />
          </section>

          {/* security: password changes go through the email reset flow */}
          <section className="set-card">
            <h2>{t("settings.securityTitle")}</h2>
            <p className="sub">{t("settings.securitySubtitle")}</p>
            <p
              style={{
                fontSize: 13.5,
                color: "rgba(235,235,245,0.72)",
                lineHeight: 1.65,
                margin: 0,
              }}
            >
              {t("settings.passwordResetHint")}
            </p>
            <p
              style={{
                fontSize: 12.5,
                color: "rgba(235,235,245,0.45)",
                lineHeight: 1.6,
                margin: "6px 0 0",
              }}
            >
              {t("settings.passwordResetHintAlt")}
            </p>
            <div className="set-actions" style={{ marginTop: 16 }}>
              <Link href="/login" className="set-btn ghost" style={{ textDecoration: "none" }}>
                {t("settings.goToLogin")}
              </Link>
            </div>
          </section>
        </div>
      </div>

      <PhotoCropModal open={cropOpen} src={cropSrc} onConfirm={onCropConfirm} onCancel={() => setCropOpen(false)} />
    </div>
  );
}
