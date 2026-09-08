# v0.1.9 发布说明

- 版本：`tianshu-mcp@0.1.9`
- 日期：2026-09-09
- 英文版：[release-v0.1.9.en.md](release-v0.1.9.en.md)

## 发布重点

本版本修复 TraeWork 仍在长时间思考时被 MCP 提前判定完成并关闭实例的问题。完成判定现在遵循：

1. 字面「思考中」与原生 `ask_user` 状态；
2. 停止按钮 `.chat-input-v2-send-button-stop-icon` 或在途任务尾部 `.core-task-tail--loading`；
3. 无运行信号时的完成标志「由AI生成」；
4. 达到稳定轮数后再持续 `idleTimeoutMs` 无变化，才返回 `idle`。

`.thinking-stream-content` 只记录诊断信息，不会阻塞结束，因为历史消息可能保留该节点。所有新选择器均支持
profile 覆盖；未命中时失败开放，退回完成标志与空闲计时。

## 连接与实例安全

- CDP WebSocket 的 `close` / `error` 会立即拒绝全部待处理请求。
- 单次 CDP 命令默认 15 秒超时；轮询与取消、任务截止时间竞争，取消最多约 1 秒生效。
- 只有 `completion_mark` / `ask_user` 会释放本模块启动的实例。
- `idle_no_completion`、`timeout`、`aborted`、`cdp_lost` 会保留实例，任务 meta 暴露
  `agentEndReason` 与 `keptInstance`，便于 `query_task` 和后续排障。
- 轮询默认每 30 秒写入一条进度事件；运行信号持续很久只告警，不改变等待行为。
- 服务关闭与基线采集重叠时，不再用短暂的 `queued` 状态推断用户取消，只认结构化取消意图。

## 新配置

| 字段 | 默认值 | 说明 |
|---|---:|---|
| `gui.idleTimeoutMs` | `600000` | 达到稳定轮数后，无变化且无运行信号的空闲等待时长 |
| `gui.cdpSendTimeoutMs` | `15000` | 单次 CDP 命令等待响应的上限 |
| `gui.progressIntervalMs` | `30000` | 任务进度事件间隔 |

## 验证

- 单元测试覆盖运行信号优先级、空闲计时、运行信号清零、thinking stream 非阻塞和存活真值表。
- CDP 客户端测试覆盖命令超时、断线拒绝全部 pending 及探针选择器表达式。
- 假 CDP 集成测试覆盖完成标志与运行信号冲突、空闲、超时、CDP 断线和实例保留策略。
- 发布门禁：`typecheck && lint && test && build && pack:check`；30 个测试文件、196/196 通过。
- 真机验证：实时 DOM 探针、长任务、极短超时和正常短任务，记录见本次交付结果与 `HANDOFF.md`。

## 安装

```bash
npm install -g tianshu-mcp@0.1.9
```
