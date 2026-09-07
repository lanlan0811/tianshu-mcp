# agent-profiles.md — Agent 适配与 Profiles 说明

外部 AI-Agent 通过 **profile** 接入 tianshu-mcp：每个 agent 是一段声明式数据（可执行/参数模板/工作目录/env/超时/登录方式），**新增 agent 无需改代码**——在数据目录 `agent-profiles.json` 加一个 profile 即可（需要特殊输出解析的再补一个 adapter 子类）。

## 存储位置

| 级别 | 文件 | 说明 |
|---|---|---|
| 内置 | `src/agents/builtin.ts` | 代码内置默认 profiles（codex/zcode/traework）；随版本更新 |
| 用户级 | `~/.tianshu-mcp/agent-profiles.json`（`TIANSHU_MCP_HOME` 可覆盖） | 整键覆盖内置同名 profile |

合并规则：先内置，再用户级覆盖（同 `id` 用户级胜出）。

## Profile 字段

```jsonc
{
  "profiles": {
    "<agentId>": {
      "displayName": "Codex (OpenAI 桌面端 CLI)",   // 展示名
      "type": "cli",                                  // 目前仅 cli
      "status": "ready",                              // ready | research | unsupported
      "command": null,                                // 可执行；null + discovery 则自动探测
      "argsTemplate": ["exec", "<prompt:arg>", "--skip-git-repo-check"],
      "promptMode": "arg",                            // arg | stdin | file
      "cwd": "task",                                  // task=项目目录, home=用户主目录
      "env": {},                                      // 追加环境变量（敏感值本机自填）
      "timeoutMs": 1800000,
      "killTree": "taskkill",                         // taskkill | group
      "authNote": "复用 ~/.codex 登录态",              // 仅说明，不落密钥
      "executableDiscovery": {                        // 可执行自动发现（选填）
        "dirs": ["C:/Users/<你>/AppData/Local/OpenAI/Codex/bin"],
        "fileNames": ["codex.exe", "codex"],          // 无 fileNames 则目录不扫描
        "fallbackCommand": "codex"                    // 最后回退：PATH 查找
      }
    }
  }
}
```

### promptMode

| 模式 | 说明 |
|---|---|
| `arg` | prompt 内联进参数：`argsTemplate` 中的 `<prompt:arg>` 被替换 |
| `stdin` | prompt 经 stdin 传入（stdio 管道），**最通用** |
| `file` | 先写 `<任务目录>/prompt-<round>.txt`，参数里 `<prompt:file>` 指向它 |

### 探测顺序（resolve）

1. `command` 是存在的绝对路径 → 直接使用
2. `executableDiscovery.dirs` 里找 `fileNames`（**必须有 fileNames 才扫目录**），取修改时间最新的
3. `fallbackCommand` / 相对 command 在 PATH 中查找
4. 全失败 → `ok:false`，`get_profiles` 会显示原因

> Codex 的 `<hash>` 版本目录更新：dirs 配到 `.../Codex/bin`、fileNames 配 `codex.exe`，每次 resolve 自动取最新目录；也可在 run 前手动重启 server 重探。

## 本机真实样例

```jsonc
// ~/.tianshu-mcp/agent-profiles.json （Windows 示例）
{
  "profiles": {
    "codex": {
      "displayName": "Codex (桌面端 CLI)",
      "type": "cli",
      "status": "ready",
      "command": "C:/Users/Lenovo/AppData/Local/OpenAI/Codex/bin/8e5b6932251c2c1c/codex.exe",
      "argsTemplate": ["exec", "<prompt:arg>", "--skip-git-repo-check"],
      "promptMode": "arg",
      "cwd": "task",
      "timeoutMs": 1800000,
      "killTree": "taskkill",
      "authNote": "复用 ~/.codex 登录态（与 Codex 桌面端同账号）",
      "executableDiscovery": {
        "dirs": ["C:/Users/Lenovo/AppData/Local/OpenAI/Codex/bin"],
        "fileNames": ["codex.exe", "codex"],
        "fallbackCommand": "codex"
      }
    }
  }
}
```

> 说明：`argsTemplate` 中 `codex exec` 的精确 flags / 输出模式以 `codex exec --help` 实测为准（profile 数据可改，不需改代码）。M2 联调完成后把权威配置回填到 `docs/` 与本文件。

## 状态与轮询语义

| status | 含义 | run_task 行为 |
|---|---|---|
| `ready` | 已配 command / discovery 可解析 | 可跑 |
| `research` | 调研占位（zcode/traework） | resolve 不 ok → run_task 立即失败并给原因 |
| `unsupported` | 明确不支持（见 adapter-matrix.md） | 同上 |

## 常见问题

- **探测到错误文件**：检查 `fileNames` 只写可执行名；zcode 无头入口在 M2 调研前不自动探测（避免把 `db.sqlite` 之类误判为 CLI）。
- **profile 改动不生效**：server 每次 resolve 会重读 profiles 文件并缓存结果；`get_profiles` 会触发一次新探测。改完 profile 建议重启 server。
- **env 有敏感值**：仅本机可见，不会写入 task.jsonl/日志；属于自担风险字段。
