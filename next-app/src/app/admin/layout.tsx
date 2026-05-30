import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import jwt from "jsonwebtoken";
import { getDict } from "@/lib/i18n";

// Belt-and-suspenders role re-check. `proxy.ts` already guards
// /admin/:path*, but proxy matcher misconfigurations are an easy way to
// silently lose coverage (Server Actions invoked from /admin pages
// travel as POSTs to the page route — a matcher refactor that excluded
// /admin even by accident would leak data). This layout runs on every
// request that reaches it, so it's a hard backstop.
async function requireAdmin(): Promise<{ username: string }> {
  const jar = await cookies();
  const token = jar.get("session")?.value;
  if (!token) redirect("/login?from=/admin");
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("Server misconfiguration: JWT_SECRET missing");
  }
  try {
    const decoded = jwt.verify(token, secret) as {
      role?: string;
      username?: string;
    };
    if (decoded.role !== "admin") redirect("/login?from=/admin");
    return { username: decoded.username ?? "admin" };
  } catch {
    redirect("/login?from=/admin");
  }
}

export async function generateMetadata(): Promise<Metadata> {
  const dict = await getDict();
  return {
    title: dict.admin.pageTitle,
    robots: { index: false, follow: false },
  };
}

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [{ username }, dict] = await Promise.all([requireAdmin(), getDict()]);

  return (
    <div style={styles.shell}>
      <header style={styles.header}>
        <div style={styles.headerInner}>
          <h1 style={styles.title}>{dict.admin.title}</h1>
          {/* Monolithic single-page admin — anchor scrolls instead of
              Link navigations. Three sections live on /admin: #overview
              (stats grid + EnrichmentBar), #enrichment (data review
              table), #users (CRUD). */}
          <nav style={styles.nav} aria-label="Admin navigation">
            <a href="#overview" style={styles.navLink}>
              {dict.admin.navOverview}
            </a>
            <a href="#enrichment" style={styles.navLink}>
              {dict.admin.navEnrichment}
            </a>
            <a href="#users" style={styles.navLink}>
              {dict.admin.navUsers}
            </a>
          </nav>
          <div style={styles.userBadge}>
            <span style={styles.userLabel}>Hi,</span>{" "}
            <strong>{username}</strong>
          </div>
        </div>
      </header>
      <main style={styles.main}>{children}</main>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  shell: {
    minHeight: "100vh",
    background: "#0b0b10",
    color: "#e7e7ef",
    fontFamily:
      "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif",
  },
  header: {
    borderBottom: "1px solid #1f1f2a",
    background: "#111118",
    position: "sticky",
    top: 0,
    zIndex: 10,
  },
  headerInner: {
    maxWidth: 1200,
    margin: "0 auto",
    padding: "16px 24px",
    display: "flex",
    alignItems: "center",
    gap: 32,
  },
  title: {
    fontSize: 18,
    fontWeight: 600,
    margin: 0,
  },
  nav: {
    display: "flex",
    gap: 18,
    flex: 1,
  },
  navLink: {
    color: "#a8a8b8",
    textDecoration: "none",
    fontSize: 14,
    padding: "6px 0",
  },
  userBadge: {
    fontSize: 13,
    color: "#a8a8b8",
  },
  userLabel: {
    opacity: 0.7,
  },
  main: {
    maxWidth: 1200,
    margin: "0 auto",
    padding: "24px",
  },
};
