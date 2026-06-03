"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { authFetch } from "@/lib/authFetch";
import type { Lang } from "@/lib/i18n";
import MemberPass from "@/components/profile/MemberPass";
import PhotoCropModal from "@/components/profile/PhotoCropModal";
import { downscaleImage } from "@/components/profile/imageDownscale";
import { memberNo as makeMemberNo, sinceLabel } from "@/components/profile/memberIdentity";
import type { BackdropOption } from "@/components/profile/backdropTypes";
import { DEFAULT_CARD_IMAGE, DEFAULT_BACKDROP_IMAGE } from "@/lib/cardDefaults";
import { cssUrl } from "@/lib/cssUrl";
import FallbackImg from "@/components/ui/FallbackImg";
import "./settings.css";

interface SettingsClientProps {
  username: string;
  userId: string | null;
  createdAt: string | null;
  avatarUrl: string | null;
  backdropAnilistId: number | null;
  backdropOptions: BackdropOption[];
  watchedCount: number;
  topSeason: string | null;
  lang: Lang;
}

type Status = { kind: "idle" | "saving" | "ok" | "err"; msg?: string };

interface PatchResult {
  ok: boolean;
  error?: string;
}

async function patchMe(body: Record<string, unknown>): Promise<PatchResult> {
  try {
    const r = await authFetch("/api/auth/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      skipRedirectOnFailure: true,
    });
    if (r.ok) return { ok: true };
    const e = await r.json().catch(() => null);
    return { ok: false, error: e?.error ?? e?.message ?? "保存失败" };
  } catch {
    return { ok: false, error: "网络错误" };
  }
}

