# v1.0.0-beta.2 — 测试与脚本面收口

> **删除两个已移除 agent 的探针/冒烟脚本与 CDP 文档，同步打包与 CI 必需清单。**
>
> 这是「移除 TraeWork 与 Qoder CN」六版计划的第 5 版。

**本版无行为变化。**

---

## 移除

```text
scripts/probe-traework.mjs   scripts/smoke-traework.mjs
scripts/probe-qoder.mjs      scripts/smoke-qoder.mjs
docs/traework-cdp.md         docs/traework-cdp.en.md
docs/qoder-cdp.md            docs/qoder-cdp.en.md
docs/qoder-evidence/         (目录)
```

四个脚本都 import 已删除的 `dist/agents/{traework,qoder}/…`，早已是死代码。

## 变更

| 文件 | 改动 |
|---|---|
| `package.json` `files` | 去掉上述 4 个脚本与 4 份文档 + `docs/qoder-evidence` |
| `package.json` `scripts` | 去掉 `smoke:traework` / `probe:traework` / `probe:qoder` |
| `package.json` `keywords` | 去掉 `traework` |
| `.github/workflows/ci.yml`（pack-check） | 必需文件清单去掉 qoder 项——**不改则 CI 必红** |
| `.github/workflows/release.yml`（REQUIRED） | 同上 |
| `.github/ISSUE_TEMPLATE/*.md` | 目标 agent 选项与影响范围去掉已移除 agent |
| `mcp-gui/src-tauri/src/scanner.rs` | 测试 fixture 的 `agentId` 换成仍在的 agent（无功能影响） |

> **提前落地的说明**：这些清理本应在本版完成。0.9.10 推送后 CI 的 pack-check 因「必需文件清单仍要求
> qoder 产物、而产物已随 agent 删除」而变红，故把主体（脚本 / 文档 / 清单）提前到 0.9.10 的清理提交
> 一并落地；本版收尾剩余项（scanner fixture 等）。

---

## 验证

| 门 | 结果 |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | 0 error |
| `npm run lint`（`--max-warnings 0`） | 0 warning |
| `npx vitest run test/unit test/integration test/protocol` | 全绿 |
| `npm run build && npm run check:stdio` | stdout 纯净 |
| `npm run pack:check` | 清单符合预期；tarball 内零 `qoder` / `traework` 残留 |
| 本地预演 CI | 按 `ci.yml` / `release.yml` 的清单逐条 `grep -qF` 全过 |
