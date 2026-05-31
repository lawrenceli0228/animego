import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import jwt from "jsonwebtoken";
import { getDict } from "@/lib/i18n";

// Server-side auth gate. proxy.ts (matcher: /library/:path*) already
// catches unauthenticated traffic at the request edge with a redirect
// to /login?from=... — this layout re-runs the same check as a
// belt-and-suspenders guard so a proxy.ts matcher misconfig can't
// silently expose the Library shell.
//
// /admin gets a role check here too; /library doesn't — any valid
// session can use the local library (no admin requirement).
async function requireSession(): Promise<{ username: string }> {
  const jar = await cookies();
  const token = jar.get("session")?.value;
  if (!token) redirect("/login?from=/library");
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
    redirect("/login?from=/library");
  }
}

export async function generateMetadata(): Promise<Metadata> {
  const dict = await getDict();
  return {
    title: dict.library.pageTitle,
    robots: { index: false, follow: false },
  };
}

export default async function LibraryLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireSession();
  return <>{children}</>;
}
