/**
 * lib/dice.js — 主动搭话的纯决策核心。
 *
 * 这一层不依赖 DSH / cordis / 定时器 / 网络：给定「现在几点、上次说话是什么时候、
 * 今天已经主动几次」，它只回答一个问题 —— **这一次掷骰要不要真的开口**。
 *
 * 设计要点（照抄视频里那条最有价值的原则）：
 *  · **本地掷骰，零 token**。掷不中什么都不发生，不惊动模型、不产生账单。
 *  · **四道闸**，任何一道没过就不掷：
 *      ① 免打扰时段（默认 01:00–08:00）—— 半夜把人吵醒是最快被卸载的方式
 *      ② 空闲门槛（距上次有人说话 ≥ idleMinutes）—— 她不该打断正在进行的对话
 *      ③ 最小间隔（距上次主动 ≥ minGapMinutes）—— 防连珠炮
 *      ④ 每日上限 —— 防"越热闹越来劲"，把主动性变成骚扰
 *  · 掷骰本身用可注入的 random，测试里可完全确定。
 */

/** 默认配置。宿主插件会把用户配置合并到这里。 */
export const DEFAULT_DICE = Object.freeze({
  enabled: true,
  /** 每隔多少分钟掷一次骰子 */
  intervalMinutes: 10,
  /** 掷中的概率（0–1） */
  probability: 0.25,
  /** 距最后一次有人说话至少过去多少分钟 */
  idleMinutes: 20,
  /** 两次主动之间至少间隔多少分钟 */
  minGapMinutes: 30,
  /** 每天最多主动几次（0 = 不限） */
  dailyCap: 6,
  /** 免打扰时段，按**本地小时**，含头不含尾；start === end 表示不启用 */
  quietStartHour: 1,
  quietEndHour: 8,
})

