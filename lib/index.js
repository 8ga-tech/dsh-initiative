/**
 * dsh-initiative — 主动搭话（宿主半边）
 *
 * 每隔一段时间在**本地**掷一次骰子；掷中了，就在她自己的会话里自己起一轮。
 * 掷不中什么都不发生——不惊动模型、不产生账单。
 *
 * 注入用的路径和官方 `dsh-schedule` 完全一致：
 *   const resolved = await ctx.sessionController.resolveAgent(sessionId)
 *   resolved.agent.followup(message)
 *   await ctx.sessions.flush(resolved.agent.session)
 *
 * 「有人说话」的时间从会话日志里读（有新 user 消息就刷新），因此不需要用户手动喂。
 *
 * 所有失败只记 warn，绝不 throw 到宿主——主动搭话坏了不该让 DSH 挂掉。
 */
import z from '@deepseek-ai/schemastery'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import {
  DEFAULT_DICE,
  normalizeDiceConfig,
  normalizeState,
  decide,
  advanceState,
  markUserSpoke,
  emptyState,
} from './dice.js'

export const name = 'initiative'
export const inject = []

export const Config = z.object({
  /** 默认关：装上不该立刻开始说话，得你明确打开并指定会话 */
  enabled: z.boolean().default(false),
  /** 目标会话 id（DSH 会话目录名，或日志里出现的 sessionId） */
  sessionId: z.string().default(''),
  intervalMinutes: z.number().default(DEFAULT_DICE.intervalMinutes),
  probability: z.number().default(DEFAULT_DICE.probability),
  idleMinutes: z.number().default(DEFAULT_DICE.idleMinutes),
  minGapMinutes: z.number().default(DEFAULT_DICE.minGapMinutes),
  dailyCap: z.number().default(DEFAULT_DICE.dailyCap),
  quietStartHour: z.number().default(DEFAULT_DICE.quietStartHour),
  quietEndHour: z.number().default(DEFAULT_DICE.quietEndHour),
  /** 掷中后注入的那句话（她的指令） */
  promptText: z.string().default('[主动搭话] 现在没人跟你说话。想说什么就自然起个话头；不想说就这轮什么都不做。'),
  /** 会话根目录，留空 = $DSH_HOME/sessions */
  sessionsDir: z.string().default(''),
  /** 状态文件，留空 = $DSH_HOME/dsh-initiative.json */
  stateFile: z.string().default(''),
})

function resolveDshHome() {
  const env = process.env.DSH_HOME
  if (env && env.trim()) return env.trim()
  return path.join(os.homedir(), '.dsh')
}

/** 读一份会话日志，返回记录数组（解不开就空数组） */
function readLogRecords(file) {
  try {
    const buf = fs.readFileSync(file)
    let raw
    try {
      raw = zstdDecompressSync(buf).toString('utf8')
    } catch {
      raw = buf.toString('utf8')
    }
    const out = []
    for (const line of raw.split(/\r?\n/)) {
      const s = line.trim()
      if (!s || s[0] !== '{') continue
      try {
        const rec = JSON.parse(s)
        if (rec && typeof rec === 'object') out.push(rec)
      } catch { /* 半行 */ }
    }
    return out
  } catch {
    return []
  }
}

function isUserMessage(rec) {
  const role = rec?.role ?? rec?.message?.role
  return role === 'user'
}

/** 找出最近被改动的会话日志文件 */
function newestLogFiles(root, limit = 20) {
  const found = []
  const walk = (dir, depth) => {
    if (depth > 3) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full, depth + 1)
      else if (e.name.endsWith('.jsonl.zstd') || e.name.endsWith('.jsonl')) {
        try {
          found.push({ file: full, mtimeMs: fs.statSync(full).mtimeMs })
        } catch { /* 正在写 */ }
      }
    }
  }
  walk(root, 0)
  found.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return found.slice(0, limit)
}

