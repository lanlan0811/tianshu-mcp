# S7 二次整改真实 Tianshu serve 会话复测记录（2026-09-08）

- 修复基线：S1–S6 全部落地（build version=0.1.3，本地 dist 已重建）
- 会话：真实 rivet serve（RIVET_HOME 独立临时目录，deepseek-v4-pro）；MCP 1 server connected, 8 tools
- 验证目标：新 build 下 P1 缺陷（无理由取消落 cancelled）在真实 agent 会话中的端到端表现

## 1. server 版本（S4 单一版本源修复验证）

真实会话中协议层返回（MCP initialize）：
```
server version: {"name":"tianshu-mcp","version":"0.1.3"}
```
修复前错误声明 0.1.0；现与 package.json / registry / tag 一致 = 0.1.3。

## 2. 无理由取消真实复测（S1）

agent 在真实会话中执行：`run_task`(stub, 600s sleep) → 立即 `cancel_task`（不传 reason）→ 轮询到终态。

agent 实测时间线：
- 任务创建 01:36:09.345Z；stub-agent 进程 spawn 01:36:09.844Z
- 取消请求打在 01:36:15.821Z；进程 01:36:16.287Z 以 `code=1 (killed)` 终止（取消→被杀 ~466ms）
- 命中的是**真实运行中的进程**（存活 6444ms，非已结束任务）

agent 判定：
> `abortSource=user` 表明中止来源是用户侧主动取消，而非超时或系统回收。

修复前该场景会错误落 `interrupted`；S1 后稳定落 **cancelled + abortSource=user + cancelRequestedAt**（query meta 与 task.json 均含，formatter 已透传）。

## 3. 局限与说明

- serve runtime 会话机制与桌面 GUI 共用同一 runtime 与 MCP 工具注册；自动化集成测试（cancel-noreason.test.ts）在 Windows 上对运行中/排队中/验收/返修阶段无理由取消均有断言。
- 二次复测发现并修复的序列化缺口：query_task 的 meta 原不包含 `cancelRequestedAt`/`abortSource`，仅落盘 task.json。已补 formatter 透传，测试断言 `final.cancelRequestedAt` 与 `final.abortSource` 均通过。

## 4. 结论

S1（无理由取消 → cancelled）与 S4（服务版本单一源）在真实 Tianshu serve 会话中得到端到端验证；相关自动化回归测试 72/72 绿。