/** 把任意输入夹成 [min, max] 的数字 */
function clampNumber(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** 规整配置，挡住越界与非法值（配置文件是手写的，不能信） */
export function normalizeDiceConfig(input = {}) {
  const cfg = { ...DEFAULT_DICE, ...input }
  return {
    enabled: cfg.enabled !== false,
    intervalMinutes: clampNumber(cfg.intervalMinutes, 1, 24 * 60, DEFAULT_DICE.intervalMinutes),
    probability: clampNumber(cfg.probability, 0, 1, DEFAULT_DICE.probability),
    idleMinutes: clampNumber(cfg.idleMinutes, 0, 24 * 60, DEFAULT_DICE.idleMinutes),
    minGapMinutes: clampNumber(cfg.minGapMinutes, 0, 24 * 60, DEFAULT_DICE.minGapMinutes),
    dailyCap: Math.floor(clampNumber(cfg.dailyCap, 0, 1000, DEFAULT_DICE.dailyCap)),
    quietStartHour: Math.floor(clampNumber(cfg.quietStartHour, 0, 23, DEFAULT_DICE.quietStartHour)),
    quietEndHour: Math.floor(clampNumber(cfg.quietEndHour, 0, 23, DEFAULT_DICE.quietEndHour)),
  }
}

/** 本地日期键（YYYY-MM-DD），用来按天计数 */
export function dayKeyOf(when) {
  const d = when instanceof Date ? when : new Date(when)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * 是否处于免打扰时段。支持跨零点（例如 23 → 7）。
 * start === end 视为不启用。
 */
export function inQuietHours(when, startHour, endHour) {
  if (startHour === endHour) return false
  const d = when instanceof Date ? when : new Date(when)
  const h = d.getHours()
  if (startHour < endHour) return h >= startHour && h < endHour
  // 跨零点
  return h >= startHour || h < endHour
}

/** 掷一次骰子：返回 [0, 1) 的均匀随机数。可注入以便测试。 */
export function rollDice(random = Math.random) {
  const r = Number(random())
  if (!Number.isFinite(r)) return 0.5
  // 挡住实现不规范的 random（等于 1 或负数）
  return Math.min(0.999999, Math.max(0, r))
}

/** 空状态 */
export function emptyState() {
  return {
    /** 最后一次「有人跟她说话」的时间戳（毫秒） */
    lastUserAt: 0,
    /** 最后一次主动开口的时间戳 */
    lastSpokeAt: 0,
    /** 每日计数的日期键 */
    dayKey: '',
    /** 当天已主动次数 */
    dayCount: 0,
    /** 最后一次掷骰时间（含未中的） */
    lastRollAt: 0,
  }
}

/** 把状态规整成可安全 JSON 落盘的形状 */
export function normalizeState(input = {}) {
  const base = emptyState()
  const s = { ...base, ...(input || {}) }
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)
  return {
    lastUserAt: num(s.lastUserAt, 0),
    lastSpokeAt: num(s.lastSpokeAt, 0),
    dayKey: typeof s.dayKey === 'string' ? s.dayKey : '',
    dayCount: Math.max(0, Math.floor(num(s.dayCount, 0))),
    lastRollAt: num(s.lastRollAt, 0),
  }
}

/**
 * 核心决策。**纯函数**：不改 state，只返回判定结果。
 *
 * @param {object} input
 * @param {number|Date} input.now        现在（毫秒时间戳或 Date）
 * @param {object} [input.config]        用户配置（会被 normalize）
 * @param {object} [input.state]         当前状态（会被 normalize）
 * @param {() => number} [input.random]  随机源，默认 Math.random
 * @param {boolean} [input.hasSession]   是否有可注入的会话目标（没有就不掷）
 * @returns {{ roll: number|null, hit: boolean, reason: string, detail?: object }}
 *   reason: disabled | no-session | quiet-hours | not-idle | min-gap | daily-cap | miss | hit
 */
export function decide({ now, config, state, random = Math.random, hasSession = true } = {}) {
  const at = now instanceof Date ? now.getTime() : Number(now)
  const cfg = normalizeDiceConfig(config)
  const st = normalizeState(state)

  if (!cfg.enabled) return { roll: null, hit: false, reason: 'disabled' }
  if (!hasSession) return { roll: null, hit: false, reason: 'no-session' }

  if (inQuietHours(at, cfg.quietStartHour, cfg.quietEndHour)) {
    return {
      roll: null,
      hit: false,
      reason: 'quiet-hours',
      detail: { startHour: cfg.quietStartHour, endHour: cfg.quietEndHour },
    }
  }

  const lastUserAt = st.lastUserAt || 0
  if (lastUserAt > 0) {
    const idleMs = at - lastUserAt
    if (idleMs < cfg.idleMinutes * 60_000) {
      return {
        roll: null,
        hit: false,
        reason: 'not-idle',
        detail: { idleMinutes: Math.floor(idleMs / 60_000), need: cfg.idleMinutes },
      }
    }
  }

  if (st.lastSpokeAt > 0) {
    const gapMs = at - st.lastSpokeAt
    if (gapMs < cfg.minGapMinutes * 60_000) {
      return {
        roll: null,
        hit: false,
        reason: 'min-gap',
        detail: { gapMinutes: Math.floor(gapMs / 60_000), need: cfg.minGapMinutes },
      }
    }
  }

  // 每日上限：跨天时计数归零（只影响判定，不改 state）
  const today = dayKeyOf(at)
  const dayCount = st.dayKey === today ? st.dayCount : 0
  if (cfg.dailyCap > 0 && dayCount >= cfg.dailyCap) {
    return { roll: null, hit: false, reason: 'daily-cap', detail: { dayCount, cap: cfg.dailyCap } }
  }

  // 四道闸都过了，才掷骰
  const roll = rollDice(random)
  const hit = roll < cfg.probability
  return {
    roll,
    hit,
    reason: hit ? 'hit' : 'miss',
    detail: { probability: cfg.probability, dayCount, dayKey: today },
  }
}

/**
 * 根据一次判定结果算出**新的状态**（不改入参）。
 * @param {object} state
 * @param {{hit:boolean, reason:string, now:number|Date}} outcome
 */
export function advanceState(state, outcome) {
  const st = normalizeState(state)
  const at = outcome.now instanceof Date ? outcome.now.getTime() : Number(outcome.now)
  const today = dayKeyOf(at)
  const next = { ...st, lastRollAt: at }
  if (st.dayKey !== today) {
    next.dayKey = today
    next.dayCount = 0
  }
  if (outcome.hit) {
    next.lastSpokeAt = at
    next.dayCount = (next.dayKey === today ? next.dayCount : 0) + 1
    next.dayKey = today
  }
  return next
}

/** 记一次"有人说话了"（不判闸，只更新时间戳与日键） */
export function markUserSpoke(state, when) {
  const st = normalizeState(state)
  const at = when instanceof Date ? when.getTime() : Number(when)
  return { ...st, lastUserAt: at }
}
