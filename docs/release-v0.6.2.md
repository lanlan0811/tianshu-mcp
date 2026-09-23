# v0.6.2 — GUI Agent 选择器漂移修复（codex / qoder / traework）

> 关联 issue：[#23](https://github.com/lanlan0811/tianshu-mcp/issues/23)。详见 [issue #23 验证记录](issue-23-selector-drift-record.md)。

## 修复

- **Codex：项目选择触发器文案漂移（26.917）**。触发器 `aria-label` 在部分版本为「选择项目：<名>」、部分（本机实测 26.915）仍为「切换项目：<名>」。现主/回退/模板并列覆盖两文案（含英文 `Select/Switch project`），任一命中即可；`boundProjectName` 的项目名回读同步兼容。**并完成全量 20 键真机审计**（`probe-codex.mjs audit`）：本机 26.915 除该触发器外无其他漂移，9 个已实测键的 `verifiedVersion` 提升为 `26.915.x`。

- **Qoder：选择器分层化 + 工作区绑定真机修复（0.3.4）**。`src/agents/qoder/selectors.ts` 由扁平字符串升级为与 Codex 同构的分层结构（`primary/fallbacks/texts/ariaLabels/ariaPatterns/verifiedVersion`，共 27 键），新增 `qoderCandidates()`；`QoderCdpClient` 保留 `selector()` 字符串语义，另增 `candidates()/existsKey()/clickKey()`（按候选顺序"先探测后点击"，多候选不浪费超时预算）。
  **真机重探更正了 issue 的结论**：0.3.4 工作区菜单**并非不渲染**——真因是页面存在**两个** `[data-workspace-picker-trigger]`，旧 `click()` 要求唯一命中而判歧义失败。工作区触发器主选择器改用唯一的 `button[aria-label^="切换或清空当前工作区"]`，`[data-workspace-picker-trigger]` 降为回退；"菜单已打开"判定放宽为"搜索框 **或** 浮层（`[role=menu][data-state=open]`）"。**生产 `bindWorkspace` 已在真实 Qoder 0.3.4 上跑通**（workspace-menu → workspace-search → workspace-selected → 路径回读一致）。

- **TraeWork：新增 `discovery.ts` + 修正安装目录 + 端口诊断**。新增 `src/agents/traework/discovery.ts`（复用 zcode/qoder 的固定盘枚举 + 注册表 InstallLocation + 相对路径逻辑），`registry.ts` 增加 `traework-gui` 专用分支。修正内置 profile：删除错误的 `{APPDATA}/TRAE SOLO CN`（实测该目录是**用户数据目录**，含 Cache/Crashpad/嵌套工具 exe，非安装位置），改为 `{LOCALAPPDATA}/Programs/TRAE SOLO CN` 等；补 `preferredDrives:["D:"]` 与 `relativePaths:["TRAE Work CN/TRAE SOLO CN.exe"]`。**Windows 文件名收窄为只认 `TRAE SOLO CN.exe`**——旧清单含 `Trae CN`，会误匹配另一产品 TraeCode CN。`waitReady` 超时新增现场诊断（子进程退出码、端口监听者枚举、既有未带调试端口实例检测），**只诊断、不改启动策略、不终止既有实例**。

## 新增

- **三 GUI agent 统一的选择器诊断**（`src/agents/gui-diagnostics.ts`）：选择器解析失败时，把页面可见候选标签（最接近的 aria-label / 短文本）一并写进错误与日志，使用者一步定位漂移，无需人工开 CDP。已接入 codex / qoder / traework。
- **Codex 全键审计模式**：`scripts/probe-codex.mjs --launch audit` 对全部 20 个语义键输出 primary 命中数与命中标签，作为「脚本 + 证据表」门禁。
- **TraeWork 选择器版本字段统一**：`verified: boolean` → `verifiedVersion: string`（与 codex/kimicode 一致），四 GUI agent 漂移报告口径统一。

## 测试

- 新增 26 个单元用例：`gui-diagnostics`（8）、`qoder-selectors`（6）、`traework-discovery`（7）、`traework-launcher` 诊断（4），以及 `codex-core` 触发器/回读双文案（新增 1、改写 1）。
- 全量 `npm test`：**966 passed / 12 skipped**（v0.6.1 为 940，净增 26）。
- 真机证据见 [issue #23 验证记录](issue-23-selector-drift-record.md)。

## 兼容性

- 无工具契约、数据模型或 MCP 注解变更；纯 GUI 适配层修复与诊断增强。选择器覆盖（`agent-profiles.json` 的 `gui.selectors`）语义不变（单字符串覆盖优先）。
