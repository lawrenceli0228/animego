import type { Metadata } from "next";
import LegalDoc, { legalStyles as x } from "@/components/legal/LegalDoc";
import { resolveLocale } from "@/lib/i18n/route";
import { buildAlternatesUntranslated, untranslatedRobots } from "@/lib/seo/alternates";

// Static legal page — hourly revalidate so copy edits land without a deploy.
export const revalidate = 3600;

const CONTACT = "animegoanime@animegoclub.com";
const UPDATED = "2026年8月9日";

export async function generateMetadata({
  params,
}: PageProps<"/[lang]/privacy">): Promise<Metadata> {
  const { locale, dict } = await resolveLocale(params);
  const title = dict.legal.privacyTitle;
  const description = dict.legal.privacyDescription;
  return {
    title,
    description,
    alternates: buildAlternatesUntranslated("/privacy", locale),
    // Body is Simplified-only JSX; the prefixed copies are the same
    // document under a different URL. See untranslatedRobots.
    robots: untranslatedRobots(locale),
    openGraph: { title, description, url: "/privacy", type: "website" },
  };
}

// The body is Chinese-only, deliberately, and takes no `lang`.
//
// The metadata above is now locale-aware, so /en/privacy advertises an English
// title and description. The document itself is NOT translated, and a machine
// translation of it would be worse than none: this text states what we collect
// and what a reader's rights are, and a mistranslated privacy commitment is a
// commitment we did not make. Translating it is a legal review, not a string
// task.
//
// That leaves /en/privacy with an English <head> over a Chinese <body>, which
// is a real (smaller) problem of its own — the honest fix is to keep the three
// legal pages out of the hreflang set entirely so no English URL is advertised
// for them at all. That is a follow-up task; do not "fix" it here by feeding
// `lang` into the body.
export default function PrivacyPage() {
  return (
    <LegalDoc title="隐私政策" updated={`最后更新：${UPDATED}`}>
      <p style={x.p}>
        本政策说明 AnimeGoClub（“本站”）在你使用本站时收集、使用与保护个人信息的方式。
        使用本站即表示你已阅读并理解本政策。
      </p>

      <h2 style={x.h2}>一、我们收集的信息</h2>
      <ul style={x.ul}>
        <li style={x.li}>
          <strong style={x.strong}>账号信息</strong>：注册邮箱、用户名，以及经加密（哈希）存储的密码。
        </li>
        <li style={x.li}>
          <strong style={x.strong}>使用数据</strong>：你的追番列表、观看进度、评分、收藏等与账号关联的数据。
        </li>
        <li style={x.li}>
          <strong style={x.strong}>你发布的内容</strong>：评论、弹幕等由你主动提交的内容。
        </li>
        <li style={x.li}>
          <strong style={x.strong}>个性化数据</strong>：头像、主页背景等资料设置。
        </li>
        <li style={x.li}>
          <strong style={x.strong}>技术数据</strong>：登录会话、IP 地址、设备与浏览器信息、访问日志，用于安全与故障排查。
        </li>
      </ul>

      <h2 style={x.h2}>二、Cookie 与本地存储</h2>
      <p style={x.p}>
        为维持登录状态、记住界面偏好（如语言），以及支持你主动使用的本地功能，
        本站会在你的浏览器中存储少量必要数据。这些数据仅用于上述目的。
      </p>
      <p style={x.p}>
        我们<strong style={x.strong}>不使用任何第三方广告 Cookie，也不进行跨站追踪</strong>。
      </p>
      <p style={x.p}>
        你可以随时通过浏览器设置清除这些数据。清除后，你需要重新登录，
        本地功能中未上传的内容也会一并移除。
      </p>

      <h2 style={x.h2}>三、我们如何使用信息</h2>
      <ul style={x.ul}>
        <li style={x.li}>提供并维持核心功能（登录、追番、评分、评论、弹幕、播放等）。</li>
        <li style={x.li}>保障账号与服务安全、防止滥用。</li>
        <li style={x.li}>改进产品体验与排查问题。</li>
      </ul>
      <p style={x.p}>我们不出售你的个人信息。</p>

      <h2 style={x.h2}>四、第三方服务与数据来源</h2>
      <p style={x.p}>
        为保障服务的稳定、安全与可用，我们委托少量第三方服务商提供内容分发、安全防护与故障诊断等支持。
        它们在为本站提供服务的过程中可能接触到必要的技术信息，且仅可按约定用途处理。
        我们不会为此向其提供超出必要范围的数据，也不会将你的个人信息用于任何广告用途。
      </p>
      <ul style={x.ul}>
        <li style={x.li}>
          番剧元数据（标题、封面、简介、评分、声优等）来自{" "}
          <a style={x.a} href="https://anilist.co" target="_blank" rel="noreferrer">AniList</a>、{" "}
          <a style={x.a} href="https://bgm.tv" target="_blank" rel="noreferrer">Bangumi</a> 等公开来源；
          我们向其请求公开数据，<strong style={x.strong}>不向其发送你的个人信息</strong>。
        </li>
      </ul>

      <h2 style={x.h2}>五、数据保留与安全</h2>
      <p style={x.p}>
        我们在你的账号存续期间保留相关数据，并采取合理的技术与管理措施加以保护。
        但请注意，互联网传输与存储不存在绝对安全。
      </p>

      <h2 style={x.h2}>六、你的权利</h2>
      <ul style={x.ul}>
        <li style={x.li}>在“设置”中查看与更新你的资料。</li>
        <li style={x.li}>
          如需删除账号及相关数据，可通过 <a style={x.a} href={`mailto:${CONTACT}`}>{CONTACT}</a> 联系我们。
        </li>
      </ul>

      <h2 style={x.h2}>七、未成年人</h2>
      <p style={x.p}>本站不面向低龄未成年人提供服务；若你为未成年人，请在监护人指导下使用。</p>

      <h2 style={x.h2}>八、政策变更</h2>
      <p style={x.p}>我们可能不时更新本政策，重大变更将于本页公布并更新“最后更新”日期。</p>

      <h2 style={x.h2}>九、联系我们</h2>
      <p style={x.p}>
        如对本政策有任何疑问，请联系 <a style={x.a} href={`mailto:${CONTACT}`}>{CONTACT}</a>。
      </p>
    </LegalDoc>
  );
}
