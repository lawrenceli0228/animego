import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import jwt from "jsonwebtoken";
import { localizePath, type Locale } from "@/lib/i18n/locale";
import { resolveLocale } from "@/lib/i18n/route";

// Player auth gate — proxy.ts already covers /player/:path* (P6.1);
// this layout is the belt-and-suspenders second line of defence.
// Same pattern as /library — any valid session is fine, no role
// requirement. /admin keeps role=admin elsewhere.

/**
 * The sign-in bounce, in the visitor's own locale.
 *
 * Both halves matter. A bare /login drops an English reader into Simplified
 * Chinese at the exact moment they are least able to work out why, and a
 * bare `from` would do it again after they successfully sign in.
 */
function loginHref(locale: Locale): string {
  return `${localizePath("/login", locale)}?from=${encodeURIComponent(localizePath("/player", locale))}`;
}

async function requireSession(locale: Locale): Promise<void> {
  const jar = await cookies();
  const token = jar.get("session")?.value;
  if (!token) redirect(loginHref(locale));
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("Server misconfiguration: JWT_SECRET missing");
  }
  try {
    jwt.verify(token, secret);
  } catch {
    redirect(loginHref(locale));
  }
}

export async function generateMetadata({ params }: LayoutProps<"/[lang]/player">): Promise<Metadata> {
  const { dict } = await resolveLocale(params);
  return {
    title: dict.player.pageTitle,
    robots: { index: false, follow: false },
  };
}

export default async function PlayerLayout({ children, params }: LayoutProps<"/[lang]/player">) {
  const { locale } = await resolveLocale(params);
  await requireSession(locale);
  return <>{children}</>;
}
