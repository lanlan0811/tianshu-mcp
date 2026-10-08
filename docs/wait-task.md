# 阻塞等待原语：`wait_task`（issue #28；v0.9.0 合并 `wait_any`）

英文版：wait-task.en.md

`run_task` 是异步契约：秒回 `taskId`，不阻塞 `tools/call`。但目标调用方（天枢桌面端的 agent 会话）是**回合驱动**的——agent 只在收到用户消息的回合内执行，回合之间不运行，它**无法自行轮询**。于是在「回合驱动调用方 + 长任务」的组合下，工具面漏掉了任务完成时刻：过去每次任务完成都**必须人工发一条消息**触发查询。

本能力补上这个空白：`wait_task` 用**一次阻塞式只读调用**承载「等」这个动作，任务到达停点时返回，无需用户干预。单任务传 `taskId`，批量传 `taskIds`（等待数组顺序首个停者）——v0.9.0 起两个模式合并为一个工具。

## 一、为什么必须是「阻塞等待」

服务端推送（`notifications/progress` 等）不可依赖：宿主 MCP 工具**只回文本**（`content[].text`）、**按次同步**调用 `tools/call`、不消费服务端推送（见 README「运行时契约」C1/C2）。因此「等」只能由**一次工具调用**承载——阻塞等待是工具面唯一可行的形态。

