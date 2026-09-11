/**
 * Codex MSIX 应用的启动通道（Windows）。
 *
 * 关键实测结论（2026-09-11）：
 * - `CreateProcess` 直接启动 WindowsApps 下的 ChatGPT.exe 会被策略拒绝（拒绝访问 0x80070005），
 *   原因：AppX 执行标签要求「仅带 package identity 的激活可执行」。
 * - `IApplicationActivationManager::ActivateApplication(AUMID, args, 0)` 能成功激活，
 *   且 args 会被原样透传到进程命令行 → 因此 `--remote-debugging-port` 可以注入，CDP 可用。
 * - 必须携带专属 `--user-data-dir`：Electron 单实例锁按 profile 生效，复用默认 profile 时
 *   新进程会转交参数后退出，调试端口不会开启。
 *
 * 本模块只依赖 PowerShell + Add-Type 内联 C#（无第三方依赖），失败均以明确异常上报。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** ActivateApplication 的 options：AO_NONE */
export const AO_NONE = 0;

/** 内联 C#：IApplicationActivationManager 的 COM 声明 + 激活入口 */
export const ACTIVATION_CSHARP = String.raw`
using System;
using System.Runtime.InteropServices;
public static class TianshuCodexAct {
  [ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IApplicationActivationManager {
    int ActivateApplication([In] string appUserModelId, [In] string arguments, [In] int options, [Out] out uint processId);
    int ActivateForFile([In] string appUserModelId, [In] IntPtr itemArray, [In] string verb, [Out] out uint processId);
    int ActivateForProtocol([In] string appUserModelId, [In] IntPtr itemArray, [Out] out uint processId);
  }
  [ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
  class ApplicationActivationManager { }
  public static uint Activate(string aumid, string args, int options) {
    var mgr = (IApplicationActivationManager)new ApplicationActivationManager();
    uint pid;
    int hr = mgr.ActivateApplication(aumid, args, options, out pid);
    if (hr < 0) Marshal.ThrowExceptionForHR(hr);
    return pid;
  }
}
`;

/**
 * 构造激活参数：专属 user-data-dir + 调试端口。
 * 路径含空格/中文时用双引号包裹；内部双引号转义为 `\"`（Windows 命令行约定）。
 */
export function buildActivationArgs(userDataDir: string, port: number): string {
  const quoted = `"${userDataDir.replace(/"/g, '\\"')}"`;
  return `--user-data-dir=${quoted} --remote-debugging-port=${port}`;
}

/**
 * 构造 PowerShell 激活脚本。
 * 所有外部字符串经单引号转义后内联，避免注入；AUMID/args 均来自内部构造。
 */
export function buildActivationScript(aumid: string, args: string): string {
  const q = (s: string): string => `'${s.replace(/'/g, "''")}'`;
  return `$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
${ACTIVATION_CSHARP}
'@
$pidValue = [TianshuCodexAct]::Activate(${q(aumid)}, ${q(args)}, ${AO_NONE})
Write-Output ("activated pid=" + $pidValue)`;
}

export interface ActivateResult {
  ok: boolean;
  pid?: number;
  message: string;
}

/**
 * 把已运行的受管 Codex 实例带到前台。
 *
 * 为什么用 COM 激活而不是 SetForegroundWindow：Windows 前台锁会拒绝后台进程
 * （node/powershell）的 SetForegroundWindow，但**应用模型激活**是受支持的前台请求，
 * 系统会放行。打开 Codex 的原生文件夹选择器要求应用窗口处于前台，故此处复用同一通道。
 */
export async function focusCodexApp(aumid: string, timeoutMs = 20_000): Promise<boolean> {
  if (process.platform !== "win32" || !aumid.trim()) return false;
  const q = (s: string): string => `'${s.replace(/'/g, "''")}'`;
  const script = `$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
${ACTIVATION_CSHARP}
'@
[void][TianshuCodexAct]::Activate(${q(aumid)}, '', ${AO_NONE})
Write-Output 'focus-ok'`;
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, timeout: timeoutMs },
    );
    return stdout.includes("focus-ok");
  } catch {
    return false;
  }
}

/**
 * 通过 COM 激活 Codex GUI 并注入 user-data-dir + 调试端口。
 * 非 Windows 平台直接返回失败（macOS 由调用方走其它通道）。
 */
export async function activateCodexApp(
  aumid: string,
  args: string,
  timeoutMs = 30_000,
): Promise<ActivateResult> {
  if (process.platform !== "win32")
    return { ok: false, message: `MSIX COM 激活仅支持 Windows（当前 ${process.platform}）` };
  if (!aumid.trim()) return { ok: false, message: "缺少 AUMID，无法激活 Codex" };
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", buildActivationScript(aumid, args)],
      { windowsHide: true, timeout: timeoutMs },
    );
    const m = /activated pid=(\d+)/.exec(stdout);
    return {
      ok: true,
      pid: m ? Number(m[1]) : undefined,
      message: stdout.trim() || "激活成功",
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, message: `Codex 激活失败：${msg}` };
  }
}
