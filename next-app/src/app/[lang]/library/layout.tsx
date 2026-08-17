import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import jwt from "jsonwebtoken";
import { localizePath, type Locale } from "@/lib/i18n/locale";
import { resolveLocale } from "@/lib/i18n/route";

/**
 * The sign-in bounce, in the visitor's own locale.
 *
 * Both halves matter. A bare /login drops an English reader into Simplified
 * Chinese at the exact moment they are least able to work out why, and a
 * bare `from` would do it again after they successfully sign in.
 */
function loginHref(locale: Locale): string {
  return `${localizePath("/login", locale)}?from=${encodeURIComponent(localizePath("/library", locale))}`;
}

// Server-side auth gate. proxy.ts (matcher: /library/:path*) already
// catches unauthenticated traffic at the request edge with a redirect
// to /login?from=... — this layout re-runs the same check as a
// belt-and-suspenders guard so a proxy.ts matcher misconfig can't
// silently expose the Library shell.
//
// /admin gets a role check here too; /library doesn't — any valid
// session can use the local library (no admin requirement).
async function requireSession(locale: Locale): Promise<{ username: string }> {
  const jar = await cookies();
  const token = jar.get("session")?.value;
  if (!token) redirect(loginHref(locale));
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("Server misconfiguration: JWT_SECRET missing");
  }
  try {
    const decoded = jwt.verify(token, secret) as {
      username?: string;
    };
    return { username: decoded.username ?? "user" };
  } catch {
    redirect(loginHref(locale));
  }
}

export async function generateMetadata({ params }: LayoutProps<"/[lang]/library">): Promise<Metadata> {
  const { dict } = await resolveLocale(params);
  return {
    title: dict.library.pageTitle,
    robots: { index: false, follow: false },
  };
}

export default async function LibraryLayout({ children, params }: LayoutProps<"/[lang]/library">) {
  const { locale } = await resolveLocale(params);
  await requireSession(locale);
  return <>{children}</>;
}
