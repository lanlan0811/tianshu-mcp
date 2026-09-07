# M2 Codex 真实冒烟记录（run_task → verify_task 通过）

- 日期：2026-09-07
- 环境：本机 Windows（Node v24.18.0）；Codex 桌面端自带 CLI `codex-cli 0.153.4`（`~/.codex` 登录态）
- 数据目录：`%TEMP%\m2-smoke\home`（临时，不触碰真实 ~/.tianshu-mcp）
- 项目：临时 git 仓库 `fibonacci` 示例（基线：`package.json` + `verify.mjs`；`npm test` 校验 `lib.js` 的 `fibonacci(10)===55`）
## 任务书（喂给 codex 的原文）

> 在本仓库创建 lib.js（ES module），导出一个 fibonacci 函数。要求：fibonacci(10) === 55；本仓库 `npm test` 会运行 node verify.mjs（导入并校验 lib.js），必须通过。只新增必要文件；不要改动 verify.mjs 的内容，不要改动 package.json 的 test 脚本。

## 结果（真实 codex 模型运行，非 stub）

```
run_task → tsk_20260907185149_c0cf22 (queued)
query_task 轮询：queued → running ×9 → succeeded
succeeded | round 1 | ok true
验收（第 0 轮）：2/2 项命令检查通过
  [PASS] git-diff-check（65ms, exit=0）
  [PASS] test — npm run test（1134ms, exit=0）
代码分析：变更 0 个已跟踪 + 1 个未跟踪；diffstat +15 -0（lib.js）
```

Codex 生成的 `lib.js` 正确实现 fibonacci（含输入校验）；验收通过。**DoD §18 #3「Codex 在本机真实跑通一次『派活→验收』」达成。**

## 过程中发现并修复的真实缺陷（M2 冒烟价值）

1. **Windows 下验收命令跑不了 `npm`**：`spawn('npm', …)` 无法执行 `.cmd` 垫片 → ENOENT。修复：引入 `cross-spawn`（agent spawn 与验收 runner 均使用，保持 argv 数组、非 shell 拼接）。
2. **spawn/验收日志 write-after-end 竞态崩溃**：子进程 close 后仍晚到的 stdout `data` 写入已 `end()` 的 log stream → 未处理 `ERR_STREAM_WRITE_AFTER_END` 把整个 MCP server 打崩（冒烟首跑在验收阶段崩溃）。修复：`safeWrite/safeEnd` + stream `error` 吞掉，绝不冒泡为未处理异常。
3. **codex flags 冲突**：`codex exec` 0.153.x 不允许 `--sandbox workspace-write` 与 `--approve-for-me` 同用 → 参数错误 exit 2。修复：去掉 `--approve-for-me`（profile 数据调整，非代码）。

上述 1/2 已各加一条回归集成测试（`test/integration/spawn-regression.test.ts`）。

## 权威 codex profile（本机，M2 定稿）

```jsonc
{
  "profiles": {
    "codex": {
      "displayName": "Codex (桌面端 CLI)",
      "type": "cli",
      "status": "ready",
      "command": "C:/Users/Lenovo/AppData/Local/OpenAI/Codex/bin/<hash>/codex.exe",
      "argsTemplate": ["exec", "<prompt:arg>", "--skip-git-repo-check", "--sandbox", "workspace-write"],
      "promptMode": "arg",
      "cwd": "task",
      "env": {},
      "timeoutMs": 1800000,
      "killTree": "taskkill",
      "authNote": "复用 ~/.codex 登录态；非交互请保持 --sandbox workspace-write（不要与 --approve-for-me 同用）",
      "executableDiscovery": {
        "dirs": ["C:/Users/Lenovo/AppData/Local/OpenAI/Codex/bin"],
        "fileNames": ["codex.exe", "codex"],
        "fallbackCommand": "codex"
      }
    }
  }
}
```

> `<hash>` 随 Codex 更新变化：用 `executableDiscovery` 每次 resolve 自动取最新目录即可，无需改 command。

## CI / Release workflow 实测（2026-09-07 补记）

- 推送 `d91aea8`（修复 core.test.ts 跨平台失败）后 GitHub Actions：
  - `CI`（Node 20 + Node 22 矩阵）：**success** —— typecheck / lint / 32 项测试 / build / stdin-EOF 冒烟 全绿。
  - `Release`（tag `v0.1.0` 触发）：**success** —— 安装校验 + npm pack + Draft GitHub Release 步骤 success。
- 曾因 `test/unit/core.test.ts` 用 `path.resolve("D:\...")` 在 Linux 上把 `\` 当字面量导致 hash 断言失败（CI 全红 5 次）；改为平台无关写法后修复（提交 d91aea8）。
- 结论：AGENTS.md 要求的 ci.yml / release.yml 均已实际运行通过。
