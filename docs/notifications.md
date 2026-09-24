# 任务终态通知（webhook，issue #22）

英文版：[notifications.en.md](notifications.en.md)

长任务下调用方原先必须一直挂在天枢界面轮询 `query_task`；任务完成 / 失败 / 进入 `needs_attention`
时没有任何主动推送，盯屏成本高。本能力在状态跃迁时向配置的 URL POST 一条 JSON。

接收端由使用者自行实现 —— 飞书 / 钉钉机器人、自建小服务均可。

## 一、配置

放在**全局** `config.json`（数据目录，默认 `~/.tianshu-mcp/config.json`，可用环境变量
`TIANSHU_MCP_HOME` 覆盖）：

```jsonc
{
  "notifications": {
    "webhook": {
      "enabled": true,                 // 默认 false；不配置或 false 时**完全不发请求**
      "url": "https://example.com/hook", // enabled=true 时必填（缺它会被 schema 拒绝）
      "timeoutMs": 5000,               // 单次请求超时，默认 5s
      "maxRetries": 2,                 // 失败重试次数上限，默认 2（总尝试 = 1 + maxRetries）
      "backoffMs": 500,                // 退避基数：第 n 次重试前等 backoffMs × n，默认 500
      "secret": "your-signing-key",    // 可选；配置后对请求体做 HMAC-SHA256 签名
      "events": ["done", "failed", "needs_human"] // 可选；默认见下
    }
  }
}
```

**为什么放在全局 config 而不是项目 `acceptance.json`**：通知路由是**宿主 / 传输层**的关注点，
不是项目验收策略；一个端点通常按请求体里的 `taskId` 自行分流即可。而且状态跃迁的咽喉
（`TaskStore.updateStatus`）只有数据目录 / taskId / logger，无法在每次跃迁时廉价读取项目配置。

**配置写坏时**：`config.json` 走「last-known-good」策略 —— 校验失败会告警并沿用上一份有效配置，
不会因为写错一行通知配置就让整个 server 起不来。

## 二、事件类别与默认订阅集

| 事件 | 对应任务状态 | 默认订阅 |
|---|---|---|
| `done` | `succeeded` | ✅ |
| `failed` | `failed` | ✅ |
| `needs_human` | `needs_attention`（**真终态**，等人工裁决后任务即结束） | ✅ |
| `needs_user` | `needs_user`（**非终态** —— 可被 `continue_task` 恢复到 `queued`，之后可能**再次**进入） | ❌ 需显式开启 |
| `cancelled` | `cancelled` / `interrupted` | ❌ 需显式开启 |

**默认只推真终态**。`needs_user` 与 `needs_attention` 刻意分成两个类别：前者不是终态，
一次长任务里可能反复触发，默认打开会变成打扰；需要它的调用方把它加进 `events` 即可（已知会重复推送）。

## 三、请求体

```jsonc
{
  "taskId": "tsk_xxx",
  "event": "done",                 // done | failed | needs_human | needs_user | cancelled
  "status": "succeeded",           // 原始任务状态（比 event 更细，便于接收端自行分流）
  "ts": "2026-09-24T12:00:00.000Z",// 事件发生时刻
  "finishedAt": "2026-09-24T12:00:00.000Z",
  "agentId": "codex",
  "projectPath": "D:/proj",
  "round": 1,                      // 已用轮次
  "reportRound": 0,                // 最新验收报告轮次（若有）
  "message": "验收通过。",          // 终态文案
  "reportMd": "...report-0.md",    // 验收报告路径（若有）
  "reportJson": "...report-0.json"
}
```

请求头：

| 头 | 说明 |
|---|---|
| `content-type` | `application/json` |
| `X-Tianshu-Event` | 事件类别（与 body 的 `event` 一致，便于接收端免解析分流） |
| `X-Tianshu-Signature` | 仅在配置了 `secret` 时出现：`sha256=<hex>`，对**原始请求体字符串**做 HMAC-SHA256 |

## 四、接收端实现建议

**校验签名**（配了 `secret` 时务必做，防止伪造通知）：

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(rawBody, signatureHeader, secret) {
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader ?? "");
  return a.length === b.length && timingSafeEqual(a, b);
}
```

注意要拿**原始 body 字符串**（不是重新 `JSON.stringify` 的对象 —— 键顺序会变，签不上）。

**飞书自定义机器人**：其 webhook 要求特定报文格式（`{"msg_type":"text","content":{"text":"…"}}`），
与本 MCP 的请求体不同。两种接法：

1. 自建一个转发小服务：收本 MCP 的通知 → 校验签名 → 拼成飞书格式再转发；
2. 用一个能改写报文的网关 / Serverless 函数做同样的事。

**钉钉同理**（要求 `{"msgtype":"text","text":{"content":"…"}}`，且通常需要加签参数）。

**幂等建议**：接收端按 `taskId + status + finishedAt` 去重（MCP 侧已按同一键在进程内去重，
但跨重启或重试仍可能重复送达 —— 见下节）。

## 五、交付语义（如实披露）

- **尽力投递，不保证送达**：通知是观测能力，不是交付保证。发送失败只写 `warn` 日志，
  **不重排状态机、不改任务终态、不阻塞任何调用**。
- **不阻塞**：发送全程异步（fire-and-forget）。端点慢或挂掉**不会**拖慢任务。
- **重试**：总尝试 `1 + maxRetries` 次；网络错误、超时、非 2xx 都重试；退避 `backoffMs × 第几次`。
  全部失败后仅记一条 `warn`。
- **恰好一次的范围**：MCP 侧按 `taskId + status + finishedAt` 在**进程内**去重 ——
  同一回合的重复状态写入只通知一次；返修后的新回合（`finishedAt` 变化）会**再次**通知。
  跨 server 重启或接收端重试仍可能重复送达，故建议接收端自行幂等。
- **不跟随重定向**：`redirect: "manual"`，端点请直接返回 2xx。
- **正文可能含项目路径**：请求体含 `projectPath` 与报告文件的本地绝对路径。请确认接收端可信
  （尤其是把通知转发到公网服务时）。
