import type { SpawnOptions } from "node:child_process";

/**
 * GUI 桌面实例（TraeWork / ZCode / Codex / Kimi Code / Qoder CN）的 spawn 选项。
 *
 * `detached: true` 是**不变量**，不是平台偏好：桌面实例必须自成进程组、脱离父进程，否则父进程
 * （MCP server，或一次性 smoke / probe 脚本）退出时会把它连坐杀掉，`run_task` 的 `keptInstance`
 * （「实例跨 server 退出驻留」）语义随之失效——表现为 `needs_user` 提示「请在 ZCode 中处理后再
 * 调用 continue_task」，而窗口其实已经消失，用户根本无从操作。
 *
 * 真机实测（Windows 10 / Node 24.18.0，2026-09-15）：同一段 spawn，non-detached 子进程在父进程
 * 退出后存活 0，detached 存活 1；对照组是 detached 启动的 ZCode 实例跨多次 server 退出仍驻留。
 *
 * 注意：不要把它套到「执行型子进程」上：`verify/runner`、`visual/services`、`agents/spawn` 的语义是
 * **可被整组 SIGTERM/SIGKILL 终止**，因此它们继续按平台分支（POSIX detached、Windows 用
 * taskkill /T），与这里的驻留语义相反。
 */
export function guiInstanceSpawnOptions(windowsHide = true): SpawnOptions {
  return { detached: true, stdio: "ignore", windowsHide };
}

/**
 * 需要**诊断输出**时的 spawn 选项（启动失败排查）。
 *
 * 常规 GUI 启动继续用 `guiInstanceSpawnOptions()`（stdio 全忽略）；本函数只把 **stderr 收成管道**：
 * - stdout 仍忽略（本产品会往 stdout 打大量日志，收进来只是噪音）；
 * - stderr 收进管道后**必须有人消费**，否则管道写满会让子进程阻塞——
 *   调用方负责累积到有界缓冲区（见 `opendesign/instance.ts`）。
 *
 * 真机依据（2026-09-26）：Open Design 0.24.1 在本机启动即退出（无窗口、无新日志、无崩溃转储），
 * 用 stdio:"ignore" 时调用方只能看到一个退出码，无法判断是缺网络、缺依赖还是单实例锁转交。
 */
export function guiInstanceDiagSpawnOptions(windowsHide = true): SpawnOptions {
  return { detached: true, stdio: ["ignore", "ignore", "pipe"], windowsHide };
}
