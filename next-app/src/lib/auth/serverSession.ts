// Who is signed in, for a dynamic server route: the `session` cookie,
// verified against JWT_SECRET exactly as proxy.ts and the admin layout
// verify it. proxy.ts has already refreshed an expired access token by the
// time a page renders, so a null here is a reader who is signed out.
//
// Reads cookies(): call it only from a route that is dynamic anyway, never
// from an ISR page.

import { cookies } from "next/headers";
import jwt from "jsonwebtoken";

export interface ServerSession {
  userId: string;
  username: string;
  role: string | null;
}

export async function readSession(): Promise<ServerSession | null> {
  const token = (await cookies()).get("session")?.value;
  if (!token) return null;
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("Server misconfiguration: JWT_SECRET missing");
  try {
    const decoded = jwt.verify(token, secret) as { userId?: string; username?: string; role?: string };
    if (!decoded.userId) return null;
    return { userId: decoded.userId, username: decoded.username ?? "", role: decoded.role ?? null };
  } catch {
    return null;
  }
}
