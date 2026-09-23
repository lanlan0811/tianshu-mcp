# issue #16 技能自装加固：Windows 10 真机验收记录

- 日期：2026-09-23
- 平台：Windows 10 x64（`win32 10.0.19045`）/ Node v24.18.0
- 被测版本：**v0.6.0**（`dist/index.js`，由 `npm run build` 产出）
- 关联 issue：[#16](https://github.com/lanlan0811/tianshu-mcp/issues/16)
- 计划文档：`.zcode/plans/issue-16-skill-install-hardening-plan.md`（本地 only，gitignore）
- 发布说明：[v0.6.0](release-v0.6.0.md)

> 本文件为**中文单语物证记录**，与 `docs/issue-1-host-reconnect-record.md`、`docs/m2-*.md` 等同类（HANDOFF 已声明此类调试物证无英文版）。

## 复验范围

真实 `USERPROFILE`（因此 `os.homedir()` 指向真实用户目录、技能目标是真实 `~/.rivet/skills/tianshu-mcp`），数据目录隔离到临时目录以免污染真实日志。每步以真实子进程拉起 `dist/index.js`，采 stderr 全文后按 stdin EOF 正常关闭并核对退出码。

| 步骤 | 操作 | 期望 | 结果 |
|---|---|---|---|
| R1 | 目标无清单、内容与包内一致时启动 | 走「一致 → 跳过」，补写清单；源为包内路径 | ✅ |
| R2 | 追加一行到目标 `SKILL.md` 后启动 | `WARN 含本地修改`；文件保留；无新 `.bak`；无 `.incoming` | ✅ |
| R2b | R2 基础上加 `--approve-skill-update` | **仍不覆盖**（D9 硬边界）；无新 `.bak` | ✅ |
| R3 | 把目标目录改名后启动 | `技能已安装到 …`；生成新目录与新清单；内容与包内 hash 相等 | ✅ |
| R4a | 删清单 + 改内容（来源不明）后默认启动 | `WARN 来源不明`；内容保留；无新 `.bak` | ✅ |
| R4b | 来源不明 + `--approve-skill-update` | `WARN 授权覆盖`；内容替换为包内；生成 `.bak`；写入清单 | ✅ |
| R5 | 覆盖后检查历史 `.bak-<时间戳>` | 收敛到最近 3 个（`backupKeep` 默认 3）；无 `.incoming` 残留 | ✅ |
| R6a | `--no-skill-install` 启动 | stderr 无任何技能相关日志 | ✅ |
| R6b | `TIANSHU_MCP_NO_SKILL_INSTALL=1` 启动 | 同上 | ✅ |
| R7 | macOS | 本机无 macOS 设备 → 未覆盖 | ⚠️ 记录为未覆盖项 |

每一步退出码均为 `0`，stdout 均无内容（仅为便于断言；协议合规性由 `check:stdio` 8/8 场景独立覆盖）。

## 原始输出（节选）

### R1 —— 内容一致 → 跳过 + 清单补写

```
tianshu-mcp v0.6.0 真机复验（issue #16）
平台：win32 10.0.19045 / Node v24.18.0
真实技能目标：C:\Users\Lenovo\.rivet\skills\tianshu-mcp
包内技能源：D:\Trae项目\tianshu-mcp\skills\tianshu-mcp

[INFO] 技能安装清单已补写（C:\Users\Lenovo\.rivet\skills\tianshu-mcp\.tianshu-mcp-install.json）：包版本 v0.6.0，内容 hash 7561a2fd。
[INFO] 技能已安装且内容一致，跳过（C:\Users\Lenovo\.rivet\skills\tianshu-mcp）。
[清单存在] true
[清单] packageVersion=0.6.0 contentHash=7561a2fd…
[dest hash == repo hash] true
[bak 数] 3  [incoming 残留] 0
```

### R2 —— 用户本地修改 → 保留 + 告警（不覆盖）

```
[WARN] 检测到技能目录含本地修改：C:\Users\Lenovo\.rivet\skills\tianshu-mcp（内容 hash 98cd7776 ≠ 清单记录 7561a2fd），包内版本 v0.6.0；已保留你的版本、未做覆盖。
[WARN] 处置方式二选一：① 以包内版本为准 → 把 …\tianshu-mcp 改名或删除后重启 server（会自动重装）；② 保留改动 → 手工把改动合并进包内副本后再重启。注意 --approve-skill-update 对含本地修改的目录不生效。
[本地标记仍在] true
[bak 数 before=3 after=3（应相等）]
[incoming 残留] 0
```

### R2b —— 含本地修改 + `--approve-skill-update` → 仍不覆盖（D9）

```
[WARN] 检测到技能目录含本地修改：…（内容 hash 98cd7776 ≠ 清单记录 7561a2fd）…
[本地标记仍在] true
[bak 数 before=3 after=3（应相等）]
```

### R3 —— 目录改名后重启 → 自动重装 + 新清单

```
[INFO] 技能已安装到 C:\Users\Lenovo\.rivet\skills\tianshu-mcp（新会话生效，无热加载）。
[新目录存在] true
[清单存在] true
[dest hash == repo hash] true
```

### R4a —— 来源不明 → 保留 + 告警

```
[WARN] 技能目录与包内版本不一致，且无有效安装清单可证未改动（来源不明）：C:\Users\Lenovo\.rivet\skills\tianshu-mcp；已保留现有内容、未覆盖。
[WARN] 确认可覆盖时带 --approve-skill-update 重启 server（覆盖前先备份到 .bak-<时间戳>）。
[来源不明标记仍在] true
[bak 数 before=3 after=3（应相等）]
```

### R4b + R5 —— 放行覆盖 + 备份收敛（3 个预置备份 → 保留最新 3）

```
[WARN] 技能已按 --approve-skill-update 授权覆盖：C:\Users\Lenovo\.rivet\skills\tianshu-mcp → 备份 C:\Users\Lenovo\.rivet\skills\tianshu-mcp.bak-1790165939523 → 包内版本 v0.6.0（新会话生效）。
[INFO] 技能备份清理：保留最近 3 个，已删除 1 个（…tianshu-mcp.bak-1790088613973）。
[来源不明标记已消失] true
[dest hash == repo hash] true
[收敛后 bak 列表] tianshu-mcp.bak-1790127947401, tianshu-mcp.bak-1790165860816, tianshu-mcp.bak-1790165939523
[收敛后 bak 数] 3
[incoming 残留] 0
```

> 更早的一轮手工复验从本机原有 **9 个** 历史备份起步，`授权覆盖` 一步「保留最近 3 个，已删除 7 个」，同样收敛到 3 个（该轮的 9 个备份在复验前已完整另存隔离，未发生不可逆丢失）。

### R6 —— 两条关闭路径均无技能日志

```
（--no-skill-install）
[INFO] tianshu-mcp 已连接（stdio）。数据目录: …，工具数: 11
[INFO] 收到 stdin EOF，开始关闭：归档活动任务并终止子进程…
[无技能日志] true

（TIANSHU_MCP_NO_SKILL_INSTALL=1）
[无技能日志] true
```

## 配套门禁（同版本，均通过）

| 门禁 | 结果 |
|---|---|
| `npm run typecheck` / `npm run lint`（`--max-warnings 0`） | ✅ |
| `npm test`（全量） | ✅ **898 passed / 12 skipped**（较 v0.5.10 净增 33 项） |
| `npm run check:stdio`（dist 入口，8 场景） | ✅ 8/8 |
| `npm run check:stdio:src`（src 入口，8 场景） | ✅ 8/8 |
| `npm run build` | ✅ 版本三方一致（`package.json` / `package-lock.json` / `src/version.generated.ts` = 0.6.0） |
| `npm run pack:check` | ✅ 只含 `dist`/`skills` 等白名单；`scripts/seed-skill-state.mjs`（dev-only 夹具）不进包 |

新增/扩展用例分布：

- `test/unit/skill-install.test.ts`：30 项（源定位 3 / hash 与清单 4 / 判定矩阵 6 / 端到端 15 / 真实目录冒烟 1，含子断言）。
- `test/unit/config-hotreload.test.ts`：新增 1 项（`skills.autoInstall` 三态与 `backupKeep` 默认/覆盖/非法值）。
- `scripts/check-stdio.mjs`：新增 `skill-locally-modified`、`skill-approve-update` 两场景。

## 未覆盖项与边界（如实记录）

1. **macOS 真机未验证**（本机为 Windows 10，无设备）。依据：本模块无平台分支（`os.homedir()` 与 `path` 已跨平台，路径经 `fileURLToPath` 处理）；`.DS_Store` / `._*` 排除为预防性设计，由单测 B1/B1b 覆盖。macOS 的 `.bak` 收敛与换入原子性未在真机观察。
2. **多宿主技能目录未实现**：安装目标仍只有 `~/.rivet/skills/tianshu-mcp`（如 ZCode / Codex 各自的技能目录），issue 未涉及，另开 issue 讨论。
3. **`"prompt"` 不是交互式确认**：stdio server 无同步交互通道，`"prompt"` 实为「不自动 + 留待确认」；宿主级确认 UI 属未来方向。
4. **不处理符号链接策略**：`hashSkillTree` / 拷贝对 symlink 走跟随读取，未特殊处理（与旧实现一致）。
5. **备份清理只碰精确模式**：`<SKILL_NAME>.bak-<数字>` 目录；`tianshu-mcp.bak-abc`、`tianshu-mcp.bak-1789.old`、名为 `tianshu-mcp.bak-999` 的**文件**一律不动（单测 D10）。`~/.rivet/skills/brainstorming/` 等非本模块产物不受影响。

## 结论

issue #16 的两个问题在本机真实环境均按期望修复并留证：源定位只来自包自身（R1 的 `sourceDir` 指向包内 `skills/tianshu-mcp`）、用户本地修改不再被静默覆盖（R2/R2b）、来源不明默认保留且可显式放行（R4a/R4b）、覆盖原子化且历史备份受控收敛（R5）。R1–R6 全部通过，R7（macOS）如实记为未覆盖项。
