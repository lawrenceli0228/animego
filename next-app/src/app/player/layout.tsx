import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import jwt from "jsonwebtoken";

// Player auth gate — proxy.ts already covers /player/:path* (P6.1);
// this layout is the belt-and-suspenders second line of defence.
// Same pattern as /library — any valid session is fine, no role
// requirement. /admin keeps role=admin elsewhere.

async function requireSession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get("session")?.value;
  if (!token) redirect("/login?from=/player");
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("Server misconfiguration: JWT_SECRET missing");
  }
  try {
    jwt.verify(token, secret);
  } catch {
    redirect("/login?from=/player");
  }
}

export const metadata = {
  title: "播放器 — AnimeGo",
  robots: { index: false, follow: false },
};

export default async function PlayerLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireSession();
  return <>{children}</>;
}
