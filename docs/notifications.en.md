# Task notification (webhook, issue #22)

Chinese version: [notifications.md](notifications.md)

For long tasks the caller previously had to keep polling `query_task` from the Tianshu UI; nothing was
pushed when a task completed, failed or entered `needs_attention`, so babysitting was expensive. This
capability POSTs a JSON body to a configured URL on state transitions.

The receiver is yours to implement — a Feishu / DingTalk bot or a small self-hosted service both work.

## 1. Configuration

It lives in the **global** `config.json` (in the data home, `~/.tianshu-mcp/config.json` by default,
overridable with `TIANSHU_MCP_HOME`):

```jsonc
{
  "notifications": {
    "webhook": {
      "enabled": true,                 // default false; unset or false sends **no requests at all**
      "url": "https://example.com/hook", // required when enabled=true (the schema rejects its absence)
      "timeoutMs": 5000,               // per-request timeout, default 5s
      "maxRetries": 2,                 // retry cap, default 2 (total attempts = 1 + maxRetries)
      "backoffMs": 500,                // backoff base: waits backoffMs × n before retry n, default 500
      "secret": "your-signing-key",    // optional; adds an HMAC-SHA256 signature over the body
      "events": ["done", "failed", "needs_human"] // optional; defaults below
    }
  }
}
```

**Why the global config rather than a project `acceptance.json`**: notification routing is a
**host / transport** concern, not project acceptance policy; one endpoint normally demultiplexes by the
`taskId` in the body. Also, the state-transition choke point (`TaskStore.updateStatus`) only has the data
home, taskId and logger, so it cannot cheaply read project config on every transition.

**When the config is broken**: `config.json` follows a last-known-good policy — a validation failure logs
a warning and keeps the previous valid config, so one bad notification line cannot stop the server from
starting.

## 2. Event classes and the default subscription

| Event | Task status | Subscribed by default |
|---|---|---|
| `done` | `succeeded` | ✅ |
| `failed` | `failed` | ✅ |
| `needs_human` | `needs_attention` (**terminal** — the task ends once a human rules) | ✅ |
| `needs_user` | `needs_user` (**non-terminal** — `continue_task` can restore it to `queued`, and it may enter `needs_user` again) | ❌ opt in |
| `cancelled` | `cancelled` / `interrupted` | ❌ opt in |

**Only true terminal states are pushed by default.** `needs_user` and `needs_attention` are deliberately
separate classes: the former is non-terminal and can fire repeatedly in one long task, so enabling it by
default would be noise; callers who want it can add it to `events` (knowing it will repeat).

## 3. Request body

```jsonc
{
  "taskId": "tsk_xxx",
  "event": "done",                 // done | failed | needs_human | needs_user | cancelled
  "status": "succeeded",           // raw task status (finer than event; lets receivers demultiplex)
  "ts": "2026-09-24T12:00:00.000Z",// when the event happened
  "finishedAt": "2026-09-24T12:00:00.000Z",
  "agentId": "codex",
  "projectPath": "D:/proj",
  "round": 1,                      // rounds used
  "reportRound": 0,                // latest acceptance report round (if any)
  "message": "验收通过。",          // terminal message
  "reportMd": "...report-0.md",    // acceptance report paths (if any)
  "reportJson": "...report-0.json"
}
```

Headers:

| Header | Notes |
|---|---|
| `content-type` | `application/json` |
| `X-Tianshu-Event` | The event class (same as the body's `event`, so receivers can route without parsing) |
| `X-Tianshu-Signature` | Only when `secret` is configured: `sha256=<hex>`, HMAC-SHA256 over the **raw request body string** |

## 4. Receiver guidance

**Verify the signature** (do this whenever `secret` is set, to prevent forged notifications):

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(rawBody, signatureHeader, secret) {
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader ?? "");
  return a.length === b.length && timingSafeEqual(a, b);
}
```

Use the **raw body string** (never a re-`JSON.stringify`'d object — key order changes and the signature
will not verify).

**Feishu custom bot**: its webhook expects its own envelope
(`{"msg_type":"text","content":{"text":"…"}}`), which differs from this MCP's body. Two options:

1. Run a small forwarding service: receive the MCP notification → verify the signature → reshape into
   the Feishu envelope and forward;
2. Use a gateway / serverless function that rewrites the body the same way.

**DingTalk is analogous** (`{"msgtype":"text","text":{"content":"…"}}`, usually with extra signing params).

**Idempotency advice**: dedupe on the receiver by `taskId + status + finishedAt` (the MCP already dedupes
on that key in-process, but delivery can still repeat across restarts or retries — see below).

## 5. Delivery semantics (disclosed honestly)

- **Best-effort, not delivery-guaranteed**: notifications are an observability capability, not a delivery
  guarantee. A failed send only writes a `warn` log — it never reorders the state machine, changes a task's
  terminal state, or blocks any call.
- **Non-blocking**: sending is fully asynchronous (fire-and-forget). A slow or dead endpoint **will not**
  slow the task down.
- **Retries**: total attempts `1 + maxRetries`; network errors, timeouts and non-2xx are all retried;
  backoff is `backoffMs × attempt number`. After exhausting them, one `warn` is logged.
- **What "exactly once" covers**: the MCP dedupes on `taskId + status + finishedAt` **in-process** — repeated
  status writes for the same episode notify once, while a new episode after rework (a changed `finishedAt`)
  notifies again. Across a server restart or a receiver retry, delivery can still repeat, so receivers
  should be idempotent.
- **Redirects are not followed**: `redirect: "manual"` — the endpoint should return 2xx directly.
- **The body may contain project paths**: it includes `projectPath` and local absolute paths to report
  files. Make sure the receiver is trusted (especially when forwarding notifications to a public service).
