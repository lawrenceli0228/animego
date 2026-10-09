"use client";

// A person on the community tab: their own picture when they set one (or the
// backdrop cover they chose, as the comments panel does), else the canvas's
// initial in a circle. A picture that fails to load falls back to the initial
// rather than to a broken-image glyph.

import { useState } from "react";
import s from "./community.module.css";
import { anilistImgProps } from "@/lib/images/anilistImg";

interface AvatarProps {
  name: string;
  avatarUrl?: string | null;
  backdropCoverUrl?: string | null;
  small?: boolean;
}

export function initialOf(name: string): string {
  return Array.from(name.trim())[0] ?? "?";
}

export default function Avatar({ name, avatarUrl, backdropCoverUrl, small = false }: AvatarProps) {
  const [failed, setFailed] = useState(false);
  const src = avatarUrl || backdropCoverUrl || null;
  return (
    <span className={small ? s.avatarSm : s.avatar} aria-hidden="true">
      {src && !failed ? (
        // A user-supplied URL from any host: next/image would need every one
        // of them allow-listed, and these are 36px.
        // eslint-disable-next-line @next/next/no-img-element
        <img {...anilistImgProps(src, 36, 36)} alt="" loading="lazy" onError={() => setFailed(true)} />
      ) : (
        initialOf(name)
      )}
    </span>
  );
}