export default function SettingsClient({
  username,
  userId,
  createdAt,
  avatarUrl,
  backdropAnilistId,
  backdropOptions,
  watchedCount,
  topSeason,
  lang,
}: SettingsClientProps) {
  const router = useRouter();
  const zh = lang === "zh";
  const memberNo = makeMemberNo(userId);
  const since = sinceLabel(createdAt);

  const [name, setName] = useState(username);
  const [nameStatus, setNameStatus] = useState<Status>({ kind: "idle" });
  const [photoUrl, setPhotoUrl] = useState<string | null>(avatarUrl);
  const [passStatus, setPassStatus] = useState<Status>({ kind: "idle" });
  const [backdropId, setBackdropId] = useState<number | null>(backdropAnilistId);
  const [cropOpen, setCropOpen] = useState(false);
  const [cropSrc, setCropSrc] = useState<string | null>(null);
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
      setNameStatus({ kind: "err", msg: zh ? "用户名至少 3 个字符" : "Min 3 chars" });
      return;
    }
    if (v === username) {
      setNameStatus({ kind: "idle" });
      return;
    }
    setNameStatus({ kind: "saving" });
    const res = await patchMe({ username: v });
    if (res.ok) {
      setNameStatus({ kind: "ok", msg: zh ? "已保存" : "Saved" });
      router.refresh();
    } else {
      setNameStatus({ kind: "err", msg: res.error });
    }
  }, [name, username, zh, router]);

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
    const res = await patchMe(body);
    if (res.ok) {
      setPassStatus({ kind: "ok", msg: zh ? "已保存" : "Saved" });
      router.refresh();
    } else {
      setPassStatus({ kind: "err", msg: res.error });
    }
  }, [photoChanged, backdropChanged, photoUrl, backdropId, zh, router]);

  const msgEl = (s: Status) =>
    s.kind === "ok" || s.kind === "err" ? (
      <span className={`set-msg ${s.kind}`}>{s.msg}</span>
    ) : null;

  const idDisplay = useMemo(() => `#${memberNo}`, [memberNo]);

  return (
    <div className="set-page">
      <div className="set-head">
        <div className="set-head-titles">
          <p className="set-kicker">{zh ? "用户设置" : "Settings"}</p>
          <h1 className="set-title">{zh ? "账号与通行证" : "Account & Pass"}</h1>
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
            <span>{zh ? "导航头像预览 · 改背景实时可见" : "Nav avatar preview · live"}</span>
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
          <span className="hint">{zh ? "实时预览" : "Live preview"}</span>
        </aside>

        <div className="set-cols">
          {/* pass: photo + backdrop */}
          <section className="set-card">
            <h2>{zh ? "会员通行证" : "Member Pass"}</h2>
            <p className="sub">{zh ? "设置卡面照片与主页背景" : "Card photo and profile backdrop"}</p>

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
                <img className="set-thumb" src={photoUrl} alt={zh ? "当前卡面" : "Current"} />
              )}
              <div className="set-actions">
                <button type="button" className="set-btn" onClick={() => fileRef.current?.click()}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <path d="M17 8l-5-5-5 5" />
                    <path d="M12 3v13" />
                  </svg>
                  {photoUrl ? (zh ? "更换照片" : "Change") : zh ? "上传照片做卡面" : "Upload photo"}
                </button>
                {photoUrl && (
                  <button type="button" className="set-btn danger" onClick={removePhoto}>
                    {zh ? "移除" : "Remove"}
                  </button>
                )}
              </div>
            </div>

            <div style={{ marginTop: 18 }}>
              <label style={{ fontSize: 12.5, fontWeight: 600, color: "rgba(235,235,245,0.7)" }}>
                {zh ? "主页背景番剧（用宽幅 banner）" : "Backdrop anime (wide banner)"}
              </label>
              {bannerOptions.length === 0 ? (
                <p className="hint" style={{ marginTop: 8 }}>
                  {zh
                    ? "列表里还没有带宽幅 banner 的番剧"
                    : "No anime with a wide banner in your list yet"}
                </p>
              ) : (
                <div className="set-grid-thumbs" role="listbox">
                  {bannerOptions.map((o) => (
                    <button
                      key={o.anilistId}
                      type="button"
                      className="set-cell"
                      role="option"
                      aria-pressed={o.anilistId === backdropId}
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
                  ? zh
                    ? "保存中…"
                    : "Saving…"
                  : zh
                    ? "保存通行证"
                    : "Save pass"}
              </button>
              {msgEl(passStatus)}
            </div>
          </section>

          {/* account: username */}
          <section className="set-card">
            <h2>{zh ? "账号" : "Account"}</h2>
            <p className="sub">{zh ? `专属编号 ${idDisplay} · 不可更改` : `Member ${idDisplay} · permanent`}</p>
            <div className="set-field">
              <label htmlFor="set-username">{zh ? "用户名" : "Username"}</label>
              <input
                id="set-username"
                className="set-input"
                value={name}
                maxLength={50}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="set-actions">
              <button
                type="button"
                className="set-btn"
                disabled={nameStatus.kind === "saving" || name.trim() === username}
                onClick={saveName}
              >
                {nameStatus.kind === "saving" ? (zh ? "保存中…" : "Saving…") : zh ? "保存用户名" : "Save"}
              </button>
              {msgEl(nameStatus)}
            </div>
          </section>

          {/* security: password changes go through the email reset flow */}
          <section className="set-card">
            <h2>{zh ? "安全" : "Security"}</h2>
            <p className="sub">{zh ? "修改密码 · Change password" : "Change password · 修改密码"}</p>
            <p
              style={{
                fontSize: 13.5,
                color: "rgba(235,235,245,0.72)",
                lineHeight: 1.65,
                margin: 0,
              }}
            >
              {zh
                ? "为了账号安全，修改密码请在登录界面点击「忘记密码」，通过邮箱重置。"
                : "For account security, change your password via the “Forgot password” link on the login page (reset by email)."}
            </p>
            <p
              style={{
                fontSize: 12.5,
                color: "rgba(235,235,245,0.45)",
                lineHeight: 1.6,
                margin: "6px 0 0",
              }}
            >
              {zh
                ? "To change your password, click “Forgot password” on the login page."
                : "修改密码请在登录界面点击「忘记密码」。"}
            </p>
            <div className="set-actions" style={{ marginTop: 16 }}>
              <Link href="/login" className="set-btn ghost" style={{ textDecoration: "none" }}>
                {zh ? "前往登录页 · Go to login" : "Go to login · 前往登录页"}
              </Link>
            </div>
          </section>
        </div>
      </div>

      <PhotoCropModal open={cropOpen} src={cropSrc} onConfirm={onCropConfirm} onCancel={() => setCropOpen(false)} />
    </div>
  );
}
