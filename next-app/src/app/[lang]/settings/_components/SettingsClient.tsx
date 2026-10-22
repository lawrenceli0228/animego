"use client";

import { useCallback, useState } from "react";
import { useLang } from "@/lib/lang-client";
import MemberPass from "@/components/profile/MemberPass";
import PhotoCropModal from "@/components/profile/PhotoCropModal";
import { memberNo as makeMemberNo } from "@/components/profile/memberIdentity";
import type { BackdropOption } from "@/components/profile/backdropTypes";
import FallbackImg from "@/components/ui/FallbackImg";
import { DEFAULT_AVATAR_IMAGE, DEFAULT_BACKDROP_IMAGE } from "@/lib/cardDefaults";
import AccountSection from "./AccountSection";
import DevicesSection from "./DevicesSection";
import PassSection from "./PassSection";
import PlaybackSettings from "./PlaybackSettings";
import PrivacySection from "./PrivacySection";
import SectionNav from "./SectionNav";
import { remainingSessions, type DeviceSession } from "./deviceSessions";
import { SETTINGS_SECTIONS, type SettingsSection } from "./sectionSpy";
import { usePassEditor } from "./usePassEditor";
import { usePhotoCrop } from "./usePhotoCrop";
import { useSectionSpy } from "./useSectionSpy";
import { useUsernameEditor } from "./useUsernameEditor";
import "./settings.css";

/** The identity line's avatar (settings.css .set-me-av). */
const IDENTITY_AVATAR_WIDTH = 48;

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
  email: string;
  /** "SINCE 2026.10" for the pass, worked out on the server so both renders agree. */
  since: string;
  avatarUrl: string | null;
  backdropAnilistId: number | null;
  backdropOptions: BackdropOption[];
  watchedCount: number;
  topSeason: string | null;
  isPublic: boolean;
  sessions: DeviceSession[];
  /** The request's clock: every relative time on the page is measured from it. */
  serverNowMs: number;
}

/**
 * The settings page, option B of the settings canvas: one page, five
 * sections. On a desktop the live member pass and an index sit on the left;
 * on a phone an identity line and a sticky row of chips lead, and the pass
 * moves into its own section.
 */
export default function SettingsClient({
  username,
  usernameHidden,
  userId,
  email,
  since,
  avatarUrl,
  backdropAnilistId,
  backdropOptions,
  watchedCount,
  topSeason,
  isPublic,
  sessions,
  serverNowMs,
}: SettingsClientProps) {
  const { lang, t } = useLang();
  const memberNo = makeMemberNo(userId);
  const account = useUsernameEditor(username, usernameHidden);
  const pass = usePassEditor({ photo: avatarUrl, backdrop: backdropAnilistId });
  const crop = usePhotoCrop(pass.setPhoto);
  const spy = useSectionSpy(SETTINGS_SECTIONS);

  // Sessions signed out from this page. The list itself stays the server's
  // (a refresh brings a new one); this only hides what has been ended since.
  const [signedOut, setSignedOut] = useState<ReadonlySet<string>>(() => new Set());
  const devices = remainingSessions(sessions, signedOut);
  const markSignedOut = useCallback((ids: string[]) => {
    setSignedOut((before) => new Set([...before, ...ids]));
  }, []);

  // The pass face and the profile backdrop both come from the chosen anime —
  // or, before one is chosen, from the first in the list, as before.
  const chosen =
    backdropOptions.find((o) => o.anilistId === pass.edited.backdrop) ?? backdropOptions[0] ?? null;
  const cardArt = chosen?.coverUrl ?? null;
  const banner = chosen?.bannerUrl ?? chosen?.coverUrl ?? DEFAULT_BACKDROP_IMAGE;
  const avatarSrc = pass.edited.photo ?? cardArt ?? DEFAULT_AVATAR_IMAGE;
  const displayName = account.draft.trim() || account.saved;

  // Rendered twice — in the aside on a desktop, in the 通行证 section on a
  // phone; CSS shows one. Both follow the edit as it is made.
  const passCard = (
    <MemberPass
      username={displayName}
      memberNo={memberNo}
      since={since}
      watchedCount={watchedCount}
      topSeason={topSeason}
      artUrl={cardArt}
      photoUrl={pass.edited.photo}
      lang={lang}
    />
  );

  const labels: Record<SettingsSection, string> = {
    pass: t("settings.passTitle"),
    account: t("settings.accountTitle"),
    devices: t("settings.devicesTitle"),
    privacy: t("settings.privacyTitle"),
    playback: t("settings.playbackTitle"),
  };
  const nav = {
    label: t("settings.sectionsAria"),
    labels,
    current: spy.current,
    deviceCount: devices.length,
    onSelect: spy.select,
  };

  return (
    <>
      <div className="set-root">
        <h1 className="set-title">{t("settings.pageTitle")}</h1>
        <div className="set-grid">
          <aside className="set-side">
            {passCard}
            <SectionNav variant="toc" {...nav} />
          </aside>

          <div className="set-main">
            <div className="set-me">
              <FallbackImg
                key={avatarSrc}
                className="set-me-av"
                src={avatarSrc}
                fallback={DEFAULT_AVATAR_IMAGE}
                width={IDENTITY_AVATAR_WIDTH}
              />
              <div className="set-me-text">
                <p className="set-me-name">{displayName}</p>
                <p className="set-me-id">{`#${memberNo}`}</p>
              </div>
            </div>
            <SectionNav variant="chips" {...nav} />

            <PassSection
              passCard={passCard}
              options={backdropOptions.filter((o) => o.bannerUrl)}
              editor={pass}
              name={displayName}
              avatarSrc={avatarSrc}
              previewBanner={banner}
              onPhotoFile={crop.start}
            />
            <AccountSection editor={account} memberNo={memberNo} email={email} />
            <DevicesSection sessions={devices} nowMs={serverNowMs} onSignedOut={markSignedOut} />
            <PrivacySection isPublic={isPublic} />
            <PlaybackSettings />
          </div>
        </div>
      </div>

      {/* Outside .set-root, whose button and focus rules are not the modal's. */}
      <PhotoCropModal open={crop.open} src={crop.src} onConfirm={crop.confirm} onCancel={crop.cancel} />
    </>
  );
}
