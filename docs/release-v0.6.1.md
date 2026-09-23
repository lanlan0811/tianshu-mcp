# tianshu-mcp v0.6.1 发布说明

[English](release-v0.6.1.en.md)

**五项小项扫尾：注释与计数对齐、`capability` 收敛为三族、项目登记失败不再静默、系统目录改为子树拒绝、`cmd` 字符串形态文档化**（[issue #17](https://github.com/lanlan0811/tianshu-mcp/issues/17)）。

本版无新工具、无新适配器、无数据模型变更；五项都是「源码可直证」的小项，合并一次扫尾。

## ⚠ 宿主需知（唯一对外可见的元数据变更）

`verify_task` 的能力分类由 `read` 改为 **`execute`**（它本来就会执行项目配置命令、可能产生构建产物），其 MCP `readOnlyHint` 因此由 `true` 变为 **`false`**：

```jsonc
// tools/list 中 verify_task 的下发值（v0.6.1）
{ "_meta": { "capability": "execute", "requireApproval": false },
  "annotations": { "readOnlyHint": false, "destructiveHint": false,
                   "openWorldHint": false, "idempotentHint": true } }
```

**它仍然免审批**——`requireApproval` 保持 `false`（R11 的「验收不改源码」结论不变）。**若你的策略层硬编码了 `readOnlyHint`**（例如把 `readOnlyHint === false` 一律当成需要用户授权），请改为以 `_meta.requireApproval` 为准，否则会把免审批的验收误当成需授权操作。`docs/tianshu-integration.md` / `.en.md` 的 policy 示例已同步（`verify_task` 现为 `{ "capability": "execute" }`，不再需要宿主手动上调）。

## 本版做了什么

### 1. 系统目录改为「子树拒绝」（issue 问题 4）

此前 `DANGEROUS_ROOTS` 只做**精确相等**匹配：`c:/windows` 挡得住、`c:/windows/system32` 挡不住；`/etc` 挡得住、`/etc/anything` 挡不住。由于 worker 对整个子树可写，这种「只挡根」的语义留下了系统级写入面。

本版把以下目录升级为**边界感知的子树拒绝**（前缀后必须是 `/` 或字符串结束）：

- POSIX：`/etc`、`/usr`、`/bin`、`/sbin`，以及 macOS realpath 形态 `/private/etc`（macOS 的 `/etc` 是符号链接）；
- Windows：`c:/windows`、`c:/program files`、`c:/program files (x86)`。

**有意保留精确匹配的目录**：`/var`、`/tmp`、`/opt`、`/library`、`/system`、`/root`、`c:/users` 与用户主目录——它们之下存在合法工作区。**关键约束**：macOS 的 `os.tmpdir()` 就是 `/var/folders/...`，本项目所有测试项目与大量临时工作区都建在那里，若把 `/var` 按子树拒绝会连带切断测试基座。

边界感知避免误伤：`c:/windows.old`、`/etcetera`、`/usrlocal` 均**不**命中。判定收敛为可注入平台的纯函数 `isDangerousProjectDir(norm, platform)`，因此任意平台都能验证三平台形态（含 macOS 的 `/private/...`）。

### 2. `capability` 收敛为三族语义（issue 问题 2）

`ToolDef.capability` 此前声明四个取值，其中 `"execute"` 与 `"network"` **全工具面零使用**——issue 指出的死分类病灶。

- **删除 `"network"`**：语义未定前不预留（未来真出现网络类工具再加回是向后兼容的）。
- **`verify_task` 由 `read` 改为 `execute`**：它执行项目配置命令、可产生构建产物，本就不是只读。
- 三族语义写进类型定义与 `tools.ts` 头注释：`read`（读/查询，`readOnlyHint: true`）、`write`（有副作用，全部需审批）、`execute`（执行项目命令但不改源码，按 R11 仍免审批）。

新增**真值表测试**：11 个工具 × `capability` × `requireApproval` × 四个 MCP 注解逐格断言，且断言真值表的工具集合与真实工具面一一对应。

### 3. 项目登记失败不再静默（issue 问题 3）

`run_task` 此前把 `registerProject` 的返回值显式丢弃（`void registered;`），紧接着又用 `projectByPath` **二次读取**同一条记录取 `defaultAgentId`：

```ts
// 旧
const registered = await dataHome.registerProject(norm, agentId);
void registered;
const record = (await dataHome.projectByPath(norm)).record;
```

本版直接消费返回值，删掉冗余的二次读取；登记失败时记 `WARN` 并返回**结构化 `isError`**，且**不派单**——杜绝「任务已建、项目未登记」的半状态（否则按项目维度的查询全部失真）。错误文案含「项目登记失败，未派单」前缀，便于调用方区分。

### 4. `cmd` 字符串形态的可用性坑文档化（issue 问题 5）

验收配置的 `cmd` 支持数组与字符串两种形态，但字符串形态走的是极简分词：**不支持转义**，引号不闭合**不报错**，写错会**静默拆成多个 argv**。此前文档只说「也可以写字符串，会被安全分词」，未提示这些坑。

本版在 `docs/acceptance-config.md` / `.en.md` 用一张实测表写明四种典型行为，并在 `schema.ts` / `store.ts` 注释、`SKILL.md`、`usage-examples.md` 补「推荐一律用数组形态」的提示。**实现零改动**，但补了 5 条边界用例把既有分词语义钉死，防止将来改分词器时行为静默漂移。

### 5. 计数与实际对齐（issue 问题 1 收尾）

- `src/mcp/tools.ts` / `server.ts` / `handlers.ts` 三处头注释的「9 个工具」已在 v0.5.8 修正为 11；本版修掉最后一处残留（`test/protocol/protocol.test.ts:3`），并新增 `TOOL_DEFS` 数量硬断言——仅比对名字数组相等时，注册表多一条无人注册的条目不会被拦住。
- 同类病灶一并扫尾：`scripts/check-stdio.mjs` 的场景数自 issue #16 起已是 8，但 `ci.yml` 注释、`HANDOFF`（两处）与 `CONTRIBUTING` 双语仍写「6 场景」，本版同步为 8（README 双语 M10 条目与历史 release 说明是当时事实，保持原样）。

## 测试

- 全量 **940 passed / 12 skipped**（Windows 10 x64，Node 24.18.0；83 文件通过 + 3 真实浏览器文件按设计 skip），较 v0.6.0 的 898 净增 **42** 项：
  - `test/unit/project-dir-guard.test.ts` 16 → 49：新增 `isDangerousProjectDir` 三平台表驱动用例（含 `c:/windows.old`、`/etcetera`、`/private/var/folders/...` 三个关键反例）与 win32 真实目录子树用例；
  - `test/protocol/protocol.test.ts` 10 → 11：新增能力真值表；`verify_task` 的 `readOnlyHint` 断言与取值域同步更新；新增数量硬断言；
  - `test/unit/zcode-handler.test.ts` 16 → 18：登记失败不派单 / 返回值被真正消费（后者断言 `projectByPath` 调用计数为 0，证伪冗余二次读取仍在）；
  - `test/unit/core.test.ts` 5 → 7：`splitCmd` 边界语义锁定与数组形态透传。
- 严格 stdio 门禁 dist 与 src 两条入口各 **8/8**；`pack:check` 通过（232 文件）。

## 文档

- 双语：README（`verify_task` 能力列 + M31 里程碑）、ARCHITECTURE（工具表三族语义 + `readOnlyHint` 推导规则 + §15 新增两条缺口）、SECURITY（§3 危险目录匹配语义 + §5 措辞改准）、`docs/tianshu-integration`（policy 示例 + 宿主需知）、`docs/acceptance-config`（`cmd` 形态警示表）；
- 单语：`SKILL.md` 与 `usage-examples.md` 的能力列与 `cmd` 提示、HANDOFF（0.6.1 交接 + 快照 + M31 + 场景数）；
- 新增 `docs/issue-17-small-fixes-record.md`（Windows 10 实测证据：真值表原始输出、子树判定三平台表、分词边界行为）。

## 未覆盖项

- 危险目录的 **UNC 形态缺口**已在安全渠道另行报告，不在本版公开修复范围；
- `/var`、`/tmp`、`/opt`、`/library`、`/system`、`/root`、`c:/users` 的**子目录**仍不挡（有意取舍，见 ARCHITECTURE §15）；
- `splitCmd` 字符串形态的**最终废弃**需 major/次版本，本版只做文档警示与语义锁定；
- 本机为 Windows，macOS / Linux 的子树形态由纯函数注入 platform 覆盖，真机全量回归由 CI 三平台矩阵兜底。
