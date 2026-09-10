# v0.1.10 发布说明

- 版本：`tianshu-mcp@0.1.10`
- 日期：2026-09-10
- 英文版：[release-v0.1.10.en.md](release-v0.1.10.en.md)
- 关联 issue：[GitHub issue #1](https://github.com/lanlan0811/tianshu-mcp/issues/1)

## 发布重点

本版本修复 MCP stdio 传输契约被日志污染的问题。统一日志模块此前只有 ERROR 写 stderr，
INFO/WARN/DEBUG 都写 stdout，与 MCP JSON-RPC 消息共用同一条流，导致严格 stdio 客户端
在握手或工具调用时解析失败。

修复后：

- **stdout 只承载合法 MCP JSON-RPC 消息**，不再出现任何诊断日志。
- **DEBUG/INFO/WARN/ERROR 全部写 stderr**，并继续追加到 `<数据目录>/logs/server.log`。
- **stderr 中出现 INFO/WARN 属正常诊断**，不代表服务器错误；只有启动失败才致命并返回非 0 退出码。
- 客户端无需日志过滤包装、无需关闭日志、无需升级 MCP SDK。

无需新增配置项即可生效。

## 变更范围

| 位置 | 变更 |
|---|---|
| `src/util/log.ts` | 所有通过阈值的级别统一写 stderr；更新模块注释说明 stdout 归 MCP transport 独占 |
| `eslint.config.js` | `src/**/*.ts` 启用 `no-console`（仅允许 `console.error`），阻止再次向 stdout 直接输出 |
| `scripts/check-stdio.mjs` | 新增严格 stdio 冒烟：真实子进程按字节校验完整 stdout/stderr |
| `test/unit/log.test.ts` | 新增四级日志通道/阈值/文件/UTF-8 回归测试（子进程探针） |
| `test/fixtures/log-probe.ts` | 新增日志通道探针 fixture |
| `.github/workflows/ci.yml` | Node 24 纳入矩阵；构建后跑严格 stdio；pack-check 安装 tarball 到消费者并复用该检查 |
| `.github/workflows/release.yml` | 增加 `lint`、构建后严格 stdio 与安装包协议门禁，失败阻断草稿 |

## 严格 stdio 检查

`npm run check:stdio`（构建后跑 `dist`）与 `npm run check:stdio:src`（`tsx` 跑源码）执行同一脚本，
校验规则：

- 完整捕获 stdout/stderr，按 UTF-8 解码，从启动直到子进程 `close` 逐行检查，包含空行与退出残留片段。
- stdout 每行必须是有换行分隔、通过官方 `JSONRPCMessageSchema` 校验的 MCP 消息，请求/响应 ID 对得上；
  出现任意非协议行或 parser error 即判失败，不做过滤后放行。
- 覆盖六个必测场景：首次默认启动、已有技能再次启动、`--no-skill-install`、损坏 `config.json` 触发 WARN、
  stub 任务运行期日志、正常 EOF 关闭（退出码 0）。
- 断言工具集合与源码定义一致、`serverInfo.version` 与 `package.json` 一致、日志留在 stderr 与文件中。

跨平台实现使用 `process.execPath`、argv 数组、`shell: false`、`windowsHide: true`、`os.tmpdir()` 与 `path`，
不依赖 GNU timeout、shell 重定向或固定盘符；只向子进程注入隔离的用户目录（`HOME`/`USERPROFILE`/`TIANSHU_MCP_HOME`）。

## 验证

- 修复前：`test/unit/log.test.ts` 4/6 失败；`check-stdio` 六个场景 6/6 失败（证据见
  `docs/m2-evidence/issue1-old-impl-log-test-failure.txt` 与 `docs/m2-evidence/issue1-old-impl-stdio-check-failure.txt`）。
- 修复后：源码入口与 `dist` 构建入口六个场景全部通过，stdout 非协议行数为 0。
- 分发包验证：`npm pack` 生成的 tarball 安装到干净消费者目录（不装开发依赖）后，动态读取已安装 bin
  并复用严格 stdio 检查，六个场景全部通过。
- 发布门禁：`typecheck && lint && test && build && check:stdio && pack:check`。
- CI 矩阵：Windows / macOS / Linux × Node 20 / 22 / 24，以实际 CI 结果为证据。

## 安装

```bash
npm install -g tianshu-mcp@0.1.10
```
