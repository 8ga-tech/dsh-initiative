# 主动搭话 · dsh-initiative

**没人在跟她说话的时候，她也会自己起个话头。**

每隔一段时间在**本地**掷一次骰子（纯 `Math.random`，**不花模型、不产生账单**）；掷中了，就在她自己的会话里自己走一轮 —— 人格、历史、工具、记忆全都是她自己的，和有人叫她的那一轮没有区别。

掷不中什么都不发生。

> 参考了 [Yuuyuko-uu/dsh-speak-up](https://github.com/Yuuyuko-uu/dsh-speak-up) 的思路（「本地掷骰、掷中才走一轮」），代码为独立实现。注入路径与官方 `@deepseek-ai/dsh-schedule` 完全一致。

---

## 四道闸

任何一个没过就**不掷骰**。这是它和「定时骚扰器」的区别：

| 闸 | 默认 | 作用 |
|---|---|---|
| **免打扰时段** | 01:00–08:00 | 半夜把人吵醒是最快被卸载的方式（支持跨零点） |
| **空闲门槛** | 20 分钟 | 距上次有人说话不够久就不掷，绝不打断正在进行的对话 |
| **最小间隔** | 30 分钟 | 两次主动之间至少隔这么久，防连珠炮 |
| **每日上限** | 6 次 | 防"越热闹越来劲"，把主动性变成骚扰 |

四道都过了才掷；骰子概率默认 `0.25`。

「上次有人说话」不需要你手动喂：插件会读会话日志，看到新的 user 消息就重置空闲计时。

---

## 安装

```sh
dsh plugin --profile <你的profile> add C:\src\dsh-initiative
```

在 profile 的 `cordis.patch.yml` 里加：

```yaml
- insert:
    - id: initiative
      name: 'dsh-initiative'
      config:
        enabled: true
        sessionId: '在这里填目标会话 id'
```

> ⚠ **默认 `enabled: false`**：装上不会立刻开始说话。必须同时给 `enabled: true` 与 `sessionId` 才会启动 —— 这是故意的，免得你装完一转身它就开始自言自语。

启动成功日志：

```
[initiative] initiative: 已启动 —— 每 10 分钟掷一次（p=0.25），空闲门槛 20 分钟，免打扰 1:00–8:00，每日上限 6，目标会话 <id>
```

---

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 必须显式为 `true` 才启动 |
| `sessionId` | `''` | 目标会话 id（必填） |
| `intervalMinutes` | `10` | 多久掷一次骰子 |
| `probability` | `0.25` | 掷中概率（0–1） |
| `idleMinutes` | `20` | 距上次有人说话至少多久 |
| `minGapMinutes` | `30` | 两次主动之间至少间隔 |
| `dailyCap` | `6` | 每天最多主动几次，`0` = 不限 |
| `quietStartHour` / `quietEndHour` | `1` / `8` | 免打扰时段（本地小时，含头不含尾；两值相等 = 不启用） |
| `promptText` | 见下 | 掷中后注入的那句话 |
| `sessionsDir` | `''` | 会话根目录，留空 = `$DSH_HOME/sessions` |
| `stateFile` | `''` | 状态文件，留空 = `$DSH_HOME/dsh-initiative.json` |

默认注入文本：

```
[主动搭话] 现在没人跟你说话。想说什么就自然起个话头；不想说就这轮什么都不做。
```

---

## 它是怎么注入的

与官方 `dsh-schedule` 同一条已验证路径：

```js
await ctx.agents.withoutInitiator(async () => {
  const r = await ctx.sessionController.resolveAgent(sessionId)
  if ('error' in r) throw r.error
  const msg = createUserMessage({
    content: [{ type: 'text', text: promptText }],
    source: { kind: 'schedule' },   // 只验证过 'user' / 'schedule' 两种，沿用最稳
  })
  r.agent.followup(msg)             // 入 next-turn 收件箱并唤醒 driver
  await ctx.sessions.flush(r.agent.session)
})
```

⚠ 外层必须包 `withoutInitiator`，否则会被算成"某个 agent 发起的一轮"，语义就错了。

---

## 已知边界

- **没有"立刻同步跑一轮"的 API**。`followup` 只是入队 + 唤醒，真正开跑由 agent-loop 的 driver 决定；会话正忙时消息会排到下一轮。
- 每命中一次都是**真实模型调用**，会消耗额度。骰子必须够稀疏 —— 默认每天最多 6 次。
- 与 `dsh-schedule`（定时提醒）功能有重叠，两者对同一会话投递时需自己互斥。
- 自定义 `source.kind` 是否被校验接受**未经验证**，所以沿用 `'schedule'`；想区分来源可以看注入正文的前缀。
- 状态落盘用的是普通的 JSON 文件（`$DSH_HOME/dsh-initiative.json`），不是官方 storage domain —— 这是为了少依赖一个服务、也让状态可直接读改。如果你的组合要求走 storage domain，可以改 `lib/index.js` 里的 `saveState`。

---

## 开发

```sh
node --test tests/dice.test.mjs
```

`lib/dice.js` 是**纯函数**决策核心（不碰 DSH、不碰定时器、不碰网络），19 个单测覆盖：配置越界夹取、跨零点免打扰、四道闸逐一拦截、概率边界、跨天计数归零、状态不被就地修改。

`lib/index.js` 只负责把这些判定接到定时器和会话注入上。

## 许可

MIT
