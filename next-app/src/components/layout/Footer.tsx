import Link from "next/link";
import type { CSSProperties } from "react";
import type { Dict } from "@/lib/i18n";

interface FooterProps {
  dict: Dict;
  /**
   * Same season/year the navbar uses, so the "Seasonal" footer link goes
   * to the live route instead of the legacy params-less /season.
   */
  season: string;
  year: number;
}

const s = {
  footer: {
    borderTop: "1px solid rgba(84,84,88,0.65)",
    background: "#000",
    padding: "48px 24px 32px",
  } as CSSProperties,
  inner: {
    maxWidth: 1400,
    margin: "0 auto",
  } as CSSProperties,
  columns: {
    display: "grid",
    gridTemplateColumns: "repeat(4, 1fr)",
    gap: 32,
  } as CSSProperties,
  colTitle: {
    fontFamily: "'Sora', sans-serif",
    fontSize: 14,
    fontWeight: 600,
    color: "#fff",
    marginBottom: 16,
    letterSpacing: "-0.02em",
  } as CSSProperties,
  siteDesc: {
    fontSize: 13,
    color: "rgba(235,235,245,0.30)",
    lineHeight: 1.5,
    marginBottom: 16,
    maxWidth: 220,
  } as CSSProperties,
  linkList: {
    listStyle: "none",
    padding: 0,
    margin: 0,
    display: "flex",
    flexDirection: "column",
    gap: 10,
  } as CSSProperties,
  link: {
    fontSize: 13,
    fontWeight: 400,
    color: "rgba(235,235,245,0.60)",
    textDecoration: "none",
    transition: "color 150ms ease-out",
  } as CSSProperties,
  bottom: {
    marginTop: 40,
    paddingTop: 24,
    borderTop: "1px solid rgba(84,84,88,0.35)",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    flexWrap: "wrap" as const,
    gap: 12,
  } as CSSProperties,
  copyright: {
    fontSize: 12,
    color: "rgba(235,235,245,0.30)",
    fontFamily: "'DM Sans', sans-serif",
  } as CSSProperties,
  credits: {
    fontSize: 12,
    color: "rgba(235,235,245,0.30)",
    fontFamily: "'DM Sans', sans-serif",
    display: "flex",
    alignItems: "center",
    gap: 6,
  } as CSSProperties,
  creditLink: {
    color: "rgba(235,235,245,0.60)",
    textDecoration: "none",
  } as CSSProperties,
  dot: {
    color: "rgba(235,235,245,0.18)",
  } as CSSProperties,
};

export default function Footer({ dict, season, year }: FooterProps) {
  const seasonHref = `/seasonal/${season.toLowerCase()}/${year}`;
  const yearStr = String(new Date().getFullYear());

  const browseLinks: Array<{ to?: string; href?: string; label: string }> = [
    { to: seasonHref, label: dict.footer.seasonal },
    { to: "/", label: dict.footer.trending },
    { to: "/search", label: dict.footer.search },
    { href: "#", label: dict.footer.topRated },
    { href: "#", label: dict.footer.upcoming },
  ];

  const socialLinks: Array<{ href: string; label: string }> = [
    { href: "https://github.com/lawrenceli0228/animego", label: dict.footer.github },
    { href: "#", label: dict.footer.twitter },
    { href: "#", label: dict.footer.discord },
    { href: "#", label: dict.footer.telegram },
  ];

  const supportLinks: Array<{ label: string }> = [
    { label: dict.footer.faq },
    { label: dict.footer.contact },
    { label: dict.footer.feedback },
    { label: dict.footer.api },
    { label: dict.footer.terms },
    { label: dict.footer.privacy },
  ];

  return (
    <footer style={s.footer}>
      <div style={s.inner}>
        <div style={s.columns}>
          <div>
            <div style={s.colTitle}>{dict.footer.siteCol}</div>
            <p style={s.siteDesc}>{dict.footer.siteDesc}</p>
            <ul style={s.linkList}>
              <li>
                <Link href="/welcome" prefetch={false} style={s.link}>
                  {dict.nav.about}
                </Link>
              </li>
              <li><a href="#" style={s.link}>{dict.footer.donate}</a></li>
              <li><a href="#" style={s.link}>{dict.footer.apps}</a></li>
              <li><a href="#" style={s.link}>{dict.footer.siteStats}</a></li>
              <li><a href="#" style={s.link}>{dict.footer.recommendations}</a></li>
            </ul>
          </div>

          <div>
            <div style={s.colTitle}>{dict.footer.browseCol}</div>
            <ul style={s.linkList}>
              {browseLinks.map((l) => (
                <li key={l.label}>
                  {l.to ? (
                    <Link href={l.to} prefetch={false} style={s.link}>{l.label}</Link>
                  ) : (
                    <a href={l.href ?? "#"} style={s.link}>{l.label}</a>
                  )}
                </li>
              ))}
            </ul>
          </div>

          <div>
            <div style={s.colTitle}>{dict.footer.socialCol}</div>
            <ul style={s.linkList}>
              {socialLinks.map((l) => (
                <li key={l.label}>
                  <a
                    href={l.href}
                    target="_blank"
                    rel="noreferrer"
                    style={s.link}
                  >
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <div style={s.colTitle}>{dict.footer.supportCol}</div>
            <ul style={s.linkList}>
              {supportLinks.map((l) => (
                <li key={l.label}>
                  <a href="#" style={s.link}>{l.label}</a>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div style={s.bottom}>
          <span style={s.copyright}>
            {dict.footer.copyright.replace("{year}", yearStr)}
          </span>
          <span style={s.credits}>
            {dict.footer.dataCredits}
            <a
              href="https://anilist.co"
              target="_blank"
              rel="noreferrer"
              style={s.creditLink}
            >
              AniList
            </a>
            <span style={s.dot}>·</span>
            <a
              href="https://bgm.tv"
              target="_blank"
              rel="noreferrer"
              style={s.creditLink}
            >
              Bangumi
            </a>
          </span>
        </div>
      </div>
    </footer>
  );
}
