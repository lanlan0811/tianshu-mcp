# v0.6.7 — 任务终态 webhook 通知

> 关联 issue：[#22](https://github.com/lanlan0811/tianshu-mcp/issues/22)。详见 [任务终态通知](notifications.md)。

## 背景

长任务场景下调用方原先必须一直挂在天枢界面轮询 `query_task`。任务完成、失败或进入
`needs_attention` 时无主动推送，盯屏成本高。

## 新增

- **`notifications.webhook`（全局 `config.json`）**：

  ```jsonc
  { "notifications": { "webhook": {
      "enabled": true, "url": "https://example.com/hook",
      "timeoutMs": 5000, "maxRetries": 2, "backoffMs": 500,
      "secret": "your-signing-key",
      "events": ["done", "failed", "needs_human"] } } }
  ```

- **终态跃迁时异步 POST**：请求体含 `taskId` / `event` / `status` / `ts` / `finishedAt` /
  `agentId` / `projectPath` / `round` / `reportRound` / `message` / `reportMd` / `reportJson`；
  请求头 `X-Tianshu-Event`，配了 `secret` 时另加 `X-Tianshu-Signature: sha256=<hex>`。
- **`src/tasks/notifier.ts`**：`TaskNotifier` + `statusToEvent()`。

## 事件类别与默认订阅

| 事件 | 对应状态 | 默认订阅 |
|---|---|---|
| `done` | `succeeded` | ✅ |
| `failed` | `failed` | ✅ |
| `needs_human` | `needs_attention`（真终态） | ✅ |
| `needs_user` | `needs_user`（**非终态**，可被 continue 恢复、可能再次进入） | ❌ 需显式开启 |
| `cancelled` | `cancelled` / `interrupted` | ❌ 需显式开启 |

`needs_user` 与 `needs_attention` 刻意分成两类：前者不是终态，一次长任务里可能反复触发，
默认打开会变成打扰。

## 关键设计决定

| 决定 | 理由 |
|---|---|
| 钩子点是 `TaskStore.updateStatus()` | 状态跃迁的**唯一咽喉**。`TaskOrchestrator.finish()` 只覆盖编排器主导的结束 —— `cancel()` 的 queued 分支、`initialize()` 的重启归档、`shutdownInterrupt()` / `persistInterrupted()` 全都绕过它 |
| 配置放全局 `config.json` | 通知路由是宿主/传输层关注点，不是项目验收策略；且 `updateStatus` 处只有数据目录 / taskId / logger，无法每次跃迁都廉价读项目配置 |
| 去重键 `taskId + status + finishedAt` | **不能**用 `prev !== status`：多条路径会**先直接改写 `meta.status`** 再调用 `updateStatus`，那时 `prev` 已等于目标状态。`finishedAt` 由 `updateStatus` 写终态时刷新、并被 `rework`/`continueTask` 清空 —— 同回合重复写入被抑制，返修后的新回合会再次通知 |
| 在 `appendEvent` + `writeSnapshot` 之后才发 | 先保证本地事实落盘，再对外通知 |
| `notify()` fire-and-forget，返回 void | 发送与重试全在后台；端点慢或挂掉**不阻塞状态机写入链** |
| 全局 `fetch` + `AbortSignal.timeout` + `redirect:"manual"` | 与 `src/visual/services.ts` 同一约定，Node ≥ 20 自带，不加依赖 |
| notifier 是 `TaskStore` 的**可选**第三参 | 大量测试直接 `new TaskStore(home, logger)`，必须向后兼容 |

## 兼容性

- **默认关闭**：不配置或 `enabled:false` 时**完全不发起任何请求**，行为与 v0.6.6 一致。
- **无工具契约、数据模型或 MCP 注解变更**；仅新增一个**可选**的 config 段。

## 如实披露

- **尽力投递，不保证送达**：发送失败（网络错误 / 超时 / 非 2xx）重试 `maxRetries` 次后仅记一条
  `warn`，**绝不改变任务终态、绝不阻塞调用**。
- **「恰好一次」的边界**：MCP 侧按上述键在**进程内**去重；跨 server 重启或接收端重试仍可能重复送达，
  建议接收端自行幂等。
- **请求体含本地路径**：包含 `projectPath` 与验收报告文件的绝对路径；转发到公网服务前请确认接收端可信。
- **`enabled=true` 但缺 `url` 会被 schema 拒绝**（禁止「开了却不发」的静默混淆）；`config.json` 走
  last-known-good，写坏只告警并沿用上一份有效配置。
- **飞书/钉钉需自行适配**：其自定义机器人要求各自特有的报文格式，与本 MCP 的请求体不同；
  文档给出了「自建转发服务」与「网关改写」两种接法，并附签名校验示例代码。

## 测试

- 新增 29 个用例（2 个文件）+ 测试基建：
  - `test/unit/notifier.test.ts`（20）：`statusToEvent` 六状态映射与中间态不产事件；配置默认值
    （默认只订阅真终态、`needs_user` 不在其中）与「enabled 但缺 url 被拒」；默认关闭的四种零请求
    情形（未配置 / `enabled:false` / 事件未订阅 / `needs_user` 未显式订阅）；成功发送的请求体与
    事件头；配 `secret` 时的 HMAC 签名可被同一 secret 复算校验、不配时无签名头；恰好一次（同键重复
    notify 只发一次、`finishedAt` 变化再发、同任务不同状态各发一次）；失败不阻塞（恒 500 重试到上限
    即止、先失败后成功重试一次即送达、端口不可达仅告警、读配置抛错仅告警）。
  - `test/integration/webhook-notify.test.ts`（9）：真实 MCP 层 —— 成功任务恰好一次 POST
    （`done` + body 正确）、失败任务 `failed`、`needs_attention`（走干跑违规路径）`needs_human`；
    未配置 / `enabled:false` / 只订阅 `failed` 三种零请求；端点恒 500 时**任务仍成功到终态**且
    尝试次数恰为 `1 + maxRetries`；端口不可达仍到终态；webhook 段写坏时落到 last-known-good 且任务不受影响。
  - `test/test-utils.ts` 新增 `startMockWebhook()`（真实 `node:http`，记录 body / headers / **本次返回状态码**）、
    `closedPortUrl()`（返回一个必然连不上的本地端口）与 `waitForCondition()`。
- 全量 `npm test`：**1139 passed / 12 skipped**（103 文件；v0.6.6 为 1110 passed / 12 skipped，净增 29）。
- 新增用例沿用 v0.6.5 的 CI 教训：**不依赖本机安装任何 GUI agent**，且不依赖外网（mock 服务只监听
  127.0.0.1 随机端口）。

## 真机记录

本 issue 的验收标准是「`notificationWebhook` 配置项默认关闭」「状态跃迁时按配置发送 POST，有对应测试」
「发送失败不影响主状态机，仅记录日志」「文档说明请求体格式与接收端实现建议」——四项均由上述单测 /
集成测试 / 文档覆盖，**无真机 GUI 依赖**（通知触发只依赖状态机跃迁，stub agent 即可完整驱动），
故本版不需要真机记录。
