# v0.9.8 — 共享 CDP 底座迁址改名（纯重构）

> **把 `TraeworkCdpClient` 从 `traework/` 目录里解放出来，迁到 `src/agents/cdp/client.ts`
> 并改名为 `GuiCdpClient`。本版不删任何 agent，行为零变化。**
>
> 这是「移除 TraeWork 与 Qoder CN」六版计划的第 1 版。它独立成版的唯一目的：
> 先做一次「做错就会一次性打挂 5 个 agent」的高风险重构，用完整回归确认零行为变化，
> 再动删除。

**本版无破坏性变更、无新增参数、工具面不变（仍 8 个工具）、行为零变化。**

---

## 背景：为什么不能直接删 `src/agents/traework/`

`TraeworkCdpClient`（原 `src/agents/traework/cdp/client.ts`）承载的是**通用 CDP 传输**：
WebSocket 连接、`send` 超时、`CdpDisconnectedError` / `CdpUnavailableError` 断线语义、
`listTargets` / `probe` 就绪探测。

它被 **6 个 GUI 适配器**复用：

```text
src/agents/codex/cdp.ts          src/agents/codex/instance.ts
src/agents/zcode/cdp.ts          src/agents/zcode/instance.ts
src/agents/kimicode/cdp.ts       src/agents/minimax/cdp.ts
src/agents/opendesign/cdp.ts     src/agents/qoder/cdp.ts
```

直接 `rm -rf src/agents/traework/` 会一次性打挂 codex / zcode / kimicode / opendesign /
minimax 五个 agent。因此必须先迁址，让传输层与产品名彻底脱钩。

---

## 变更

### 迁址与改名

| 项 | 变更 |
|---|---|
| 文件 | `src/agents/traework/cdp/client.ts` → `src/agents/cdp/client.ts` |
| 类名 | `TraeworkCdpClient` → `GuiCdpClient` |
| 错误类 | `CdpDisconnectedError` / `CdpUnavailableError` **不改名**（语义中性，引用点 20+ 处） |

### 传输层与选择器层分离

迁址后进一步切了一刀，避免「删 TraeWork 的选择器表」波及共享传输：

- **留在 `src/agents/cdp/client.ts`（传输 + 通用原语）**：连接、命令、求值、
  `listTargets` / `probe`、`visibleLabels` 诊断、`clickAt` / `insertText` / `pressKey` /
  `pressEnter` / `pressEscape`，以及新增的**语义中性**存活探针 `probeSignals(candidates)`
  （调用方把自己的候选选择器映射进来，传输层只回答「可见与否」）。
- **留在 `src/agents/traework/cdp/client.ts`（选择器语义层）**：`TraeworkCdpClient`
  现为 `GuiCdpClient` 的子类，只放必须结合 `SELECTORS` 才能成立的
  `exists` / `text` / `click` / `focus` / `center`，以及 `probeLiveness(overrides)`
  （把语义键解析成候选列表后交给 `probeSignals`）与 `interpretLiveness()` 的解读。

这样 0.9.9 删除 `traework/` 时，删掉的是「TraeWork 自己的选择器语义层」，
共享传输一行不动。

### 过渡薄壳

`src/agents/traework/cdp/client.ts` 与 `selectors.ts` 在 0.9.8 期间保留再导出薄壳，
使本版成为**一次纯粹的机械改名**——`src/agents/traework/` 内部的 6 处引用完全不用改，
风险压到最小。0.9.9 删目录时一并去掉。

> 选择器表 `selectors.ts` 按计划本轮留在 `traework/` 不动：它只服务 TraeWork 一个消费者，
> 迁址它没有收益，只会给 0.9.9 多留一个待删文件。

### 消费者的注释同步

`codex` / `zcode` / `kimicode` / `minimax` / `opendesign` / `qoder` 六个适配器里
「在 TraeworkCdpClient 底座之上」「两个 TraeworkCdpClient」这类注释一并改为新类名——
注释里的错误类名同样会把后来者引到错误的方向。

---

## 验证

| 门 | 结果 |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | 0 error |
| `npm run lint`（`--max-warnings 0`） | 0 warning |
| `npx vitest run test/unit test/integration test/protocol` | 全绿（既存 `zcode-rework-loop` 并发 flaky 属既有记录） |
| 逻辑行改动 | **零**——`git diff` 中除 import 行与注释外无逻辑改动（人工复核） |

回归重点：`test/unit/gui-cdp-client.test.ts`（原 `traework-cdp-client.test.ts`，改测传输层）
锁住 `send` 超时、`onclose` 拒绝全部 pending、以及「连接失败文案使用 `appLabel` 指定的应用名」；
`test/unit/traework-client.test.ts`（新增）锁住选择器语义层的 `probeLiveness` 仍是**单次**求值。
各 agent 的既有集成用例（codex / zcode / kimicode / opendesign / minimax / qoder）全部照常通过，
证明传输行为未变。
