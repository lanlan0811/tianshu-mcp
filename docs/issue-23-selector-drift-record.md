# issue #23 验证记录：GUI Agent 选择器版本漂移（codex / qoder / traework）

- 日期：2026-09-23
- 版本：v0.6.2（0.6.1 → 0.6.2）
- 关联 issue：[#23](https://github.com/lanlan0811/tianshu-mcp/issues/23) `GUI Agent 选择器版本漂移报告（codex / qoder / traework 三例实证）`
- 计划：`.zcode/plans/issue-23-gui-selector-drift-plan.md`
- 本机环境：Windows 10 64 位；Codex 桌面端 **26.915.4065.0**（`OpenAI.Codex_26.915.4065.0_x64__2p2nqsd0c76g0`）；Qoder CN **0.3.4**（`D:\Qoder CN`，与 issue 报告版本一致）；TraeWork / TRAE SOLO CN 注册表 DisplayVersion **0.1.64**（文件版本 2.3.82597，`D:\TRAE Work CN\TRAE SOLO CN.exe`）

本文件中文单语（按 AGENTS.md：计划/证据记录类文档无需双语）。功能类文档（README / ARCHITECTURE / CHANGELOG / release 说明 / docs/*-cdp）走双语。

---

## 1. 三例结论速览

| 例 | issue 假设 | 真机复核 | 处置 |
|---|---|---|---|
| C1 Codex | 文案从「切换项目」漂移至「选择项目」 | **部分成立**：本机 26.915 仍为「切换项目」；issue 报告 26.917 为「选择项目」 | 主/回退并列覆盖两文案；其余 19 键全量审计 |
| C2 Qoder | 菜单「即使点中也从不渲染」 | **被推翻**：0.3.4 菜单**正常渲染**；真因是页面有**两个** `[data-workspace-picker-trigger]`，旧 `click()` 要求唯一命中而判歧义 | 主选择器改用**唯一**的 aria-label；行为修复经真机 e2e 验证 |
| C3 TraeWork | 缺 discovery.ts + 目录写成 `{APPDATA}` | **成立**（并补充）：`{APPDATA}\TRAE SOLO CN` 实为**用户数据目录**（Cache/Crashpad/嵌套工具 exe），非安装位置 | 新增 `traework/discovery.ts` + 修正 profile + 端口未就绪诊断 |

> 关键更正：issue 对 C2 的结论（「菜单内容从不渲染」）在本机同版本上**不可复现**。真实根因是选择器歧义。这解释了为何「点中真实按钮后 8 秒轮询仍无菜单」——**旧实现根本没点到输入栏 picker**，而是因可见匹配数为 2 直接判歧义、点击从未执行（或落在错误按钮上）。

---

## 2. C1：Codex 全量 20 键审计（`scripts/probe-codex.mjs --launch audit`）

运行命令：
```
node scripts/probe-codex.mjs --launch audit
```

审计在真实 26.915 页面上逐键执行生产解析器（`__codexResolve(specArgs(key))`），输出 primary 命中数与命中标签：

| # | 键 | 26.915 命中(可见/总) | 命中标签（截断） | 处置 |
|---|---|---|---|---|
| 1 | `chatInput` | 1/1 | 随心输入 | ✅ 提 `26.915.x` |
| 2 | `sendButton` | 1/1 | 发送 | ✅ 提 `26.915.x` |
| 3 | `stopButton` | 0/0 | — | 空闲态正常为 0；维持（条件渲染） |
| 4 | `userGate` | 0/0 | — | 默认禁用；维持 |
| 5 | `newChat` | 52/97 | 新对话… | ✅ 提 `26.915.x` |
| 6 | `projectSection` | 51/96 | 项目/最近… | ✅ 提 `26.915.x` |
| 7 | `addProject` | 2/2 | 添加新项目 | ✅ 提 `26.915.x` |
| 8 | `projectPickerTrigger` | 1/1 | **切换项目：tianshu-mcp** | ✅ 并列兼容两文案 |
| 9 | `projectItem` | 9/16 | `… 的项目操作` | ✅ 提 `26.915.x`（未漂移） |
| 10 | `newProjectMenuItem` | 4/5 | 文件/编辑/视图/帮助 | 需弹层；维持 |
| 11 | `sourceFolderArea` | 0/0 | — | 需对话框；维持 |
| 12 | `createProjectButton` | 0/0 | — | 需对话框；维持 |
| 13 | `modelTrigger` | 1/1 | 6 Luna 中… | ✅ 提 `26.915.x` |
| 14 | `reasoningSlider` | 0/0 | — | 需模型菜单展开；维持 |
| 15 | `modelMenuItem` | 0/0 | — | 同上；维持 |
| 16 | `menuItem` | 0/0 | — | 同上；维持 |
| 17 | `permissionTrigger` | 1/1 | 更改权限 | ✅ 提 `26.915.x` |
| 18 | `permissionOption` | 0/0（显示 1 为触发器命中） | — | 需权限菜单展开；维持 |
| 19 | `loginIndicator` | 0/0 | — | 已登录；维持 |
| 20 | `messageArea` | 9/20 | 会话正文… | ✅ 提 `26.915.x` |

**审计结论**：本机 26.915 上，**除 `projectPickerTrigger` 外全部业务关键键 primary 命中 > 0**，未发现额外漂移（issue 点名的 `projectItem` 经实测**未漂移**）。唯一样本外的漂移是 issue 报告的 26.917 触发器文案，已用主/回退并列兜住。

---

## 3. C2：Qoder 0.3.4 真机重探（**结论更正**）

### 3.1 关键 DOM 事实（本机 0.3.4）

- 输入栏 picker：`BUTTON[data-workspace-picker-trigger]`，`aria-label="切换或清空当前工作区，当前为 <名>"`，带 `aria-expanded`。
- **另有第二个** `BUTTON[data-workspace-picker-trigger]`（`aria-label` 为 null，文本同为工作区名）。
- **可见 `[data-workspace-picker-trigger]` 计数 = 2** → 旧 `click()` 的「可见匹配数必须 === 1」判定直接判歧义。
- 「新的任务」入口为 `A[data-e2e="chat.new"]`（选择器本身未漂移）。
- 点中输入栏 picker 后：`[role="menu"][data-state="open"]` = 1、`input[aria-label="搜索工作区"]` = 1（placeholder「搜索名称或路径」）→ **菜单正常渲染**。

### 3.2 生产 `bindWorkspace` 真机 e2e（修复后）

复刻 `run.ts` 流程（前置窗口 → 新建任务 → bindWorkspace）：

```
已绑定工作区: C:\Users\...\tianshu-qoder-custom-验收-KDDKal
=== bindWorkspace(target=D:\Trae项目\tianshu-mcp) ===
  stage ok: workspace-menu
  stage ok: workspace-search
  stage ok: workspace-selected
OK bindWorkspace；boundWorkspace= D:\Trae项目\tianshu-mcp
```

修复前（旧 primary `[data-workspace-picker-trigger]`）：
```
FAIL bindWorkspace: Error: qoder_control_missing_or_ambiguous: [data-workspace-picker-trigger] ;
   页面可见候选=[… 工作区 | … ]
```

### 3.3 处置

- `workspace.primary` 改为唯一的 `button[aria-label^="切换或清空当前工作区"]`；`[data-workspace-picker-trigger]` 降为回退。
- 新增 `workspaceMenu` 键（`[role="menu"][data-state="open"]` 等），放宽「菜单已打开」判定为「搜索框 **或** 浮层」。
- 诊断：解析失败时附页面可见候选（§4）。

> 说明：Qoder 0.3.4 其余键（模型/权限/消息容器等）沿用既有实测值；本次只重构为分层结构 + 修工作区这一例。0.3.4 上「新的任务」需窗口可见才能 trusted 点击（`document.hidden` 时点击被忽略）——这是既有约束，非本次漂移，未改。

---

## 4. C3：TraeWork 安装发现 + 端口诊断

### 4.1 旧路径为何必然失配（实证）

```
APPDATA = C:\Users\Lenovo\AppData\Roaming
APPDATA/TRAE SOLO CN exists?  true   ← 旧内置目录
LOCALAPPDATA/Programs/TRAE SOLO CN exists?  false
```

`{APPDATA}\TRAE SOLO CN` 目录内容（前若干项）：`Backups / Cache / CachedConfigurations / CachedData / Code Cache / Crashpad / DevToolsActivePort / ModularData/ai-agent/vm/tools/app/7zip/7z.exe …`——这是**用户数据目录**，不是安装目录。旧代码把安装目录猜成 Roaming 下的同名目录，自然找不到 `TRAE SOLO CN.exe`。

### 4.2 新增 discovery 的真机结果

```
$ node -e "import('./dist/agents/builtin.js').then(...)  discoverTraework(BUILTIN_PROFILES.traework)"
RESULT = {"path":"D:\\TRAE Work CN\\TRAE SOLO CN.exe","source":"fixed-drive","version":"2.3.82597"}
```

强制走注册表路径（清空 preferredDrives/relativePaths/dirs）：
```
REGISTRY ROUTE = {"path":"D:\\TRAE Work CN\\TRAE SOLO CN.exe","source":"registry","version":"2.3.82597"}
```

注册表卸载信息实测存在：`DisplayName=TraeWork CN (User)`、`InstallLocation=D:\TRAE Work CN\`、`DisplayVersion=0.1.64`。

### 4.3 文件名收窄

Windows 只认 `TRAE SOLO CN.exe`——旧 `fileNames` 含 `Trae CN`，而 `D:\Trae CN\Trae CN.exe` 实为**另一产品** TraeCode CN（注册表 `TraeCode CN (User)` v3.3.104），会误匹配。

### 4.4 端口未就绪诊断

`diagnosePortFailure()` 在 `waitReady` 超时时输出：启动子进程是否存活/退出码（`code=0` → 提示 single-instance 交接）、命令行含该端口的进程数、未带调试端口的既有进程数。**只诊断，不改启动策略、不终止既有实例**（沿用误杀事故后的安全红线）。

---

## 5. 统一诊断机制（issue「机制」建议）

新增 `src/agents/gui-diagnostics.ts`，三 GUI agent 共用：

- `visibleLabelsExpr()`：页面内表达式，收集可见、带 aria-label 或短文本的交互元素（去重、截断 20 条、异常安全降级）。
- `formatCandidates()` / `withDiagnostics()`：渲染/追加「页面可见候选=[…]」后缀（幂等）。

接入点：Codex（`run.ts` 触发器失败 + `cdp.ts` 点击失败）、Qoder（`cdp.ts` 点击失败 + `workspace.ts` 菜单超时）、TraeWork（`run.ts` 渲染超时 + `cdp/client.ts`）。

真机示例（本次 Qoder 失败路径即输出）：
```
qoder_control_missing_or_ambiguous: [data-workspace-picker-trigger] ; 页面可见候选=[收起左侧栏 | 后退 | … | 工作区 | … | 新建工作区 | …]
```

---

## 6. 测试

- 新增用例：
  - `test/unit/gui-diagnostics.test.ts`（8）：采集/过滤/去重/scope/异常降级/格式化幂等。
  - `test/unit/qoder-selectors.test.ts`（6）：分层结构完整性、候选顺序、`workspace` 唯一主选择器回归。
  - `test/unit/traework-discovery.test.ts`（7）：名称收窄、显式/固定盘/注册表/标准目录/快捷键/顺序。
  - `test/unit/traework-launcher.test.ts`（+4）：`diagnosePortFailure` 四种分支。
  - `test/unit/codex-core.test.ts`（+1，改 1）：触发器双文案兼容 + `boundProjectName` 双文案回读。
- 全量：`npm test` → **966 passed / 12 skipped**（86 文件；v0.6.1 为 940，净增 26）。
- 失败修订：`qoder-workspace-controls`（选择器改多候选后桩改为按候选集合匹配）、`traework-selectors`（`verified`→`verifiedVersion`）。

---

## 7. 门禁结果

| 门禁 | 命令 | 结果 |
|---|---|---|
| 构建 | `npm run build` | ✅ |
| 类型 | `tsc -p tsconfig.build.json` | ✅ |
| Lint | `npm run lint` | ✅ 0 error |
| 单测/集成/协议 | `npm test` | ✅ 966 passed / 12 skipped |
| stdio 场景 | `npm run check:stdio` | ✅ dist 8/8、src 8/8 |
| 打包 | `npm run pack:check` | ✅ |
| Codex 20 键审计 | `node scripts/probe-codex.mjs --launch audit` | ✅ 关键键全命中 |
| Qoder 真机 e2e | 生产 `bindWorkspace`（0.3.4） | ✅ workspace-menu/search/selected 全过 |
| TraeWork discovery | `discoverTraework(BUILTIN_PROFILES.traework)` | ✅ fixed-drive / registry 双路命中 |
| CI 四平台 | `.github/workflows/ci.yml` | 见发布提交 |

---

## 8. 残留与未覆盖

- Codex **26.917 触发器文案**未在本机复现（本机为 26.915）；以 issue 报告为准，用并列候选兜住，待有 26.917 环境者可复跑审计确认。
- Codex 条件渲染键（`stopButton`/`reasoningSlider`/`modelMenuItem`/`menuItem`/`permissionOption`/`sourceFolderArea`/`createProjectButton`）在审计时未展开对应菜单/对话框，故记为「需交互」，未提 `verifiedVersion`。
- TraeWork **CDP 端口从未就绪**：本机未完整复现该失败（discovery 修复后端口路径未再走失败分支），诊断已就位但根因（single-instance 锁 / 参数 / 环境）留待真机复现时定位。
- Qoder 0.3.4 其余键（模型/权限/消息）未逐一真机复验，沿用既有 `0.3.4` 标注；`workspaceMenu` 其余回退形态（`[data-workspace-menu]` 等）为前瞻候选，未实测。
- Qoder macOS、TraeWork macOS 仍为 `research`，不在本版范围。
