import type { Metadata } from "next";
import { resolveLocale } from "@/lib/i18n/route";

// Bare /player is intentionally public: its drop-zone mode reads local files
// and calls only public dandanplay endpoints. Library hand-offs carry
// ?seriesId=... and remain auth-gated in proxy.ts.

export async function generateMetadata({ params }: LayoutProps<"/[lang]/player">): Promise<Metadata> {
  const { dict } = await resolveLocale(params);
  return {
    title: dict.player.pageTitle,
    robots: { index: false, follow: false },
  };
}

export default function PlayerLayout({ children }: LayoutProps<"/[lang]/player">) {
  return <>{children}</>;
}
