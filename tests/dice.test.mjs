import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_DICE,
  normalizeDiceConfig,
  normalizeState,
  emptyState,
  dayKeyOf,
  inQuietHours,
  rollDice,
  decide,
  advanceState,
  markUserSpoke,
} from '../lib/dice.js'

/** 造一个本地时间的时间戳（避免测试受运行机器时区影响） */
function at(hour, minute = 0, day = 15) {
  return new Date(2026, 9, day, hour, minute, 0, 0).getTime()
}

test('配置越界值被夹住', () => {
  const c = normalizeDiceConfig({ probability: 5, intervalMinutes: -3, idleMinutes: 'x', dailyCap: -9 })
  assert.equal(c.probability, 1)
  assert.equal(c.intervalMinutes, 1)
  assert.equal(c.idleMinutes, DEFAULT_DICE.idleMinutes)
  assert.equal(c.dailyCap, 0)
})

test('免打扰支持跨零点', () => {
  assert.equal(inQuietHours(at(23), 22, 7), true)
  assert.equal(inQuietHours(at(3), 22, 7), true)
  assert.equal(inQuietHours(at(12), 22, 7), false)
  assert.equal(inQuietHours(at(7), 22, 7), false, '含头不含尾')
})

test('start === end 表示不启用免打扰', () => {
  assert.equal(inQuietHours(at(3), 5, 5), false)
})

test('明确关闭时直接不掷', () => {
  const r = decide({ now: at(12), config: { enabled: false } })
  assert.equal(r.hit, false)
  assert.equal(r.reason, 'disabled')
  assert.equal(r.roll, null)
})

test('没有会话目标时不掷', () => {
  const r = decide({ now: at(12), config: {}, hasSession: false })
  assert.equal(r.reason, 'no-session')
  assert.equal(r.roll, null)
})

test('免打扰时段不掷', () => {
  const r = decide({ now: at(3), config: { quietStartHour: 1, quietEndHour: 8 } })
  assert.equal(r.reason, 'quiet-hours')
  assert.equal(r.roll, null)
})

test('刚有人说话（不够空闲）不掷', () => {
  const now = at(12, 0)
  const r = decide({ now, config: { idleMinutes: 20 }, state: { lastUserAt: now - 5 * 60_000 } })
  assert.equal(r.reason, 'not-idle')
  assert.equal(r.roll, null)
  assert.equal(r.detail.need, 20)
})

test('够空闲才掷', () => {
  const now = at(12, 0)
  const r = decide({
    now,
    config: { idleMinutes: 20, probability: 1 },
    state: { lastUserAt: now - 60 * 60_000 },
    random: () => 0,
  })
  assert.equal(r.reason, 'hit')
  assert.equal(r.hit, true)
})

test('距上次主动太近不掷（最小间隔）', () => {
  const now = at(12, 0)
  const r = decide({
    now,
    config: { minGapMinutes: 30, idleMinutes: 0, probability: 1 },
    state: { lastSpokeAt: now - 10 * 60_000 },
  })
  assert.equal(r.reason, 'min-gap')
})

test('当日达到上限后不掷', () => {
  const now = at(12, 0)
  const r = decide({
    now,
    config: { dailyCap: 2, idleMinutes: 0, probability: 1 },
    state: { dayKey: dayKeyOf(now), dayCount: 2 },
  })
  assert.equal(r.reason, 'daily-cap')
})

test('跨天后计数归零，可以再掷', () => {
  const now = at(12, 0, 16)
  const r = decide({
    now,
    config: { dailyCap: 2, idleMinutes: 0, probability: 1 },
    state: { dayKey: dayKeyOf(at(12, 0, 15)), dayCount: 2 },
    random: () => 0,
  })
  assert.equal(r.reason, 'hit')
})

test('概率边界：掷到 0 必中、逼近 1 必不中（p=0.25）', () => {
  const cfg = { probability: 0.25, idleMinutes: 0 }
  const base = { now: at(12), config: cfg }
  assert.equal(decide({ ...base, random: () => 0 }).hit, true)
  assert.equal(decide({ ...base, random: () => 0.249 }).hit, true)
  assert.equal(decide({ ...base, random: () => 0.25 }).hit, false)
  assert.equal(decide({ ...base, random: () => 0.999 }).hit, false)
})

test('概率为 0 时永远不开口', () => {
  const r = decide({ now: at(12), config: { probability: 0, idleMinutes: 0 }, random: () => 0 })
  assert.equal(r.hit, false)
  assert.equal(r.reason, 'miss')
})

test('rollDice 挡住不规范的随机源', () => {
  assert.equal(rollDice(() => 1), 0.999999)
  assert.equal(rollDice(() => -5), 0)
  assert.equal(rollDice(() => Number.NaN), 0.5)
})

test('advanceState：中了下则记一次开口并累加当日计数', () => {
  const now = at(12)
  const next = advanceState(emptyState(), { hit: true, now })
  assert.equal(next.lastSpokeAt, now)
  assert.equal(next.dayCount, 1)
  assert.equal(next.dayKey, dayKeyOf(now))
})

test('advanceState：没中只更新掷骰时间，不累加', () => {
  const now = at(12)
  const next = advanceState(emptyState(), { hit: false, now })
  assert.equal(next.lastSpokeAt, 0)
  assert.equal(next.dayCount, 0)
  assert.equal(next.lastRollAt, now)
})

test('advanceState 不修改入参', () => {
  const st = emptyState()
  const clone = JSON.parse(JSON.stringify(st))
  advanceState(st, { hit: true, now: at(12) })
  assert.deepEqual(st, clone)
})

test('markUserSpoke 只动 lastUserAt', () => {
  const now = at(12)
  const next = markUserSpoke(emptyState(), now)
  assert.equal(next.lastUserAt, now)
  assert.equal(next.lastSpokeAt, 0)
})

test('normalizeState 挡住脏数据', () => {
  const s = normalizeState({ lastUserAt: 'oops', dayCount: -3, dayKey: 42, extra: 'ignored' })
  assert.equal(s.lastUserAt, 0)
  assert.equal(s.dayCount, 0)
  assert.equal(s.dayKey, '')
  assert.equal('extra' in s, false)
})
