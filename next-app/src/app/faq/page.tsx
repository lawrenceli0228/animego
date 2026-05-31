import type { Metadata } from "next";
import FaqSection from "@/components/landing/FaqSection";
import { getDict, getLang } from "@/lib/i18n";
import type { CSSProperties } from "react";

// FAQ is static content — revalidate every hour so any future dict
// changes land quickly without requiring a deploy.
export const revalidate = 3600;

export async function generateMetadata(): Promise<Metadata> {
  const lang = await getLang();
  const title =
    lang === "zh"
      ? "常见问题 — AnimeGo"
      : "Frequently Asked Questions — AnimeGo";
  const description =
    lang === "zh"
      ? "关于 AnimeGoClub 是否免费、与 Bangumi/AniList/MAL 的区别、弹幕来源、OVA/ONA/剧场版的差异等。"
      : "About AnimeGoClub: is it free, how it differs from Bangumi/AniList/MAL, danmaku sources, OVA/ONA/movie differences.";
  return {
    title,
    description,
    alternates: {
      canonical: "/faq",
      languages: {
        "zh-CN": "/faq",
        "en-US": "/faq?lang=en",
      },
    },
    openGraph: {
      title,
      description,
      url: "/faq",
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
    },
  };
}

const headerWrapStyle: CSSProperties = {
  paddingTop: 40,
  paddingBottom: 0,
};

const h1Style: CSSProperties = {
  fontSize: "clamp(22px,3vw,34px)",
  color: "#ffffff",
  marginBottom: 12,
};

const subStyle: CSSProperties = {
  color: "rgba(235,235,245,0.60)",
  fontSize: 15,
  lineHeight: 1.6,
  maxWidth: 640,
};

export default async function FaqPage() {
  const [dict, lang] = await Promise.all([getDict(), getLang()]);

  // FAQPage structured data, built from the SAME dict.landing.faq Q&A that
  // FaqSection renders visibly below — Google requires the JSON-LD FAQ to
  // match on-page content. Powers the SERP expandable-Q&A rich result and
  // the Search Console "常见问题解答" enhancement report.
  const faqStrings = dict.landing.faq as unknown as Record<string, string>;
  const faqJsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: ["1", "2", "3", "4", "5"]
      .map((n) => ({ q: faqStrings[`q${n}`], a: faqStrings[`a${n}`] }))
      .filter((x) => x.q && x.a)
      .map((x) => ({
        "@type": "Question",
        name: x.q,
        acceptedAnswer: { "@type": "Answer", text: x.a },
      })),
  };

  const heading =
    lang === "zh" ? "AnimeGoClub 常见问题" : "Frequently Asked Questions";
  const sub =
    lang === "zh"
      ? "关于 AnimeGoClub 是否免费、与 Bangumi/AniList/MAL 的区别、弹幕来源、OVA/ONA/剧场版的差异等。"
      : "About AnimeGoClub: is it free, how it differs from Bangumi/AniList/MAL, danmaku sources, OVA/ONA/movie differences.";

  return (
    <main>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />
      <div className="container" style={headerWrapStyle}>
        <h1 style={h1Style}>{heading}</h1>
        <p style={subStyle}>{sub}</p>
      </div>
      {/* FaqSection owns the details/summary accordion with hover states,
          [OPEN]/[CLOSE] markers, and chartreuse hue-bar indicators. */}
      <FaqSection dict={dict} />
    </main>
  );
}
