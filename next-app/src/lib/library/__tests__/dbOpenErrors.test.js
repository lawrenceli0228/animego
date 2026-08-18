// CG3 — Dexie v6 迁移失败的用户可见行为。
//
// 这条测试盯的不是「升级成功了吗」,而是「升级没成功时用户看到什么」。方案 §9
// 把它列为关键缺口的判据是:无测试 AND 无错误处理 AND 静默。最可能触发的机制是
// 多标签页 —— 旧标签持有的连接让 v6 升级停在 `blocked` 上,IndexedDB 不报错、
// 只是永远不 resolve,所以症状是「库一直转圈」而不是一条报错。
//
// 这里测的是纯逻辑(错误构造 / blocked 判定 / 文案选择)。db.js 在模块加载时就
// `new Dexie(...)` 且顶部有服务端守卫,在 bun test(无 window、无 fake-indexeddb)
// 里根本 import 不进来 —— 所以能测的部分必须先被抽出来,这也正是抽出
// dbOpenErrors.js 的原因。

import { describe, it, expect } from 'bun:test'
import {
  LIBRARY_DB_BLOCKED_MESSAGE,
  LIBRARY_DB_OPEN_FAILED_MESSAGE,
  describeDbOpenFailure,
  isDbBlockedError,
  makeDbBlockedError,
  makeDbBlockedState,
  userFacingDbOpenError,
} from '../db/dbOpenErrors.js'

describe('CG3 — blocked 升级', () => {
  it('blocked 错误能被认出来', () => {
    const err = makeDbBlockedError('animego-library')
    expect(isDbBlockedError(err)).toBe(true)
  })

  it('blocked 错误自带可操作的中文提示,且明说数据还在', () => {
    const err = makeDbBlockedError('animego-library')
    expect(err.message).toContain(LIBRARY_DB_BLOCKED_MESSAGE)
    // 「关掉其他标签页」是用户唯一能做的动作,不写出来这条提示等于没有。
    expect(err.message).toContain('标签页')
    // 库打不开时用户第一反应是数据没了,先否掉这个念头。
    expect(LIBRARY_DB_BLOCKED_MESSAGE).toContain('都还在')
  })

  it('错误消息带上库名,便于在多库场景里定位', () => {
    expect(makeDbBlockedError('animego-library-test').message).toContain(
      'animego-library-test',
    )
  })

  it('库名缺失时不产出 undefined 文案', () => {
    const err = makeDbBlockedError(undefined)
    expect(err.message).toContain('animego-library')
    expect(err.message).not.toContain('undefined')
  })

  it('blocked 消息透传不被二次包装 —— 包一层就把中文提示埋进英文噪音里', () => {
    const err = makeDbBlockedError('animego-library')
    const described = describeDbOpenFailure('animego-library', err)
    expect(described).toBe(err.message)
    expect(described).not.toContain('Failed to open IndexedDB')
    // 再包一次仍然认得出来(open 包装器会把 describe 的结果重新 throw)。
    expect(isDbBlockedError(new Error(described))).toBe(true)
  })
})

describe('其余打开失败', () => {
  it('保留原始原因,便于归因', () => {
    const msg = describeDbOpenFailure(
      'animego-library',
      new DOMException('QuotaExceededError', 'QuotaExceededError'),
    )
    expect(msg).toContain('animego-library')
    expect(msg).toContain('QuotaExceededError')
  })

  it('非 Error 的抛出物也能收窄成字符串,不产出 [object Object]', () => {
    expect(describeDbOpenFailure('animego-library', 'boom')).toContain('boom')
    expect(isDbBlockedError('boom')).toBe(false)
    expect(isDbBlockedError(null)).toBe(false)
    expect(isDbBlockedError(undefined)).toBe(false)
  })
})

describe('blocked 状态', () => {
  it('卡住时带文案', () => {
    expect(makeDbBlockedState(true)).toEqual({
      blocked: true,
      message: LIBRARY_DB_BLOCKED_MESSAGE,
    })
  })

  it('恢复时把文案清掉 —— 否则横幅撤不下去', () => {
    expect(makeDbBlockedState(false)).toEqual({ blocked: false, message: null })
  })

  it('只有严格 true 才算卡住 —— 别让 truthy 值把横幅点亮', () => {
    for (const notTrue of [false, 0, '', null, undefined, 'yes', 1]) {
      expect(makeDbBlockedState(notTrue).blocked).toBe(false)
    }
  })
})

describe('给 UI 的文案选择', () => {
  it('blocked 走可操作提示', () => {
    expect(userFacingDbOpenError(makeDbBlockedError('animego-library'))).toBe(
      LIBRARY_DB_BLOCKED_MESSAGE,
    )
  })

  it('其余走通用兜底,且不泄露开发者细节', () => {
    const text = userFacingDbOpenError(new Error('VersionError: aborted'))
    expect(text).toBe(LIBRARY_DB_OPEN_FAILED_MESSAGE)
    expect(text).not.toContain('VersionError')
    expect(text).toContain('都还在')
  })

  it('两条文案不相同 —— 合并成一条就等于没有分支', () => {
    expect(LIBRARY_DB_BLOCKED_MESSAGE).not.toBe(LIBRARY_DB_OPEN_FAILED_MESSAGE)
  })
})
