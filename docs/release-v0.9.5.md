# v0.9.5 — Kimi Code 模型切换修复版

> **修复「非快捷菜单里的模型永远切不过去」**：Kimi Code 浮层页处于 `hidden` 态时
> **不参与命中测试**——`elementFromPoint(菜单行中心)` 返回的是舞台容器
> `browser-overlay-stage`，而不是那一行。合成点击被容器接收，行上的监听器
> **一次都收不到**；但适配器仍读到 `clicked: true`（坐标算得出来、匹配数也对），
> 于是认为点过了 → 「切换模型」对话框永不出现 → 报 `model_unavailable`
> （"模型不存在"）——把**环境**问题误报成**产品**问题。

**本版无破坏性变更、工具面不变（仍 8 个工具），升级无需改调用方。**

---

## 背景

用户报告「模型一直请求失败」。排查发现：`cline-pass/deepseek-v4.1-flash`
（快捷菜单里的那一项）确实请求失败；换成 `step-plan` 分组的
`deepseek-v4.1-flash` 后，适配器却报 `model_unavailable`——
而该模型在界面上**实际存在且可手动选中**（用户截图确认）。

两者都不是"模型不存在"，而是**唯一入口点不中**：非快捷菜单里的模型
只能经「更多模型…」→「切换模型」对话框切换，而这一步在真机上**时灵时不灵**。

---

## 根因

真机探针（5/5 稳定复现，含 `elementFromPoint` 落点与事件监听器取证）：

| 状态 | `document.visibilityState` | `elementFromPoint(行中心)` | 行上收到的事件 |
|---|---|---|---|
| 复现时 | `hidden` | `OTHER:browser-overlay-stage` | **无** |
| 正常时 | `visible` | `CHILD`（命中行） | `pointerdown,mousedown,mouseup,click` |

**A/B 因果验证**（同一段点击代码，只改页面可见性）：

| 阶段 | overlay 状态 | 落点 | 对话框 |
|---|---|---|---|
| A 保持现状 | `hidden` | `OTHER:browser-overlay-stage` | **未开** |
| B 置前 + 焦点模拟 | `visible` | `CHILD` | **1000ms 打开** |

代码侧原因：`clickAt()` 只对**主窗口**做前置检查
（`if (role === "main") { if (await this.pageHidden()) await this.focusMainWindow(); }`），
**浮层页从未被置前**。而 `ensureOverlay()` 只做 connect + URL 校验，无 focus 步骤。

> **判据陷阱**：`clicked: true` 只代表"坐标算得出来、匹配数唯一"，
> **不代表事件送达**。真实判据只能是点击后的后置条件（对话框是否出现、模型是否回读一致）。

---

## 修复

新增 `focusOverlayWindow()`（与既有的 `focusMainWindow()` 同构）与
`overlayPageHidden()`，并在 `clickAt()` 的浮层分支按**页面自身可见性**决定是否置前：

```ts
try {
  if (role === "main") {
    if (await this.pageHidden()) await this.focusMainWindow();
  } else if (await this.overlayPageHidden()) await this.focusOverlayWindow();
} catch {
  /* 读不到可见性时按可见处理，继续点击（回读仍会如实判定） */
}
```

`focusOverlayWindow()` 的序列：`Page.enable` → `Page.bringToFront` →
`Emulation.setFocusEmulationEnabled` → **等可见性收敛**（以 `visibilityState`
转 visible 为准，而不是盲等固定时长）。

---

## 验证

**回归锁**（新增 2 条）：

1. `浮层页处于 hidden 时，点击「更多模型…」前必须先置前`——先红后绿
2. `浮层页可见时不必置前`——避免无谓的 `bringToFront` 抖动

RED 时的失败信息锁在**被测层**：

```
AssertionError: expected 0 to be greater than 0
 ❯ test/integration/kimicode-flow.test.ts:903:61
   expect(targets.states.overlay.overlayBringToFrontCalls).toBeGreaterThan(0)
```

**反证闭环**：回滚 `clickAt` 的浮层置前分支（保留测试）→ 新用例转红、
另一条保持绿；恢复修复 → 全绿（59 passed）。

**真机端到端**：修复前 **0/5**（连续五次点中但对话框不开）→ 修复后 **4/4**，
其中第 1 次直接命中原缺陷条件（`hidden(菜单开后)=true`）仍成功打开。

**门禁点名文件**：`Test Files 10 passed (10)` / `Tests 162 passed (162)`；
typecheck 绿 / eslint 绿（`--max-warnings 0`）。

---

## 已知问题

1. **本机 `npm test` 链路不可用**：`D:/Tianshu/node-runtime` 的 `node.cmd` shim
   （`"%~dp0tianshu-runtime.exe" %*`）在项目 cwd 下失效，报
   `tianshu-runtime.exe 不是内部或外部命令`。vitest 直调
   （`node node_modules/vitest/vitest.mjs run <file>`）不受影响。
2. **浮层可见性是时序敏感量**：修复以"等收敛"处理，但若产品后续让 overlay
   常驻 `visible`，该分支会自然退化为 no-op（不影响正确性）。

---

## 升级方式

```bash
npm i -g tianshu-mcp@0.9.5
```

或使用 MCP 客户端配置 `npx -y tianshu-mcp@0.9.5`。

**无需改动调用方**——工具面与参数契约均未变化。