export function apply(ctx, config = {}) {
  const cfg = normalizeDiceConfig(config)
  const logger = ctx.logger ?? console

  // ⚠ 必须**显式**写 enabled: true 才启动。
  //   Config 的默认值是 false；而 dice.js 里的 normalizeDiceConfig 为了纯函数
  //   测试把默认当 true（那里只关心"给了配置怎么判"）。两者语义不同，
  //   宿主这层不能跟着放宽，否则装上插件什么都不配就开始自言自语。
  if (config.enabled !== true) {
    logger.info?.('initiative: 未启用（enabled=false）。要打开它，在 cordis.patch.yml 里给这行加 config.enabled: true')
    return
  }

  const sessionId = String(config.sessionId ?? '').trim()
  if (!sessionId) {
    logger.warn?.('initiative: 已启用但没有配置 sessionId，不启动。把目标会话 id 填进 config.sessionId')
    return
  }

  const dshHome = resolveDshHome()
  const sessionsRoot = String(config.sessionsDir ?? '').trim() || path.join(dshHome, 'sessions')
  const stateFile = String(config.stateFile ?? '').trim() || path.join(dshHome, 'dsh-initiative.json')
  const promptText = String(config.promptText ?? '').trim()
    || '[主动搭话] 现在没人跟你说话。想说什么就自然起个话头；不想说就这轮什么都不做。'

  // ── 状态落盘 ───────────────────────────────────────────────
  let state = emptyState()
  try {
    if (fs.existsSync(stateFile)) state = normalizeState(JSON.parse(fs.readFileSync(stateFile, 'utf8')))
  } catch (e) {
    logger.warn?.(`initiative: 状态文件读不出来，按空状态启动: ${e?.message ?? e}`)
  }

  function saveState() {
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true })
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8')
    } catch (e) {
      logger.warn?.(`initiative: 状态写盘失败: ${e?.message ?? e}`)
    }
  }

  // ── 「最近有人说话吗」：看会话日志的 user 消息时间 ──────────
  let lastScanMs = 0
  function refreshUserActivity() {
    const files = newestLogFiles(sessionsRoot, 10)
    if (!files.length) return
    const newest = files[0]
    // 用文件 mtime 粗判：比上次扫描新才去解析
    if (newest.mtimeMs <= lastScanMs) return
    lastScanMs = newest.mtimeMs
    const records = readLogRecords(newest.file)
    if (!records.length) return
    const last = records[records.length - 1]
    if (isUserMessage(last)) {
      state = markUserSpoke(state, Date.now())
      saveState()
      logger.debug?.('initiative: 检测到有人在说话，空闲计时重置')
    }
  }

  // ── 注入 ───────────────────────────────────────────────────
  async function deliver() {
    let resolved
    try {
      const controller = ctx.sessionController
      if (!controller || typeof controller.resolveAgent !== 'function') {
        logger.warn?.('initiative: 没有 sessionController.resolveAgent，无法注入')
        return false
      }
      resolved = await controller.resolveAgent(sessionId)
    } catch (e) {
      logger.warn?.(`initiative: resolveAgent 失败: ${e?.message ?? e}`)
      return false
    }
    if (!resolved || resolved.error) {
      logger.warn?.(`initiative: 会话不可用: ${resolved?.error?.message ?? 'unknown'}`)
      return false
    }

    const text = promptText
    const message = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      // ⚠ 自定义 source.kind 是否被接受未经验证；沿用官方 schedule 的 'schedule'
      //   最稳（它已经在生产里跑）。想区分来源可以看注入的正文前缀。
      source: { kind: 'schedule' },
    }

    const run = async () => {
      try {
        resolved.agent.followup(message)
      } catch (e) {
        logger.warn?.(`initiative: followup 抛错: ${e?.message ?? e}`)
        return false
      }
      try {
        if (ctx.sessions && typeof ctx.sessions.flush === 'function' && resolved.agent.session) {
          await ctx.sessions.flush(resolved.agent.session)
        }
      } catch (e) {
        logger.warn?.(`initiative: flush 失败（已投递但可能未持久）: ${e?.message ?? e}`)
      }
      return true
    }

    // 官方要求：投递要包在 withoutInitiator 里，否则会被当成"某个用户发起的一轮"
    try {
      if (ctx.agents && typeof ctx.agents.withoutInitiator === 'function') {
        return await ctx.agents.withoutInitiator(run)
      }
    } catch (e) {
      logger.warn?.(`initiative: withoutInitiator 失败，退回直接投递: ${e?.message ?? e}`)
    }
    return await run()
  }

  // ── 主循环 ─────────────────────────────────────────────────
  let busy = false
  async function tick() {
    if (busy) return
    busy = true
    try {
      refreshUserActivity()
      const now = Date.now()
      const outcome = decide({ now, config: cfg, state, hasSession: true })
      state = advanceState(state, { hit: false, now }) // 先记掷骰时间
      if (!outcome.hit) {
        if (outcome.reason !== 'miss') logger.debug?.(`initiative: 本次不掷（${outcome.reason}）`)
        saveState()
        return
      }
      logger.info?.(`initiative: 掷中（roll=${outcome.roll?.toFixed(3)}），开始一轮`)
      const ok = await deliver()
      if (ok) {
        state = advanceState(state, { hit: true, now })
        logger.info?.('initiative: 已注入一轮主动搭话')
      }
      saveState()
    } catch (e) {
      logger.warn?.(`initiative: tick 失败: ${e?.message ?? e}`)
    } finally {
      busy = false
    }
  }

  const everyMs = cfg.intervalMinutes * 60_000
  const timer = setInterval(tick, everyMs)
  if (typeof timer.unref === 'function') timer.unref()
  ctx.effect(() => () => clearInterval(timer), 'initiative.timer()')

  logger.info?.(
    `initiative: 已启动 —— 每 ${cfg.intervalMinutes} 分钟掷一次（p=${cfg.probability}），`
    + `空闲门槛 ${cfg.idleMinutes} 分钟，免打扰 ${cfg.quietStartHour}:00–${cfg.quietEndHour}:00，`
    + `每日上限 ${cfg.dailyCap || '不限'}，目标会话 ${sessionId}`,
  )
}
