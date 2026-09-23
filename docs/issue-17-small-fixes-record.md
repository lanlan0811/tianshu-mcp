# issue #17 五项小项扫尾：验证记录

- 日期：2026-09-23
- 平台：Windows 10 x64（`win32 10.0.19045`）/ Node v24.18.0
- 被测版本：**v0.6.1**（`dist/index.js`，由 `npm run build` 产出）
- 关联 issue：[#17](https://github.com/lanlan0811/tianshu-mcp/issues/17)
- 计划文档：`.zcode/plans/issue-17-small-fixes-plan.md`（本地 only，gitignore）
- 发布说明：[v0.6.1](release-v0.6.1.md)

> 本文件为**中文单语物证记录**，与 `docs/issue-16-skill-install-hardening-record.md` 同类（HANDOFF 已声明此类调试物证无英文版）。

## 覆盖范围

| 编号 | issue 诉求 | 本版处置 | 证据 |
|---|---|---|---|
| Q1 | 头注释「9 个工具」漂移 | 源码三处已在 v0.5.8 修好；本版修 `protocol.test.ts:3` 残留 + 新增数量硬断言 + 全量核对 | §1 |
| Q2 | `capability` 死分类（`execute`/`network` 零使用） | 删 `network`；`verify_task` 由 `read` 改 `execute`；真值表测试 | §2 |
| Q3 | `registerProject` 返回值被吞 | 消费返回值去掉冗余二次读取；登记失败结构化返回且不派单 | §3 |
| Q4 | `DANGEROUS_ROOTS` 仅精确相等 | 系统目录改边界感知子树拒绝；判定抽为可注入平台的纯函数 | §4 |
| Q5 | `splitCmd` 字符串形态可用性坑 | 双语文档 + schema/代码注释警示；5 条边界用例锁定语义 | §5 |
| 附加 | 计数与实际不符（同类病灶） | `ci.yml` / `HANDOFF` / `CONTRIBUTING` 双语的「6 场景」同步为 8 | §6 |

## 1. Q1 —— 工具计数

全仓 `9 个工具` 搜索只剩 `test/protocol/protocol.test.ts:3` 一处（已改为 11）。README / ARCHITECTURE / HANDOFF / SKILL / `server.ts` 的 MCP `instructions` 逐处核对，**均已是 11，无需改动**。

新增硬断言（`test/protocol/protocol.test.ts`）：

```ts
expect(TOOL_DEFS).toHaveLength(tools.tools.length);
expect(new Set(TOOL_DEFS.map((d) => d.name)).size).toBe(tools.tools.length);
```

> 仅比对名字数组相等时，`TOOL_DEFS` 多一条无人注册的条目不会被拦住；这两条把「注册表与真实工具面一一对应」变成 CI 可拦的契约。

## 2. Q2 —— capability 真值表（实测 `tools/list` 原始输出）

真实子进程拉起 `dist/index.js --no-skill-install`，`initialize` → `tools/list` 抓取下发值（**非读代码推断**）：

| 工具 | capability | requireApproval | readOnlyHint | destructiveHint | openWorldHint | idempotentHint |
|---|---|---|---|---|---|---|
| `run_task` | write | true | false | false | **true** | **true** |
| `continue_task` | write | true | false | false | false | false |
| `query_task` | read | false | **true** | false | false | false |
| `list_tasks` | read | false | **true** | false | false | false |
| `get_task_report` | read | false | **true** | false | false | false |
| `cancel_task` | write | true | false | **true** | false | false |
| `verify_task` | **execute** | false | **false**（v0.6.1 变更） | false | false | **true** |
| `rework_task` | write | true | false | **true** | false | false |
| `get_profiles` | read | false | **true** | false | false | false |
| `prepare_visual_baseline` | write | true | false | false | false | false |
| `approve_visual_baseline` | write | true | false | **true** | false | false |

原始片段（`verify_task`）：

```json
{ "name": "verify_task", "capability": "execute", "requireApproval": false,
  "readOnlyHint": false, "destructiveHint": false, "openWorldHint": false, "idempotentHint": true }
```

**宿主需知**：`readOnlyHint` 由 `true` 变 `false`（`server.ts` 按 `capability === "read"` 推导）。**审批不受影响**（`requireApproval` 恒为 false）。策略层若硬编码 `readOnlyHint` 需改以 `_meta.requireApproval` 为准——已写入 `docs/tianshu-integration` 双语、CHANGELOG 双语、release 说明双语与 ARCHITECTURE 双语 §4/§15。

## 3. Q3 —— 项目登记

- 代码：`handlers.ts` 用 `registerProject` 返回的 `record` 取代原先 `void registered;` + `projectByPath` 二次读取；登记抛错时 `logger.warn` + `errorResult`（不派单）。
- 用例 A（`test/unit/zcode-handler.test.ts`）：`registerProject` 抛 `EPERM: 写 projects.json 失败` → `isError === true`、文案含「项目登记失败 / 未派单 / EPERM」、`submissions` 为空。
- 用例 B：`registerProject.record.defaultAgentId = "zcode"`，而假 `projectByPath` 故意返回 `"codex"` → 断言提交的 `agentId === "zcode"` **且 `projectByPathCalls === 0`**。后半条是关键：只有计数为 0 才能证明冗余的二次读取真的被删掉。

## 4. Q4 —— 危险目录子树拒绝

判定为可注入平台的纯函数 `isDangerousProjectDir(norm, platform)`，因此在 Windows 开发机上即可验证三平台形态。实测输出（`isDangerousProjectDir` 直接调用）：

```
DENY   c:/windows                       (win32)
DENY   c:/windows/system32              (win32)
DENY   c:/Windows/System32              (win32)
DENY   c:/program files                 (win32)
DENY   c:/program files/app             (win32)
DENY   c:/Program Files (x86)/App       (win32)
DENY   c:/                              (win32)
DENY   c:/users                         (win32)
DENY   d:                               (win32)
DENY   d:/                              (win32)
DENY   /etc                             (linux)
DENY   /etc/passwd                      (linux)
DENY   /usr                             (linux)
DENY   /usr/local/src                   (linux)
DENY   /bin                             (linux)
DENY   /bin/x                           (linux)
DENY   /sbin                            (linux)
DENY   /sbin/x                          (linux)
DENY   /private/etc                     (darwin)
DENY   /private/etc/foo                 (darwin)
DENY   /                                (linux)
DENY   /var                             (linux)
DENY   /tmp                             (linux)
DENY   /private/var                     (darwin)
allow  c:/windows.old                   (win32)
allow  /etcetera                        (linux)
allow  /usrlocal                        (linux)
allow  c:/users/name/repo               (win32)
allow  d:/proj                          (win32)
allow  /private/var/folders/x/y/T/tmp   (darwin)
allow  /var/folders/x/y/T/tmp           (darwin)
allow  /var/log                         (linux)
allow  /tmp/xxx                         (linux)
allow  /Users/name/repo                 (darwin)
allow  /home/user/repo                  (linux)
allow  /opt/app                         (linux)
```

三个必须放行的反例（边界感知前缀 / 合法工作区）都在上表末端：

- `c:/windows.old`、`/etcetera`、`/usrlocal`：**同前缀但不是子树**，若用朴素 `startsWith` 会被误伤；
- `/private/var/folders/x/y/T/tmp`、`/var/folders/x/y/T/tmp`：**macOS 的 `os.tmpdir()`**，正是本项目所有测试项目与临时工作区的基座——`/var` 若按子树拒绝会连带切断测试基座。

真实目录形态另有一条集成断言：`assertSafeProjectDir("C:/Windows/System32")` 在 Windows 上必须抛错。既有「`/tmp`（或 macOS `/var/folders`）下的真目录必须放行」用例保留，作为 macOS 回归的守门用例。

## 5. Q5 —— splitCmd 语义锁定（实测行为）

`splitCmd` 实现未改（零行为变更），5 条边界用例把既有行为钉死：

| 输入 | 期望输出 | 锁定的语义 |
|---|---|---|
| `npm run a b` | `["npm","run","a","b"]` | 无引号按空白拆 |
| `  spaced   out  ` | `["spaced","out"]` | 首尾/连续空白折叠 |
| `npm run "unclosed arg` | `["npm","run","\"unclosed","arg"]` | **引号不闭合不报错** |
| `node "a\"b"` | `["node","a\\","b\""]` | **无转义**：`\` 是普通字符 |
| `cmd "" empty` | `["cmd","","empty"]` | 空引号产出空参数 |

另有一条断言数组形态经 `toAcceptanceDef` 原样透传（不经分词）。文档侧：`docs/acceptance-config.md` / `.en.md` 新增警示表，`src/config/store.ts` 与 `src/config/schema.ts` 注释改写，`SKILL.md` 与 `usage-examples.md` 补提示。

## 6. 附加 —— 场景数 6→8

`scripts/check-stdio.mjs` 的 `baseScenarios()` 自 issue #16 起已有 8 个场景，但 `ci.yml` / `HANDOFF`（两处）/ `CONTRIBUTING` 双语仍写「6 场景」。活文档已同步为 8（README 双语的 M10 里程碑条目与 8 份历史 release 说明是**当时事实**，按计划 D18 保持原样）。

## 7. 门禁与测试结果

全部在本机 Windows 10 x64 / Node v24.18.0 实测：

| 检查 | 命令 | 结果 |
|---|---|---|
| 静态检查 | `npm run lint` | ✅ 0 warning（`--max-warnings 0`） |
| 类型 | `npm run typecheck` | ✅ clean |
| 全量测试 | `npm test` | ✅ **940 passed / 12 skipped**（83 文件通过 + 3 真实浏览器文件按设计 skip，共 86 文件）；较 v0.6.0 的 898 净增 **42** 项 |
| 构建 | `npm run build` | ✅ 成功；`src/version.generated.ts` 同步为 `0.6.1` |
| stdio 门禁（dist） | `npm run check:stdio` | ✅ **8/8** |
| stdio 门禁（src） | `npm run check:stdio:src` | ✅ **8/8** |
| 打包 | `npm run pack:check` | ✅ 通过（232 文件） |

新增用例分布（净增 42）：

- `test/unit/project-dir-guard.test.ts`：16 → **49**（+33：三平台形态表驱动 36 条中的新增部分 + win32 子树集成用例）
- `test/unit/zcode-handler.test.ts`：16 → **18**（+2：登记失败 / 返回值被消费）
- `test/protocol/protocol.test.ts`：10 → **11**（+1：能力真值表；原 readOnlyHint 用例改写）
- `test/unit/core.test.ts`：5 → **7**（+2：边界语义锁定 / 数组形态透传）

## 8. 未覆盖项（如实记录）

1. **UNC 形态的危险目录缺口**：issue 原文写明「已在安全渠道另行报告」，本次不夹带（渠道隔离）。
2. **`/var`、`/tmp`、`/opt`、`/library`、`/system`、`/root`、`c:/users` 的子目录仍不挡**：有意取舍（macOS 临时目录），残留边界记入 ARCHITECTURE 双语 §15 与 SECURITY 双语 §3。
3. **`splitCmd` 字符串形态的最终废弃**：需 major/次版本，本版只做文档警示 + 语义锁定测试。
4. **路径闸门的端到端 stdio 场景**：按计划 D9 只做单测，`check-stdio` 场景数维持 8。
5. **macOS / Linux 真机**：本机无 macOS / Linux 设备，子树判定的三平台形态由纯函数注入 platform 覆盖（§4），但**未在真实 macOS / Linux 文件系统上跑过全量测试**——由 CI 的三平台矩阵兜底。
6. **天枢宿主策略层**：`capability` 的实际消费在宿主机侧，本仓只保证下发的 `_meta`/`annotations` 自洽（真值表锁定）。
