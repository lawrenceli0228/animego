import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { BackdropOption } from "@/components/profile/backdropTypes";
import type { Lang } from "@/lib/i18n/lang";
import { LanguageProvider } from "@/lib/lang-client";
import DeviceTile from "./DeviceTile";
import PassSection from "./PassSection";
import SectionNav from "./SectionNav";
import SettingSwitch from "./SettingSwitch";
import type { DeviceSession } from "./deviceSessions";
import type { PassEditor } from "./settingsState";

// renderToStaticMarkup, as the other *.render.test.tsx files do: what is
// pinned here is what assistive tech and the server render get — the marks
// (aria-current, aria-pressed, role="switch"), the names buttons are read
// with, and which controls exist in which state. Behaviour that needs a
// browser (scroll-spy, focus moves, the confirm) is driven by
// e2e/specs/sandbox/settings-devices.spec.ts.

function render(node: ReactNode, lang: Lang = "zh"): string {
  return renderToStaticMarkup(<LanguageProvider lang={lang}>{node}</LanguageProvider>);
}

const noop = () => {};

describe("SectionNav", () => {
  const labels = { pass: "通行证", account: "账号与安全", devices: "登录设备", privacy: "隐私与社区", playback: "播放" };
  const nav = (variant: "toc" | "chips", deviceCount = 6) =>
    render(
      <SectionNav
        variant={variant}
        label="设置分区"
        labels={labels}
        current="devices"
        deviceCount={deviceCount}
        onSelect={noop}
      />,
    );

  test("links every section by its #anchor, in page order", () => {
    const hrefs = [...nav("toc").matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual(["#pass", "#account", "#devices", "#privacy", "#playback"]);
  });

  test("marks only the current section, and is a labelled nav", () => {
    const html = nav("toc");
    expect(html).toContain('<nav class="set-toc" aria-label="设置分区">');
    expect(html.match(/aria-current="true"/g)).toHaveLength(1);
    expect(html).toMatch(/href="#devices" aria-current="true">登录设备/);
  });

  test("counts the devices beside 登录设备", () => {
    expect(nav("toc")).toContain('<span class="set-toc-count">6</span>');
    expect(nav("chips")).toContain(">登录设备 6</a>");
  });

  test("leaves the count off when there is nothing to count", () => {
    expect(nav("toc", 0)).not.toContain("set-toc-count");
    expect(nav("chips", 0)).toContain(">登录设备</a>");
  });
});

describe("SettingSwitch", () => {
  test("is a labelled, described checkbox with role=switch", () => {
    const html = render(
      <SettingSwitch id="set-x" title="公开我的社区主页" description="任何人都可以查看" checked onChange={noop} />,
    );
    expect(html).toMatch(/<input type="checkbox" role="switch" aria-labelledby="set-x-title" aria-describedby="set-x-desc" checked=""/);
    expect(html).toContain('id="set-x-title">公开我的社区主页</p>');
    expect(html).toContain('id="set-x-desc">任何人都可以查看</p>');
    expect(html).toContain('<i aria-hidden="true">');
  });

  test("reflects off", () => {
    const html = render(<SettingSwitch id="set-x" title="t" description="d" checked={false} onChange={noop} />);
    expect(html).not.toContain('checked=""');
  });
});

describe("DeviceTile", () => {
  const NOW = Date.parse("2026-10-22T10:30:00Z");
  const base: DeviceSession = {
    id: "s1",
    current: false,
    kind: "phone",
    os: "iPhone",
    browser: "Safari",
    place: "上海",
    lastUsedAt: new Date(NOW - 2 * 3_600_000).toISOString(),
    createdAt: "2026-10-21T15:09:00Z",
  };
  const tile = (session: DeviceSession, lang: Lang = "zh") =>
    render(<DeviceTile session={session} nowMs={NOW} onEnd={noop} />, lang);

  test("another device: a 退出 named after it, its place and time, its sign-in day", () => {
    const html = tile(base);
    expect(html).toContain('aria-label="退出 iPhone · Safari">退出</button>');
    expect(html).toContain("<span>iPhone · Safari</span>");
    expect(html).toContain("上海 · <span>2 小时前</span>");
    expect(html).toContain('<p class="set-dv-since">10月21日登录</p>');
    expect(html).not.toContain("本机");
  });

  test("this device: marked 本机, in use, and nothing to press", () => {
    const html = tile({ ...base, current: true, kind: "laptop", os: "Mac", browser: "Chrome" });
    expect(html).toContain('<li class="set-dv set-dv-cur">');
    expect(html).toContain('<span class="set-dv-tag">本机</span>');
    expect(html).toContain('<span class="set-dv-live">正在使用</span>');
    expect(html).not.toContain("<button");
  });

  test("an unidentified device with no place: no stray separator", () => {
    const html = tile({ ...base, os: "", browser: "", place: "", kind: "unknown" });
    expect(html).toContain("<span>未知设备</span>");
    expect(html).toContain('<p class="set-dv-meta"><span>2 小时前</span></p>');
  });

  test("speaks English on /en", () => {
    const html = tile({ ...base, browser: "WeChat", os: "Android", place: "Japan" }, "en");
    expect(html).toContain('aria-label="Sign out Android · WeChat">Sign out</button>');
    expect(html).toContain("Japan · <span>2h ago</span>");
    expect(html).toContain("Signed in Oct 21");
  });
});

describe("PassSection", () => {
  const options: BackdropOption[] = Array.from({ length: 12 }, (_, i) => ({
    anilistId: 100 + i,
    title: `番剧 ${i}`,
    coverUrl: `/covers/${i}.jpg`,
    bannerUrl: `/banners/${i}.jpg`,
  }));
  const editor = (over: Partial<PassEditor> = {}): PassEditor => ({
    edited: { photo: null, backdrop: 101 },
    dirty: false,
    setPhoto: noop,
    setBackdrop: noop,
    revert: noop,
    save: async () => true,
    ...over,
  });
  const section = (ed: PassEditor, opts = options) =>
    render(
      <PassSection
        passCard={<div className="card-stub" />}
        options={opts}
        editor={ed}
        name="shironeko"
        avatarSrc="/avatar.jpg"
        previewBanner="/banners/1.jpg"
        onPhotoFile={noop}
      />,
    );

  test("offers the first nine tiles, then 显示全部 with the full count", () => {
    const html = section(editor());
    expect(html.match(/class="set-bk"/g)).toHaveLength(9);
    expect(html).toContain("显示全部 12 部");
  });

  test("marks the chosen tile pressed, and only that one, with a check", () => {
    const html = section(editor());
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(8);
    expect(html).toMatch(/aria-pressed="true" aria-label="用《番剧 1》做主页背景和卡面"/);
    expect(html.match(/class="set-bk-ck"/g)).toHaveLength(1);
  });

  test("the tiles are a group named by 主页背景", () => {
    const html = section(editor());
    const labelId = html.match(/<span class="set-label" id="([^"]+)">主页背景<\/span>/)?.[1];
    expect(labelId).toBeTruthy();
    expect(html).toContain(`role="group" aria-labelledby="${labelId}"`);
  });

  test("opens on the whole list when the chosen tile is past the first nine", () => {
    const html = section(editor({ edited: { photo: null, backdrop: 110 } }));
    expect(html.match(/class="set-bk"/g)).toHaveLength(12);
    expect(html).not.toContain("显示全部");
  });

  test("the save bar is there only while the pass has changes", () => {
    expect(section(editor())).not.toContain("set-savebar");
    const dirty = section(editor({ dirty: true }));
    expect(dirty).toContain("通行证有改动");
    expect(dirty).toContain(">还原</button>");
    expect(dirty).toContain(">保存</button>");
  });

  test("移除照片 only when there is a photo to remove", () => {
    expect(section(editor())).not.toContain("移除照片");
    expect(section(editor({ edited: { photo: "data:image/jpeg;base64,AA", backdrop: 101 } }))).toContain("移除照片");
  });

  test("with no banners to offer, says so instead of an empty grid", () => {
    const html = section(editor(), []);
    expect(html).toContain("列表里还没有带宽幅 banner 的番剧");
    expect(html).not.toContain('role="group"');
  });

  test("the profile preview is hidden from assistive tech", () => {
    expect(section(editor())).toContain('<div class="set-prev" aria-hidden="true">');
  });
});
