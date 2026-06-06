import type { Metadata } from "next";
import Link from "next/link";
import LegalDoc, { legalStyles as x } from "@/components/legal/LegalDoc";
import { getLang } from "@/lib/i18n";

export const revalidate = 3600;

const CONTACT = "copyright@animegoclub.com";
const UPDATED = "2026年6月5日";

export async function generateMetadata(): Promise<Metadata> {
  const lang = await getLang();
  const title = lang === "zh" ? "服务条款" : "Terms of Service";
  const description =
    lang === "zh"
      ? "AnimeGoClub 服务条款：账号、用户内容、可接受使用、第三方内容与链接、免责与责任限制。"
      : "AnimeGoClub Terms of Service: accounts, user content, acceptable use, third-party links, disclaimers.";
  return {
    title,
    description,
    alternates: { canonical: "/terms", languages: { "zh-CN": "/terms" } },
    openGraph: { title, description, url: "/terms", type: "website" },
  };
}

export default function TermsPage() {
  return (
    <LegalDoc title="服务条款" updated={`最后更新：${UPDATED}`}>
      <p style={x.p}>
        欢迎使用 AnimeGoClub（“本站”）。访问或使用本站，即表示你同意本服务条款。
        若你不同意，请勿使用本站。
      </p>

      <h2 style={x.h2}>一、服务说明</h2>
      <p style={x.p}>
        本站是一个动漫资料、发现、追番管理与弹幕播放工具，提供番剧元数据浏览、
        每季新番、评分、声优、评论、弹幕与个人追番管理等功能。
      </p>

      <h2 style={x.h2}>二、账号</h2>
      <ul style={x.ul}>
        <li style={x.li}>你需提供真实、准确的注册信息，并对账号下的所有活动负责。</li>
        <li style={x.li}>请妥善保管你的登录凭证；如发现未经授权的使用，请及时联系我们。</li>
      </ul>

      <h2 style={x.h2}>三、用户内容</h2>
      <ul style={x.ul}>
        <li style={x.li}>
          你对自己发布的内容（评论、弹幕等）负责，并保留其权利；
          你授予本站为提供服务而展示该内容的非独占许可。
        </li>
        <li style={x.li}>
          禁止发布违法、侵权、辱骂、垃圾或其他不当内容；我们有权在不另行通知的情况下移除。
        </li>
      </ul>

      <h2 style={x.h2}>四、可接受使用</h2>
      <p style={x.p}>
        你同意不滥用本站，包括但不限于：自动化抓取、攻击或干扰服务、规避访问限制、
        以及任何违反适用法律的行为。
      </p>

      <h2 style={x.h2}>五、第三方内容与链接</h2>
      <ul style={x.ul}>
        <li style={x.li}>
          <strong style={x.strong}>本站不存储、不托管任何影音文件。</strong>
        </li>
        <li style={x.li}>
          番剧元数据来自 AniList、Bangumi 等公开来源；站内出现的部分外部链接由第三方公开来源或用户提供，本站仅作信息索引。
        </li>
        <li style={x.li}>
          我们不控制亦不对第三方内容的合法性、准确性或可用性负责。版权相关事宜见{" "}
          <Link style={x.a} href="/copyright">版权与侵权处理</Link>。
        </li>
      </ul>

      <h2 style={x.h2}>六、知识产权</h2>
      <p style={x.p}>
        本站的界面设计、代码与原创内容的知识产权归本站所有，未经许可不得复制或商业使用。
      </p>

      <h2 style={x.h2}>七、免责声明</h2>
      <p style={x.p}>
        本站按“现状”与“现有”提供，不作任何明示或默示的担保（包括适销性、特定用途适用性等）。
        你使用本站的风险由你自行承担。
      </p>

      <h2 style={x.h2}>八、责任限制</h2>
      <p style={x.p}>
        在适用法律允许的最大范围内，本站不对因使用或无法使用本站而产生的任何间接、附带或后果性损失负责。
      </p>

      <h2 style={x.h2}>九、终止</h2>
      <p style={x.p}>对违反本条款的账号，我们可在适当情况下暂停或终止其使用。</p>

      <h2 style={x.h2}>十、条款变更</h2>
      <p style={x.p}>我们可能不时更新本条款，变更将于本页公布并更新“最后更新”日期。</p>

      <h2 style={x.h2}>十一、联系</h2>
      <p style={x.p}>
        如有疑问请联系{" "}
        <a style={x.a} href={`mailto:${CONTACT}`}>{CONTACT}</a>。
      </p>
    </LegalDoc>
  );
}
