import type { Metadata } from "next";
import LegalDoc, { legalStyles as x } from "@/components/legal/LegalDoc";
import { resolveLocale } from "@/lib/i18n/route";
import { buildAlternatesUntranslated, untranslatedRobots } from "@/lib/seo/alternates";

export const revalidate = 3600;

const CONTACT = "animegoanime@animegoclub.com";
const UPDATED = "2026年8月9日";

export async function generateMetadata({
  params,
}: PageProps<"/[lang]/copyright">): Promise<Metadata> {
  const { locale, dict } = await resolveLocale(params);
  const title = dict.legal.copyrightTitle;
  const description = dict.legal.copyrightDescription;
  return {
    title,
    description,
    alternates: buildAlternatesUntranslated("/copyright", locale),
    // Body is Simplified-only JSX; the prefixed copies are the same
    // document under a different URL. See untranslatedRobots.
    robots: untranslatedRobots(locale),
    openGraph: { title, description, url: "/copyright", type: "website" },
  };
}

// Chinese-only body, deliberately — see the note in ../privacy/page.tsx. This
// one is the takedown procedure: it tells a rights holder exactly what a valid
// notice must contain, and a translated variant that drifts from it would
// invite notices we then fail to act on correctly. Metadata is locale-aware,
// the document is not; keeping the legal pages out of the hreflang set is the
// follow-up that resolves the mismatch.
export default function CopyrightPage() {
  return (
    <LegalDoc title="版权与侵权处理" updated={`最后更新：${UPDATED}`}>
      <p style={x.p}>我们尊重知识产权，并致力于配合权利人妥善处理侵权问题。</p>

      <h2 style={x.h2}>一、关于本站内容</h2>
      <ul style={x.ul}>
        <li style={x.li}>
          <strong style={x.strong}>本站不存储、不托管任何影音文件。</strong>
        </li>
        <li style={x.li}>
          番剧元数据（标题、封面、简介、评分、声优等）来自 AniList、Bangumi 等公开来源。
        </li>
        <li style={x.li}>
          站内出现的部分外部链接（如磁力链接）指向由第三方公开来源或用户提供的资源；
          本站仅作信息索引，不控制、不上传、亦不保证其内容。
        </li>
      </ul>

      <h2 style={x.h2}>二、侵权通知（Takedown）</h2>
      <p style={x.p}>
        若你是版权人或其授权代理，且善意认为本站上的某项信息侵犯了你的权利，
        请发送邮件至 <a style={x.a} href={`mailto:${CONTACT}`}>{CONTACT}</a>，并提供以下信息：
      </p>
      <ul style={x.ul}>
        <li style={x.li}>权利人或授权代理的姓名、联系方式及授权证明；</li>
        <li style={x.li}>受版权保护作品的说明（足以识别）；</li>
        <li style={x.li}>被指信息在本站的<strong style={x.strong}>具体位置（完整 URL）</strong>；</li>
        <li style={x.li}>你善意相信该使用未获权利人、其代理或法律授权的声明；</li>
        <li style={x.li}>通知内容真实、且你有权代表相关权利人行事的声明。</li>
      </ul>
      <p style={x.p}>
        我们将在收到完整、有效通知后的<strong style={x.strong}>合理时间内（通常 5 个工作日内）</strong>
        进行核查，并移除或禁用相应信息。
      </p>

      <h2 style={x.h2}>三、联系</h2>
      <p style={x.p}>
        版权与侵权相关事宜，请联系 <a style={x.a} href={`mailto:${CONTACT}`}>{CONTACT}</a>。
      </p>
    </LegalDoc>
  );
}
