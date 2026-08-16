// 打开 / 升级 IndexedDB 失败时的错误构造与用户可见文案。
// 纯逻辑 — 无 React、无 DOM、无 IndexedDB,所以可以在 bun test 里直接测。
//
// 为什么单独一个文件:`db.js` 在模块加载时就 `new Dexie(...)`,并且顶部有
// 「服务端导入即抛」的守卫,在 Node 里 import 不进来。CG3 要求给迁移失败配一条
// 失败路径测试,那条测试只能指向这里。
//
// 文案先硬编码中文常量(i18n 由 locales 那条线单独接),不要在这里 import t()。
//
// ⚠️ 下面两条中文串在 `locales/{zh,en}-spa.js` 里各有一份对应文案
//    (`library.dbBlocked` / `library.dbOpenFailed`),真正渲染给用户的是那两份 ——
//    见 `app/library/_components/LibraryDbAlert.tsx`。这里这两条只留作开发者 /
//    Sentry 文本。**故意不去重**:去重意味着把 `t()` 拉进数据层,而这个模块必须能
//    在没有 React、没有浏览器的 `bun test` 里直接 import。
//    改文案时两边一起改。

/**
 * v6 升级被其他标签页持有的旧连接挡住时的提示。
 *
 * 触发机制:`db.js` 在模块加载时就 `getDb('animego-library')`,任何一个
 * `/library` 或 `/player` 标签打开就持有连接。新版本标签发起升级时,旧标签的
 * 连接会让 `indexedDB.open` 停在 `blocked` 上 —— 不报错,只是永远不 resolve。
 * 没有这条提示,用户看到的是「库一直转圈」,像本地库丢了。
 */
export const LIBRARY_DB_BLOCKED_MESSAGE =
  '本地库升级被其他标签页占用：请关闭其他 AnimeGo 标签页后刷新重试。你的文件和记录都还在。';

/**
 * 其余打开失败(配额已满 / Safari 无痕 / 迁移本身抛错)的提示。
 * 关键是先说「没丢」——库打不开时用户的第一反应是数据没了。
 */
export const LIBRARY_DB_OPEN_FAILED_MESSAGE =
  '本地库暂时打不开：请刷新页面重试。你的文件和记录都还在，没有被删除。';

/** 认领 blocked 错误用的内部标记,不给用户看。 */
const BLOCKED_MARKER = '[animego-library:blocked]';

/**
 * @typedef {Object} DbBlockedState
 * @property {boolean}      blocked  - 当前是否卡在 blocked 上
 * @property {string|null}  message  - 给用户看的文案;未卡住时为 null
 */

/**
 * blocked 状态的唯一构造点。UI 直接渲染 `message`,不要自己拼文案 ——
 * 两处拼就会漂,而这条提示是用户唯一能据以行动的东西。
 *
 * @param {boolean} blocked
 * @returns {DbBlockedState}
 */
export function makeDbBlockedState(blocked) {
  return blocked === true
    ? { blocked: true, message: LIBRARY_DB_BLOCKED_MESSAGE }
    : { blocked: false, message: null };
}

/**
 * 构造一条 blocked 错误。消息里同时带内部标记和中文提示:
 * 标记给 `isDbBlockedError` 认,中文给用户看。
 *
 * @param {string} dbName
 * @returns {Error}
 */
export function makeDbBlockedError(dbName) {
  const name = typeof dbName === 'string' && dbName ? dbName : 'animego-library';
  return new Error(
    `${BLOCKED_MARKER} "${name}" — ${LIBRARY_DB_BLOCKED_MESSAGE}`,
  );
}

/**
 * 这条错误是不是「升级被其他标签页挡住」。
 * 输入是不可信的 unknown(catch 到的东西什么都可能是),先收窄再判断。
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isDbBlockedError(err) {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes(BLOCKED_MARKER);
}

/**
 * 把任意打开失败包装成一条开发者可读的消息(保留原始原因,便于 Sentry 归因)。
 * blocked 已经自带完整消息,原样透传,不再套一层前缀。
 *
 * @param {string} dbName
 * @param {unknown} err
 * @returns {string}
 */
export function describeDbOpenFailure(dbName, err) {
  if (isDbBlockedError(err)) {
    return err instanceof Error ? err.message : String(err);
  }
  const reason = err instanceof Error ? err.message : String(err);
  return `[animego-library] Failed to open IndexedDB "${dbName}": ${reason}`;
}

/**
 * 给 UI 用的中文文案:blocked 有专属提示(可操作 —— 关标签页),其余走通用兜底。
 * 开发者细节留在 `describeDbOpenFailure` 里,不泄给用户。
 *
 * @param {unknown} err
 * @returns {string}
 */
export function userFacingDbOpenError(err) {
  return isDbBlockedError(err)
    ? LIBRARY_DB_BLOCKED_MESSAGE
    : LIBRARY_DB_OPEN_FAILED_MESSAGE;
}
