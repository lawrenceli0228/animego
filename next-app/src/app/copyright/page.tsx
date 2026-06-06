import type { Metadata } from "next";
import LegalDoc, { legalStyles as x } from "@/components/legal/LegalDoc";
import { getLang } from "@/lib/i18n";

export const revalidate = 3600;

const CONTACT = "copyright@animegoclub.com";
const UPDATED = "2026年6月5日";

export async function generateMetadata(): Promise<Metadata> {
  const lang = await getLang();
  const title = lang === "zh" ? "版权与侵权处理" : "Copyright & Takedown";
  const description =
    lang === "zh"
      ? "AnimeGoClub 版权声明与侵权通知（takedown）流程：本站不托管影音文件，权利人如何提交移除请求。"
      : "AnimeGoClub copyright notice and takedown process. We host no media files; how rights holders submit removal requests.";
  return {
    title,
    description,
    alternates: { canonical: "/copyright", languages: { "zh-CN": "/copyright" } },
    openGraph: { title, description, url: "/copyright", type: "website" },
  };
}

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
