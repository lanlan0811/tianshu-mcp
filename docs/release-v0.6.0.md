# tianshu-mcp v0.6.0 发布说明

[English](release-v0.6.0.en.md)

**加固：技能自检安装的源定位、覆盖语义与三态治理——技能内容只来自包自身，你的本地修改不再被静默替换**（[issue #16](https://github.com/lanlan0811/tianshu-mcp/issues/16)）。

## 问题

`src/util/skill-install.ts` 在启动时把包内技能同步到 `~/.rivet/skills/tianshu-mcp/`，有两处问题（issue 原文的复现步骤可从代码逐字核对）：

1. **cwd 回退源**：`resolveSkillSourceDir()` 的候选链里含 `process.cwd()/skills/tianshu-mcp`（候选 3 与 fallback 共两处）。正常安装下更靠前的候选先命中，但一旦在**非标准布局**下触发（dist 不完整、直接 `tsx` 源跑且 cwd 不在仓库根），当前工作目录下的任意 `skills/tianshu-mcp/` 内容就会被安装进 `~/.rivet/skills/` 并在新会话生效。典型场景：在某个 clone 下来的第三方仓库目录里调试起 server，而该仓库恰好（或刻意）带这个路径结构——技能内容即来自仓库作者而非本包。这是供应链面的经典反模式。
2. **静默覆盖**：目标存在但目录 hash 不一致时，直接把旧目录 `rename` 成 `.bak-<时间戳>` 后整目录覆盖。用户对 `~/.rivet/skills/tianshu-mcp/SKILL.md` 的本地调优（技能本就是给宿主/用户读写的 markdown）在下一次 server 启动时被静默替换回包内版本——有备份、有开关，但覆盖动作本身零提示、零授权。

根因在于：目标目录内**没有任何「我们装的是什么」的记录**，因此现状在原理上无法区分「这份内容是我们装的旧版包」与「这份内容被用户改过」。

## 本版做了什么

### 1. 源定位收敛：技能内容只来自包自身（issue 问题 1）

`resolveSkillSourceDir()` 改为**只**由 `import.meta.url` 相对包自身定位（`<模块>/../../skills/tianshu-mcp`）——源码直跑与 dist 运行的相对深度一致，因此单条候选即够。**删除两处 `process.cwd()` 引用**及一条在任何布局下都不会命中的宽松候选。找不到源时沿用既有「跳过安装 + 告警」路径（issue 确认该路径行为正确）。

`fileURLToPath` 保留（不得改回 `new URL().pathname`——历史上在 Windows 中文/盘符路径下会转义致判定失败，见 `docs/host-integration-record.md`）。

### 2. 安装清单与三类判定（issue 问题 2）

目标目录内维护清单 `<目标>/.tianshu-mcp-install.json`：

```jsonc
{
  "schema": 1,
  "name": "tianshu-mcp",
  "packageVersion": "0.6.0",
  "contentHash": "<sha256 hex>",   // 排除清单自身与平台噪声
  "installedAt": "2026-09-23T…Z",
  "sourceDir": "…\\node_modules\\tianshu-mcp\\skills\\tianshu-mcp"
}
```

`contentHash` 由内容 + 相对文件名算出，**排除清单自身**（否则写清单即自证被改动）与平台噪声（`.DS_Store`、`Thumbs.db`、`desktop.ini`、`._*`、`.git*`）——macOS 宿主写入 `.DS_Store` 不会被误判为「用户修改」。拷贝用同一排除谓词，保证「装完立即算 hash == 源 hash」（幂等的根因）。

据此六态判定：

| 目标状态 | 判定 | 默认（`auto`）行为 |
|---|---|---|
| 不存在 | 首次安装 | 安装 + 写清单 |
| 内容 == 包内 | 一致 | 跳过（清单缺失/陈旧则补写/校准，不改技能文件） |
| 清单记录 == 目标内容 ≠ 包内 | **未改动的旧版包副本（可信）** | 备份 + 覆盖（`WARN`） |
| 清单记录 ≠ 目标内容 | **用户本地修改（确证）** | **保留 + 强告警**，给出两条处置指引 |
| 无有效清单且内容 ≠ 包内 | **来源不明** | **保留 + 告警**，提示放行方式 |
| 目标是文件/不可读 | 同「来源不明」 | 同上 |

只有「可信旧版」会在默认配置下自动覆盖；一旦检出你改过文件，**绝不会**被静默替换。

### 3. 三态开关与放行入口

- `skills.autoInstall`：`true`（默认）｜`"prompt"`｜`false`（既有 boolean 继续合法，无需迁移）。`"prompt"` = 首次安装照常，**需变更时不自动覆盖**，只告警并在清单记 `pendingUpdate`。stdio server 没有同步交互通道，所以「prompt」实为「不自动 + 留待确认」。
- `--approve-skill-update`（或 `TIANSHU_MCP_APPROVE_SKILL_UPDATE=1`）：本次启动允许把「需变更」的技能目录覆盖为包内版本（先备份）。**对已确证含用户本地修改的目录不生效**——那类只能人工改名/删除后重启，或手工合并改动。
- 优先级：`--no-skill-install` / `autoInstall:false` 的否决权**高于**放行参数。
- `skills.backupKeep`（默认 3，`0` = 不清理）：覆盖成功后按时间戳保留最新 N 个 `.bak-<时间戳>`。

### 4. 安装原子化

改为「拷贝到 `<目标>.incoming-<ts>-<hex>`（含写清单）→ 旧目录备份为 `<目标>.bak-<ts>` → 换入」；失败清理临时目录并回滚备份。启动时另清理 mtime 早于 1 小时的 `.incoming-*` 崩溃残留。旧实现「先 rename 旧目录、再直接往目标拷贝」的崩溃窗口会留下半拷贝目录——在新语义下会被误判为「用户修改」而永久阻塞升级，故必须一并关掉。

### 5. 日志分级

跳过 / 补写清单 = `INFO`；覆盖旧版 / 保留用户修改 / 来源不明 / 安装失败 = `WARN`。便于检索的稳定短句：`含本地修改`、`来源不明`、`未自动覆盖`。hash 只打印前 8 位。

## 升级影响（务必一读）

本版**不修改技能内容**（`skills/tianshu-mcp/` 未动），因此：

- **没改过技能文件的用户**：升级后启动走「内容一致 → 跳过」，行为无感；只是会补写一份安装清单。
- **改过技能文件的用户**：升级后启动会看到一条 `WARN`（`检出技能目录含本地修改…已保留你的版本、未做覆盖`）与两条处置指引——① 以包内版本为准 → 改名或删除该目录后重启；② 保留改动 → 手工把改动合并进包内副本后再重启。**你的改动不会被覆盖**。
- 从 v0.5.10 及以前升级上来、目标目录无清单的情形归为「来源不明」：默认保留 + 告警；确认可覆盖时用 `--approve-skill-update`。

> 备份积压收敛：本机历史累积的 `.bak-*` 会在 v0.6.0 之后**首次发生覆盖**时按 `backupKeep`（默认 3）收敛到最近 3 个。若不希望删除历史备份，请在升级前把 `skills.backupKeep` 设为 `0` 或先手工另存。

## 门禁与证据

- 新增单元用例 30 项（`test/unit/skill-install.test.ts`）：源定位（含 cwd 同名诱饵回归、源码文本断言）、hash 排除、清单解析、六态判定矩阵 × 模式 × 放行、真实 fs 端到端（首次/幂等/清单自愈/可信覆盖/用户修改保留/`prompt` 保留与 `pendingUpdate`/放行覆盖/失败回滚/备份收敛/非匹配项不删/残留清理/日志分级/源缺失）、真实技能目录冒烟。
- `config-hotreload` 补 `skills.autoInstall` 三态与 `skills.backupKeep` 默认/覆盖/非法值用例。
- 严格 stdio 门禁新增 `skill-locally-modified` / `skill-approve-update` 两场景（6→8），dist 与 src 两条入口均 8/8 通过。
- **Windows 10 真机复验** R1–R7 全绿，原始输出见 [issue #16 加固记录](issue-16-skill-install-hardening-record.md)。
- 全量 **898 passed / 12 skipped**；类型检查、lint（`--max-warnings 0`）、构建、`pack:check` 全部通过。

## 兼容性

- **配置**：`skills.autoInstall` 的 `true`/`false` 语义不变（默认仍为 `true`），新增 `"prompt"` 取值与 `skills.backupKeep`；旧 `config.json` 无需改动。
- **CLI**：仅新增 `--approve-skill-update`，既有 `--no-skill-install` 行为不变。
- **工具面**：11 个 MCP 工具与所有返回契约**零变更**。
- **运行时**：技能内容未变；安装目标仍为 `~/.rivet/skills/tianshu-mcp`（不扩多宿主目录）。

相关文档：[项目 README](../README.md)｜[CHANGELOG](../CHANGELOG.md)｜[架构说明](../ARCHITECTURE.md)｜[安全策略](../SECURITY.md)｜[交接文档](../HANDOFF.md)
