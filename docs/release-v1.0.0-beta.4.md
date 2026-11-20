# v1.0.0-beta.4 — 首次 npx 握手超时可定位

> 输入是用户提供的超时诊断回执：宿主报
> `MCP connect tianshu-mcp timed out after 60000ms`。
> 回执把根因判为「npx 首次冷拉取」，但**自认「冷拉取耗时本身未测量，>60s 是推断」**——
> 本版先把这条推断做成实测，再按实测结果决定改什么。

**修复的是一条观测缺口，不是一个延迟数字。**

---

## 先说清楚：本版不声称「修复了 60s 超时」

首次 `npx` 冷拉取的成本取决于网络与 registry，不在这仓库的控制范围内。本版交付的是三件事：

1. **可定位性** —— 超时后日志能自己说清卡在哪一段；
2. **实测依据** —— 把「推断」升级为可复现的数字；
3. **用户侧排障路径** —— 三步自查，每步都有可观察结果。

---

## 新增：启动分段计时

`src/index.ts` 从进入 `main()` 起用 `performance.now()`（单调时钟，不受系统时间调整影响）打四个点：

```text
[INFO] 启动分段：进程就绪 3ms（node 24.22.1，pid 2520）
[INFO] tianshu-mcp 已连接（stdio）。… 启动分段：logger 34ms（create 3ms）/ buildServer 31ms / connect 1ms / 总计 34ms
```

- **logger 就绪时**立刻打一条 —— 若宿主在 npx 下首次拉起且超时，这条至少能证明进程被拉起来了。
- **`connect()` 完成后**打一条汇总。
- **总计 > 10s** 追加一条 `[WARN]`，给出归因（多为 npx 冷拉取）与建议（全局预装）。

### 修复前的问题

`connect()` 之前**一行日志都没有**。宿主报握手超时后，`server.log` 无法区分三种情况：

| 情况 | 修复前的日志表现 |
|---|---|
| 进程根本没被拉起 | 空白（与下面两种无法区分） |
| npx 在拉包，进程还没执行 | 空白 |
| 进程起来了，服务器自身初始化慢 | 空白 |

三种情况的处置方式完全不同，而日志不给任何线索。

### 通道契约不变

全部走 `logger`（stderr + `logs/server.log`），**不新增任何 `console.log`**。stdout 仍然只承载 JSON-RPC —— `scripts/check-stdio.mjs` 的严格断言（空行 / 非 JSON / CR 结尾 / 残留片段任一失败）全部通过，stdout 零新增字节。

---

## 变更：视觉依赖缺失的报错可操作化

`src/visual/runtime.ts` 两条消息从不可执行的短语换成可直接复制执行的命令。**错误码不变**（`IMAGE_DEPENDENCY_MISSING` / `BROWSER_DEPENDENCY_MISSING` 被上游判定与测试消费）：

| 缺失 | 修复前 | 修复后 |
|---|---|---|
| `sharp` | `Install optional image dependencies: npm install --include=optional` | 给出 `npm install -g tianshu-mcp --include=optional`，并说明仓库内用 `npm install` |
| 浏览器依赖 | `Reinstall tianshu-mcp browser dependencies` | 给出 `npm install -g tianshu-mcp` + `tianshu-mcp visual browser install` |

---

## 实测（本版的决定依据，全部为本轮工具输出）

| 实验 | 结果 |
|---|---|
| 隔离 `npm_config_cache` + 无全局包 + 非仓库 cwd 跑 `npx -y tianshu-mcp` | **101798 ms**（服务端自报 `0.9.10`，证明确实走 registry 拉取，非本地包） |
| 同场景宿主握手窗口 | 60000 ms ⇒ **超时已真实复现**，不再是推断 |
| `npm install --omit=dev`（消费者口径） | 59871 ms / 100 MB / 171 顶层包 |
| `npm install --omit=dev --omit=optional` | 45810 ms / 77 MB / 165 顶层包 |
| 仅装握手必需的 3 件套（sdk + zod + cross-spawn） | 24062 ms / 22 MB / 91 顶层包 |
| 服务器自身启动（改动后，本地温态） | logger 3 ms / buildServer 31 ms / connect 1 ms / **总计 34 ms** |

**结论：慢在安装期，不在服务器启动期**（后者 34 ms，比 60000 ms 窗口小三个数量级）。

---

## 被实测否证的方案：依赖声明位置搬移

原计划拟把 `puppeteer-core` / `@puppeteer/browsers` / `pixelmatch` 从 `dependencies` 移到
`optionalDependencies`，理由是「安装期成本与运行时成本不匹配」——这四个包在源码里确实全部是
**动态 import**，握手路径不触碰它们的模块图。

实测推翻了它：

1. `npm install --omit=dev` **不**省略 optional —— 该组实测仍装入了 `puppeteer-core`、`pixelmatch`、`sharp`。
2. 只有额外的 `--omit=optional` 才减到 165 包 / 77 MB，而 **`npx` 无法注入该 flag**。
3. `sharp` **本来就在** `optionalDependencies`，但回执现场仍观察到它的 install script 在跑。

**因此搬移声明位置不产生秒数收益，已放弃，不提交无收益的改动。**

---

## 文档

- `README.md` / `README.en.md`：新增「首次启动报握手超时怎么办」三步排障 ——
  看分段行 → 绕开 npx 自查 → 全局预装消除路径。
- `ARCHITECTURE.md` / `ARCHITECTURE.en.md`：启动章节补分段计时语义，以及
  「握手必需依赖 vs 视觉按需依赖」的分层说明。
- `HANDOFF.md` / `CHANGELOG.md` / `CHANGELOG.en.md`：本版条目与实测数字。

---

## 验证

| 门 | 结果 |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | exit 0 |
| `npm run lint`（`--max-warnings 0`） | exit 0 |
| `npx vitest run`（全量） | **1538 passed / 12 skipped**（1550 项，119 文件通过 / 3 skipped，共 122） |
| `npm run check:stdio`（源码 `dist/index.js`） | 8/8 场景 PASS，stdout 无非协议内容 |
| `npm run check:stdio`（干净消费者目录装 tgz） | 8/8 场景 PASS，`serverInfo.version = 1.0.0-beta.4` |
| `npm run check:removed-agents` | exit 0 |
| GitHub Actions run 426（`9c2bd51`） | **22/22 job success** |

---

## 已知遗留

- **不声称修复 60s 超时**：首次冷拉取取决于网络与 registry，不在仓库控制内。
- **`package-lock.json` 仍停在 `0.9.8`**（落后 `package.json` 多个版本）。非本版引入，本版未扩大范围处理。
- **客户端 60000 ms 上限是否可配未验证**：回执称该错误字符串在原生二进制内，静态查不到。
