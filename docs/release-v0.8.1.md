# v0.8.1 — 完成判定不再把「还在跑」判成「已完成」（issue #31）

> 详见 [CHANGELOG](../CHANGELOG.md#081---2026-10-06)。

## 本版主题：让「未观测到运行信号」只走 idle_timeout

四个 driver（ZCode / Kimi Code / MiniMax Code / Open Design）的 `finished` 判据此前只看
`stable >= stableRounds`，**不要求本轮见过运行信号**，而 Codex 自始就有该门。当停止按钮 /
loading 选择器漂移时，界面会「看起来静止」——进行中的任务会在
`stableRounds × pollInterval`（默认约 12s）后被判成成功并进入验收 / 返修链。这正是「误判任务成功」
的落点。

关键证据：这四个 driver 的 `PollState` 结构里**根本没有该维度**（只有 `hash/stable/idleSince`），
而 Codex 的带 `sawRunning`——不是「忘了加判断」，是这个信号在类型层面就不存在。同时
`ARCHITECTURE.md` §8.3 流程图第 4 档本来就写明「始终未观测到运行信号 → `idle_timeout`」：
**本版是让实现回到既有架构约定**，不是新增语义。

## 修复一：四个 driver 补上「曾观测到运行信号」前置门

| driver | 运行信号集合 | `finished` 判据变化 |
|---|---|---|
| ZCode | `stopVisible \|\| loading \|\| activeTool` | `sawRunning && stable >= stableRounds && inputEnabled` |
| Kimi Code | `stopVisible \|\| sendStarting` | `sawRunning && stable >= stableRounds && assistantText.trim()` |
| MiniMax Code | `stopVisible` | 同上形式 |
| Open Design | `stopVisible \|\| sendStarting` | `sawRunning && stable >= stableRounds && conversationText.trim()` |

四个 `PollState` 新增 `sawRunning`：运行分支置真、其余构造点透传。**始终未观测到运行信号只允许
收敛为 `idle_timeout`**（异常结束、保留实例）。

**MiniMax Code 是 issue 未列出的第五个违反点**——其 `liveness.ts` 与 Kimi / Open Design 完全同构，
同期（2026-10-05）落地，属遗漏，本版一并修复。

## 修复二：fix-loop 让这些 driver 的异常结束真正转 needs_attention

**只改 driver 不足以闭环。** `fix-loop.ts` 的 `idle_timeout → needs_attention` 白名单此前
**只含 `zcode` / `codex`**；其余三个 driver 的 `idle_timeout` 因 `autoVerify` 默认为 `true`
（`src/server.ts:81`）而绕过该文件的两个 `!autoVerify` 出口，**仍会进入项目验收链**。
即：只加门的话，用户看到的是「任务仍然进验收，只是迟了 10 分钟」。

现判定抽为可独立测试的纯函数 `shouldParkAsNeedsAttention()`，五个已接入的 GUI driver 一律落
`needs_attention`（非终态、可 `continue_task` 恢复）。

## 修复三：发送确认阶段的运行信号现传给观察循环

执行期由集成测试逼出的同族缺陷。发送确认循环（点击发送后的有界观察窗口）本就会 `poll()` 并把
运行信号累加进各 driver 的 `seenRunning`，但该变量**只用于「发送是否确认」判据，从未传给观察循环**。
加门后，若选择器漂移、或 turn 在观察循环开始前已跑完，观察循环整段采不到信号 → 已启动的任务
判不了完成。而发送确认阶段恰恰是「本轮确实已启动」**最可靠的证据来源**。

四个 driver 现经 `ObserveArgs.sawRunningSeed` 传递该信号。ZCode 的 `seenRunning` 混有
「对话文本发生变化」（非运行信号），故单独以 `sawRunningAtSend` 只累加真实信号。

> 这条比 issue 描述的更深一层：不只缺门，还缺门所需证据的传递路径。

此外，`reobserve`（`user_confirmation` 恢复）轮会**种子** `sawRunning`——被观察的 turn 在恢复前
已确认在运行，不种子会导致「恢复后 turn 恰好已完成 → 判不了 finished → 误落 idle_timeout」。
ZCode 无 `reobserve` 通路（`continue + !sendMessage` 仍补发任务书），不需要该种子。

## 行为边界

- **正常完成的任务行为不变**：先出现运行信号、再静止 → 仍判 `finished`。
- 选择器采不到运行信号时，收敛时间从约 12s 变为 `idleTimeoutMs`（默认 10 分钟）后落
  `needs_attention`。这是 `ARCHITECTURE.md` §8.3 的既定语义，非本版引入。
- **Open Design 的产物指纹（`artifactSignature`）不计入运行信号**（issue 建议中该句的后半段未采纳）：
  它是静止判据的**底料**，而 `opendesign/run.ts` 的 `fetchArtifactForSummary` 在 `finished`
  终态**之后**仍会写文件。把它当运行信号会让「已完成但正在搬产物」永远判不了完成。
- 本版**不含 mcp-gui（日志台）的任何改动**——GUI 走独立版本线 `gui-v*`（当前 `0.1.1-beta.4`）。

## 验证

- 契约测试 `test/unit/liveness-running-gate.test.ts`（14 例）：四组不变量——「全程无运行信号 →
  不得判 `finished`」（四 driver + Codex 对照组）、「曾观测到运行信号后仍正常判完成」、
  「reobserve 种子」、「发送阶段信号必须传给观察循环」。
- `test/unit/fix-loop-abort-parking.test.ts`（5 例）：三个新纳入 driver 的 `idle_timeout` 落在
  `needs_attention` 集合内，成功终态绝不落入该分支。
- **反例验证**：把 zcode 的门回滚，契约测试立即变红（1 failed）——测试真的在测那个门。
- 集成回归：`zcode-flow` 81/81、`kimicode-flow` 51/51。
- 全量 unit 93 文件 / 1263 用例通过；全量 integration 35 文件 / 348 通过 / 0 失败。
- `tsc --noEmit` / ESLint `--max-warnings 0` / `build` / `check:stdio` 全通过。

## 已知限制

- **本版为纯函数与编排层修复，未做真机验证**：四个 driver 的选择器采集层未改动。真机取证
  （`npm run probe:zcode|kimicode|minimax|opendesign`）需已登录的 GUI 实例，待下次真机批次补做。
- **MiniMax Code 的降级风险（已知、已接受）**：其 `stopVisible` 依赖的
  `[data-testid="stop-button"]` 来自产物常量提取、**真机未复验**（见 `minimax/liveness.ts` 文件头
  「待复验」）。若该 testid 实际不存在，加门后 MiniMax 每个任务都会收敛为 `idle_timeout` →
  `needs_attention`。这是有意的 fail-closed：`needs_attention` 可 `continue_task` 恢复，
  而误判成功不可逆。真机取证应优先覆盖此项。

## 鸣谢

- @jian-in（issue #31）：准确定位四个 driver 的判据差异并给出逐行证据，使根因确认在数分钟内完成。