它与 webhook 通知（[issue #22](notifications.md)）**互补、不重复**：webhook 的接收端是外部 HTTP 端点（人 / 机器人），结果不回流到 MCP 会话；`wait_task` 把结果送**回到发起调用的那个会话**。

## 二、停点定义

`wait_task`（两种模式）等待的「可返回点」是**停点**：

```text
isWaitSettled(status) = isTerminal(status) || status === "needs_user"
```

- `isTerminal`：`succeeded` / `failed` / `needs_attention` / `cancelled` / `interrupted`。
- `needs_user`：**非终态**，任务已停止推进、在等人工处理（agent 提问 / 登录 / 环境处理），需 `continue_task` 恢复。

**为什么 `needs_user` 也是停点**：任务真正停止推进的时刻 = 调用方应当被唤醒的时刻。若不等它，任务进 `needs_user` 后 wait 会一直空等到 timeout，调用方**在超时前对「任务在等人」一无所知**——而这恰是需要立刻转达用户的状态。

## 三、工具契约

### `wait_task(taskId, timeoutMs?)`

阻塞等待**单个**任务到达停点或超时。

| 入参 | 必填 | 说明 |
|---|---|---|
| `taskId` | 是 | 目标任务 id |
| `timeoutMs` | 否 | 本次等待上限（ms）；缺省 `50000`、上限 `600000`，超上限被**钳制并在正文披露** |

返回：文本（停点行 / 状态行 / 后续动作指引）+ meta 块，meta 含 `waitSettled`（是否到停点）与 `waitedMs`（实际等待时长）。

### 批量模式：`wait_task(taskIds, timeoutMs?)`

阻塞等待**一组**任务中**数组顺序首个**到达停点者。

| 入参 | 必填 | 说明 |
|---|---|---|
| `taskIds` | 是 | 1..20 个任务 id；开始前校验全部存在，**缺一即 fail-closed 报错并列出缺失 id** |
| `timeoutMs` | 否 | 同单任务模式 |

> 单任务模式与批量模式**必须且只能提供一个**：两者都缺或都给，会返回明确错误。

返回：到达停点的那一个任务的快照 + meta 块，正文另列出**全部任务当前状态行**。

> 返回「数组顺序首个已停」而非「完成时间最早」：确定性、可预测，避免 `finishedAt` 缺失 / 相同时的排序歧义。

## 四、超时矩阵

| 调用 | `timeoutMs` 取值 | 行为 |
|---|---|---|
| `wait_task`（两种模式） | 省略 | 使用默认 `50000ms`（低于生态常见 60s 客户端超时，留序列化 / 往返余量） |
| 同上 | 传 ≤ 600000 | 按传入值等待 |
| 同上 | 传 > 600000 | **钳制到 600000ms**，并在响应正文**如实写明**「已钳制到上限」 |
| 同上 | 等待到期仍未到停点 | 返回**当前快照** + 「请再次调用本工具继续等待」指引（`waitSettled=false`） |

`timeoutMs` 必须是正整数（schema 层拒绝 0 / 负数 / 非整数）。

## 五、循环模式

长任务（30–50 分钟）靠**循环调用**覆盖：每轮 ≈50s，直到停点或用户打断。

### 5.1 单任务（成功 → 读报告）

```text
run_task(...) → taskId
wait_task(taskId, timeoutMs=50000)
  → 任务已到停点（等待 37 秒）：状态: [PASS] 任务成功
  → get_task_report(taskId)
```

### 5.2 超时续等

```text
wait_task(taskId, timeoutMs=50000)
  → 等待超时（50 秒）：状态: 运行中（agent 正在开发）。任务本体不受影响；
     请再次调用 wait_task 继续等待，或用 query_task 查看细节。
wait_task(taskId)          # 再次调用即续等（无损）
  → …直到停点
```

### 5.3 needs_user 循环

```text
wait_task(taskId)
  → 任务已到停点（等待 12 秒）：状态: 等待用户处理（可用 continue_task 恢复）。
     请用 continue_task 恢复，恢复后再次调用 wait_task 继续等待。
# 用户在客户端处理（回答问题 / 登录 / 关旧实例…），然后：
continue_task(taskId, message="已处理")
wait_task(taskId)          # 恢复后继续等（needs_user 可多次进入）
```

### 5.4 多任务先到者

```text
wait_task(taskIds=[tsk_a, tsk_b, tsk_c], timeoutMs=50000)   # 批量模式
  → 已有任务到达停点（等待 8 秒）：tsk_b —— 状态: [FAIL] 任务失败
     全部任务当前状态：…
```

## 六、无损保证

`wait_task` / `wait_any` 是**纯只读**操作（`capability: "read"`、免审批、MCP `readOnlyHint: true`）：不写任何任务状态、不动任务本体。被客户端截断、连接中断、超时返回——**任何路径都不影响任务继续执行**；最坏结果只是调用方多调几次，重连后 `query_task` 即拿到最新事实。

等待期间**其他工具调用照常**（SDK 请求处理互不阻塞，已实测）：

```text
[probe] slow 发出后 +200ms；fast 返回耗时 = 215ms（期望 ~200ms，远小于 3000ms）
[probe] 结论 = 请求互不阻塞（并发处理）
```

因此等待期间 `cancel_task` / `query_task` / `get_profiles` 正常处理；连接 / 请求被取消时，等待循环经 SDK 注入的 `extra.signal` **立即退出**，不泄漏后台等待。

## 七、FAQ

**问：超时会怎样？**
任务零影响。wait 是只读的，超时只返回「当前快照 + 请再次调用」；调用方在同一回合内连续多次调用即可（每轮 50s，30–50 分钟任务 ≈ 40–60 次）。

**问：任务进入 `needs_user` 怎么办？**
wait 会把 `needs_user` 当停点返回（不会空等到超时）。让用户在客户端处理完后，`continue_task` 恢复，**再调一次 `wait_task`** 继续等——`needs_user` 可多次进入，循环模式天然覆盖。

**问：客户端单次 `tools/call` 超时更短（如 30s）怎么办？**
把 `timeoutMs` 调到略低于该超时（例如 20000ms）。即便被截断也无害：调用方再次调用即可续等。

**问：多个任务要一起等？**
用 `wait_any`。它按 `taskIds` 数组顺序返回首个到停点者，并列出全部任务当前状态。

**问：server 重启后原来的 wait 调用呢？**
等待是**进程内**的：重启后原 wait 调用随连接终止。调用方重连后用 `query_task` 复核——历史遗留任务在启动时已被归档为 `interrupted`，wait 对已终态任务**立即返回**。

## 八、已知限制

- 等待是**进程内**的：server 重启后原 wait 调用随连接终止（调用方重连后 `query_task` 复核）。
- 单次调用等待上限 **600s**（常量）；更长场景靠循环调用（无损）。
- `wait_any` 不识别「完成时间最早」，只按数组顺序返回首个已停任务。
- 默认值 `50000ms` 是面向「客户端超时未知」的保守值；如你的客户端单次工具超时更短，按 §五调整。
