# v0.9.6 — MiniMax Code 真机修复版

> **修复 MiniMax Code 的两处真机缺陷 + 一处验收层假成功风险**：
> ① 项目已在侧栏时点选恒失败（盘符归一闪序错）；
> ② 子菜单档位/窗口切换回读太早（固定 sleep），实测 **1/8 成功**；
> ③ 非 git 仓库下 `requireChanges` 零变更门禁被**静默跳过**，验收照判 PASS。

**本版无破坏性变更、工具面不变（仍 8 个工具），升级无需改调用方。**

---

## 背景

对 MiniMax Code（3.1.0.170）做第二轮真机冒烟，模型 `M2.7` / `M3.1-Flash-Preview`，
工作区为一个**非 git 仓库**的普通目录。6 轮新建任务全程 `succeeded`，
但过程中暴露了三处缺陷——其中两处在适配器层，一处在通用验收层。

---

## 缺陷 ①：点选既有项目分组恒失败（盘符归一闪序错）

`projectPointExpression` 的页面内路径归一是：

```js
const norm = s => (s || '').replace(/[\/]+$/, '')
  .replace(/^([a-z]):/, (m, d) => d.toUpperCase() + ':')   // 先盘符大写
  .toLocaleLowerCase();                                     // 又被整体小写抵消
```

那句「盘符大写」**恒被后一步抵消**（死代码）。而 Node 侧 `normalizeProjectPath`
顺序相反：**先整体小写、再恢复盘符大写**。两侧对同一目录分别得 `d:\...` 与 `D:\...`，
**永不相等** → `hit.length !== 1` → 表达式返回 `null` → `clickProjectByPath` 返回
`clicked:false` → 报「项目面板里命中条目但点击未生效」（`setup_failed`）。

**触发条件**：项目**已在侧栏**时。首轮走「创建项目」模态框路径不经过这里，
首轮成功后项目进了侧栏，**第二轮才暴露**。

真机取证：修复前表达式返回 `null`，修复后返回 `{x:119.5, y:308}`。

---

## 缺陷 ②：子菜单切换回读太早（固定 sleep）

`pickOption` 点击后只等固定 `sleep(350)` 就回读，读到旧值即抛
「上下文窗口切换回读不一致：期望「1M」，实际「512K」」→ `model_mismatch` 硬失败。

真机**定量复现 1/8 成功**，且同一轮内连续观测证明**点击其实生效了**：

```
+350ms  → 512K   ← 旧实现据此报失败
+1550ms → 1M     ← 实际早已切成功，只是慢
```

改为**有界轮询至收敛**（读到目标值即返回，超时才报错）。真机复验 **6/6**，
实测收敛耗时 234–599ms——正是 350ms 固定等待覆盖不到的范围。

---

## 缺陷 ③：非 git 仓库下 `requireChanges` 静默降级

`--auto-verify` 跑验收，`requireChanges` 默认 `true`，报告却写：

```
[INFO] requireChanges=true，但项目不是 git 仓库，零变更门禁已跳过。
[INFO] 项目不是 git 仓库，未做变更清单/diffstat 分析。
结论: [PASS]
```

同一份报告里 `changedFiles: []`、`diffstat: +0 -0`。**用户以为开着零变更保护，
实际在非 git 工作区被静默丢弃**——agent 若什么都没产出，验收照样判 PASS。

**判定行为不变**（非 git 仓库算不出基线，不拦截是有意设计，已有测试锁定），
本版只改**可见性**：同一事实双写，`warnings` 让它进 `[WARN]` 与报告摘要。

| | 修复前 | 修复后 |
|---|---|---|
| 报告摘要 | 「…diffstat +0 -0。」 | 「…diffstat +0 -0；**告警 1 条**。」 |
| 报告正文 | 仅 `[INFO]` 一行 | 新增 `[WARN] …该工作区没有任何「任务是否产出」的自动保护：请人工确认产物，或把项目纳入 git。` |

---

## 附带加固

`hoverModel` 失败现场原本只留 `hoverModel elapsed=9630ms`，无法区分
「菜单没开」「开的是别的窗口」「子菜单归属不对」「子菜单容器为空」。
新增 `menuDiagnosticsExpression` + `cdp.menuDiagnostics()`，失败时**先记日志再抛错**。
真机验证：hover 前 `targetMenuCount=0`、hover 后 `=1`。

---

## 新增脚本

`scripts/smoke-minimax.mjs`——MiniMax 此前只有只读 `probe-minimax.mjs`，没有 smoke。
新脚本经真实 MCP 工具面驱动 `run_task → query_task → manage_task` 完整闭环，
比 kimi 版多 `--context-window`（MiniMax 子菜单的第二个维度）。

---

## 验证

| 项 | 结果 |
|---|---|
| 新增测试 | 4 个文件 14 个用例（project-point 4 / submenu-settle 4 / menu-diagnostics 5 / acceptance +1）|
| RED→GREEN→反证 | 三处缺陷均先红后绿，回滚修复后转红（测试有辨别力）|
| 真机（M2.7） | 6 轮新建任务全绿，4 份 Markdown 产物全部达标（每节 2 段）|
| 真机（M3.1-Flash-Preview） | 修复后连续 3 轮 + 5 轮全绿；产物 SVG 2160–3800 B、128×128、XML 合法 |
| 回归 | minimax 单测 136 passed；受影响验收测试 45 passed；typecheck 绿；lint 绿 |

---

## 已知未复现（如实记录）

`openModelMenu` 与 `hoverModel` 各出现 1 次间歇超时（共 11 轮 smoke），
独立探针（含 CPU 施压、无间隔连跑、复刻完整前序序列）**均无法复现**，
**未定位根因、未修复**；本版仅补齐了失败现场的可诊断信息，供后续复现时定位。

---

## 升级方式

```bash
npm i -g tianshu-mcp@0.9.6
```

或使用 MCP 客户端配置 `npx -y tianshu-mcp@0.9.6`。

**无需改动调用方**——工具面与参数契约均未变化。
