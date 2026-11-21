# v1.0.0 — 首个正式版

> 参数面收敛、依赖分层、可观测性补齐之后的第一个正式版。
> 从 `0.9.10` 起的四个 beta 逐版推进：`beta.1` 参数面收敛 → `beta.2` 脚本与 CI 收口 →
> `beta.3` 文档收口与零残留门禁 → `beta.4` 启动分段可观测。本版为其汇总。

**本版相对 `1.0.0-beta.4` 的代码变更只有一处**：为启动分段埋点补上自动化断言（详见下文）。
其余是版本号转正、文档与测试数字对齐。

---

## 先说清楚：60 秒冷启动超时没有消失

这是 `1.0.0` 必须诚实标注的一条。

首次用 `npx -y tianshu-mcp` 拉起时，npm 需要现场下载并安装整棵依赖树。实测（隔离 cache、
无全局包、非仓库 cwd）：

| 实验 | 结果 |
|---|---|
| `npx -y tianshu-mcp`（冷启动） | **101798 ms**（服务端自报 `0.9.10`，证明走 registry） |
| 同场景宿主握手窗口 | 60000 ms ⇒ **必然超时** |
| 服务器自身启动（与安装无关） | **34 ms** |

**慢在安装期，不在服务器启动期。** 安装期的成本取决于网络与 registry，不在本仓库控制内。

因此本版**不声称修复了超时**。它交付的是：

1. **可定位性** —— 超时后日志自己说清卡在哪一段；
2. **实测依据** —— 把「推断」变成可复现的数字；
3. **用户侧排障路径** —— 三步自查。

**推荐用法**：全局预装一次，让 `npx` 直接命中已装二进制，不再冷拉取。

```bash
npm install -g tianshu-mcp
```

---

## 相对 beta.4 的变更：给分段埋点加断言

`1.0.0-beta.4` 新增的启动分段计时有一个缺口：它的唯一消费方是人（运维翻 `logs/server.log`），
**没有任何自动化断言保护它**。删掉 `src/index.ts` 的两处埋点，全量测试和 `check:stdio` 都不会红。

本版在 `scripts/check-stdio.mjs` 的严格 stdio 检查中补两条断言：

- stderr 必须含 `启动分段：进程就绪`（logger 就绪时的第一处埋点）；
- stderr 必须匹配 `启动分段：logger Nms（create Nms）/ buildServer Nms / connect Nms / 总计 Nms` 的完整四段格式。

**RED → GREEN 已实测闭环**（这是本版唯一的代码改动，故把验证过程写全）：

| 步骤 | 操作 | 结果 |
|---|---|---|
| RED | 临时把两处埋点占位符化 → `npm run build` → `npm run check:stdio` | **8/8 场景 FAIL**，exit=1，报错「stderr 缺少「启动分段：进程就绪」」 |
| GREEN | 恢复埋点 → 重新 build → `npm run check:stdio` | **8/8 场景 PASS**，exit=0 |

这条断言现在能挡住「悄悄删掉埋点」的退化。

---

## 累积变更（0.9.10 → 1.0.0）

### 破坏性变更（beta.1 / beta.2 引入）

- **移除 TraeWork 与 Qoder CN 两个 agent 的调用支持**（0.9.9 / 0.9.10 起）：目录、测试、
  registry 接线、fix-loop 分支、文档全量清理。`driver="gui"` 缺省回落到已移除适配器的历史行为
  一并取消，改为 **fail-closed 报错**并给出迁移路径。
- **`mode` 参数废弃**：传 `traework` 专属的 `mode` 会得到统一迁移文案（指向 `designDirection`），
  不再被静默 strip。
- **`modelSource` 参数废弃**：统一拒绝文案。

### 新增

- **启动分段计时**（beta.4）：`connect()` 之前原本一行日志都没有；现在 logger 就绪与 connect
  完成各打一条，总计 >10s 追加 `[WARN]` 归因。
- **零残留门禁**（beta.3）：`scripts/check-removed-agents.mjs`，接入 CI。`src/` / `scripts/` /
  `package.json` / CI 配置对已移除 agent 名**零容忍**（含注释），其余影响面逐条白名单。
- **分段埋点断言**（本版）：见上。

### 改进

- 视觉依赖缺失的报错可操作化：错误码不变，消息给出可直接复制执行的
  `npm install -g tianshu-mcp [--include=optional]` 与 `tianshu-mcp visual browser install`。
- **视觉依赖与握手的模块分层已文档化**：握手只需要 `@modelcontextprotocol/sdk` + `zod` +
  `cross-spawn`；`puppeteer-core` / `@puppeteer/browsers` / `pixelmatch` / `sharp` 全部是视觉路径上的
  动态 import，不进握手模块图。

### 被实测否证、未采纳的方案

原计划拟把视觉三件套从 `dependencies` 移到 `optionalDependencies` 以减少首次安装成本。实测证伪：

1. `npm install --omit=dev` **不**省略 optional —— 该组实测仍装入 `puppeteer-core`、`pixelmatch`、`sharp`；
2. 只有额外的 `--omit=optional` 才减到 165 包 / 77 MB，而 **`npx` 无法注入该 flag**；
3. `sharp` **本来就在** `optionalDependencies`，但现场仍观察到其 install script 执行。

搬移声明位置不产生秒数收益，已放弃，不提交无收益改动。

---

## 验证

| 门 | 结果 |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | exit 0 |
| `npm run lint`（`--max-warnings 0`） | exit 0 |
| `npx vitest run`（全量） | **1538 passed / 12 skipped**（1550 项，119 文件通过 / 3 skipped，共 122） |
| `npm run check:stdio`（源码 `dist/index.js`） | **8/8 场景 PASS**，stdout 无非协议内容 |
| `npm run check:stdio` 的 RED 反证 | 移除埋点后 **8/8 FAIL**（证明断言真的在挡） |
| `npm run check:stdio`（干净消费者目录装 tgz） | 8/8 场景 PASS，`serverInfo.version = 1.0.0` |
| `npm run check:removed-agents` | exit 0 |
| GitHub Actions（发布 commit） | 22/22 job success |

---

## 升级注意

- **`latest` 指向本版**。从 `0.9.10` 或任一 beta 升级是 semver 升序，自动更新会直接推过来。
- **无数据格式变更**：数据目录 `~/.tianshu-mcp` 的 `config.json` / `agent-profiles.json` /
  `projects.json` / 任务快照均向后兼容，无需迁移。
- **已移除 agent 的历史任务**：`agentId: "traework"` / `"qoder"` 的历史任务调
  `manage_task(action="rework")` 会硬失败 `agent_unresolved`（这是 fail-closed 的预期行为，
  不会被 CLI adapter 兜底误跑）。要续跑请用新 agent 重新派单。

---

## 已知遗留

- **首次 `npx` 冷启动仍可能超 60s**（取决于网络与 registry）。全局预装可完全规避。
- **客户端 60000 ms 握手上限是否可配置未验证**（错误字符串在客户端原生二进制内）。
- **`package-lock.json` 的版本滞后已在本版修正**（此前停在 0.9.8）。
