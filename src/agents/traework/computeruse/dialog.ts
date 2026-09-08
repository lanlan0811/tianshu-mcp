/**
 * 原生「选择文件夹」对话框驱动（图3）。
 *
 * 仅在「选择文件夹」下拉未命中已有项目时使用（决策 10）。这是本 MCP 唯一
 * 会触碰 Windows 原生 UI 的路径，且必须经 guard.ts 白名单校验。
 *
 * 实现：PowerShell + Win32 EnumWindows（找窗口）+ UI Automation（写路径/点按钮）：
 *   1. 按标题找到对话框窗口（Select Project Folder / 选择项目文件夹）
 *   2. guard 校验窗口标题 + 宿主进程
 *   3. 把项目绝对路径写入「文件夹:」编辑框
 *   4. 点击「选择文件夹」按钮
 *
 * 性能实测（2026-09-08）：**PowerShell 进程冷启动约 4.5–6s**，与用 UIA 还是 Win32
 * 探测无关。因此不能在 Node 侧「每次 spawn 一次」轮询——15s 预算内只够约 2 次。
 * 正确做法是**一次 PowerShell 调用内完成等待与操作**（脚本内轮询），进程只启动一次。
 *
 * macOS 分支 fail-closed：明确报错并提示用户手动先在 TraeWork 打开该项目。
 */
import { spawn } from "node:child_process";
import { assertAllowed, ComputerUseDeniedError } from "./guard.js";
import type { AgentRunLogger } from "../../adapter.js";

export interface NativeDialogResult {
  ok: boolean;
  message: string;
}

/** 等待原生对话框出现的最长时间（单次 PowerShell 调用内轮询） */
const DIALOG_WAIT_MS = 30_000;

/** 运行 PowerShell 脚本（异步，不阻塞事件循环） */
function runPowerShell(
  ps: string,
  opts: { env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...(opts.env ?? {}) },
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
    }, opts.timeoutMs ?? 90_000);
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: `${stderr}${e.message}`, code: null, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });
  });
}

/** 解析 PowerShell 输出的单行结果（`FOUND|...` / `NONE||` / `OK|...` / `ERR|...`） */
function pickResultLine(stdout: string, prefixes: string[]): string | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (prefixes.some((p) => l.startsWith(p))) return l;
  }
  return null;
}

/**
 * 探测原生文件夹对话框是否出现（返回标题与进程名）。
 *
 * 实测（2026-09-08，TraeWork 1.107.1）：该对话框不是顶层窗口，
 * 而是 TraeWork 主窗口的**后代/拥有者窗口**（UIA TreeScope.Children 看不到）。
 * 用 Win32 `EnumWindows` 可直接枚举到（标题 `Select Project Folder`，class `#32770`）。
 */
export async function findFolderDialog(): Promise<{ found: boolean; windowTitle: string; processName: string }> {
  if (process.platform !== "win32") return { found: false, windowTitle: "", processName: "" };
  const ps = `
$ErrorActionPreference='SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class TWDlgFind {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
}
'@
$script:hit = $null
[void][TWDlgFind]::EnumWindows({ param($h, $l)
  $sb = New-Object System.Text.StringBuilder 512
  [void][TWDlgFind]::GetWindowText($h, $sb, 512)
  $t = $sb.ToString()
  $cb = New-Object System.Text.StringBuilder 64
  [void][TWDlgFind]::GetClassName($h, $cb, 64)
  # ASCII-only: the folder picker is class #32770 titled "Select Project Folder".
  if (($t -match 'Select Project Folder|Select Folder') -and ($cb.ToString() -eq '#32770')) {
    if ([TWDlgFind]::IsWindowVisible($h)) {
      $procId = 0
      [void][TWDlgFind]::GetWindowThreadProcessId($h, [ref]$procId)
      $script:hit = ($t + '|' + $procId + '|' + $cb.ToString())
    }
  }
  return $true
}, [IntPtr]::Zero)
if ($script:hit) {
  $parts = $script:hit -split '\\|'
  $p = (Get-Process -Id ([int]$parts[1]) -ErrorAction SilentlyContinue).ProcessName
  Write-Output ('FOUND|' + $parts[0] + '|' + $p)
} else {
  Write-Output 'NONE||'
}
`;
  const res = await runPowerShell(ps, { timeoutMs: DIALOG_WAIT_MS });
  const line = pickResultLine(res.stdout, ["FOUND|", "NONE|"]);
  if (!line || line.startsWith("NONE|")) return { found: false, windowTitle: "", processName: "" };
  const [, title, proc] = line.split("|");
  return { found: true, windowTitle: title ?? "", processName: proc ? `${proc}.exe` : "" };
}

/**
 * 在对话框中写入路径并确认（单次 PowerShell 调用内完成「等待出现 + 写入 + 确认」）。
 *
 * 之所以把等待也放进同一个脚本：PowerShell 冷启动约 4.5–6s，若在 Node 侧反复
 * spawn 轮询，30s 预算内只够约 5 次；放进脚本内则以 ~400ms 间隔轮询，代价仅一次启动。
 */
function buildSetPathScript(): string {
  // 实测（TraeWork 1.107.1）：这是 Win32 传统文件夹选择器（class #32770，DirectUI 绘制），
  // UIA 只暴露部分控件：
  //   - 「文件夹:」输入框 id=1152 是 Pane（无 ValuePattern）
  //   - 确认按钮「选择文件夹」id=1 是 Pane（无 InvokePattern）→ 坐标点击
  //
  // 实测踩坑（必须处理）：
  //   1. 路径经 JS 模板字面量直接插入会被解释（\t → 制表符）→ 改用环境变量传递，
  //      彻底规避 JS/PowerShell 双重转义（曾经 JSON.stringify 导致反斜杠翻倍）。
  //   2. 输入/点击前必须**强制把对话框置于前台**：第三方工具（如 Snipaste 截图器）
  //      会抢焦点，导致 SendKeys 与坐标点击落到别的窗口（实测踩坑）。
  //      用 AttachThreadInput + BringWindowToTop + SetForegroundWindow 强制激活。
  //   3. 对话框是 TraeWork 的**拥有者窗口**，不是 UIA 顶层子窗口；用 Win32
  //      EnumWindows 按标题找最稳（UIA Children 看不到它）。
  //   4. **脚本必须纯 ASCII**：Windows 控制台代码页会把脚本里的中文literal 变成乱码，
  //      导致 `-match '选择文件夹'` 永不命中、错误信息在 Node 侧读成乱码（实测踩坑）。
  //      因此所有输出用英文、所有匹配只用 ASCII 模式（该对话框标题实测为英文
  //      `Select Project Folder`），确认按钮只按 AutomationId 定位。
  return `
$ErrorActionPreference='Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class TWDlg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int n);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint p);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, string l);
  public static void Force(IntPtr h) {
    ShowWindow(h, 9);
    uint pid; uint fgT = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
    uint curT = GetCurrentThreadId();
    AttachThreadInput(curT, fgT, true);
    BringWindowToTop(h);
    SetForegroundWindow(h);
    AttachThreadInput(curT, fgT, false);
  }
  public static void Click(int x, int y) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(150);
    mouse_event(0x0002, 0, 0, 0, IntPtr.Zero);
    System.Threading.Thread.Sleep(80);
    mouse_event(0x0004, 0, 0, 0, IntPtr.Zero);
  }
}
'@
$targetPath = $env:TRAEWORK_DLG_PATH
if (-not $targetPath) { Write-Output 'ERR|no target path'; exit 0 }
$waitMs = [int]$env:TRAEWORK_DLG_WAIT_MS
if (-not $waitMs -or $waitMs -le 0) { $waitMs = 30000 }

function Find-DlgHwnd {
  $script:foundHwnd = [IntPtr]::Zero
  [void][TWDlg]::EnumWindows({ param($h, $l)
    $sb = New-Object System.Text.StringBuilder 512
    [void][TWDlg]::GetWindowText($h, $sb, 512)
    $t = $sb.ToString()
    $cb = New-Object System.Text.StringBuilder 64
    [void][TWDlg]::GetClassName($h, $cb, 64)
    # ASCII-only match: the folder picker is class #32770 titled "Select Project Folder".
    if (($t -match 'Select Project Folder|Select Folder') -and ($cb.ToString() -eq '#32770')) {
      if ([TWDlg]::IsWindowVisible($h)) { $script:foundHwnd = $h }
    }
    return $true
  }, [IntPtr]::Zero)
  return $script:foundHwnd
}

# Wait for the dialog inside this single PowerShell process (avoid per-poll spawn cost).
$deadline = (Get-Date).AddMilliseconds($waitMs)
$hwnd = [IntPtr]::Zero
while ((Get-Date) -lt $deadline) {
  $hwnd = Find-DlgHwnd
  if ($hwnd -ne [IntPtr]::Zero) { break }
  Start-Sleep -Milliseconds 400
}
if ($hwnd -eq [IntPtr]::Zero) { Write-Output 'ERR|dialog not found'; exit 0 }

[TWDlg]::Force($hwnd)
Start-Sleep -Milliseconds 800

$dlg = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
if (-not $dlg) { Write-Output 'ERR|cannot get UIA element from hwnd'; exit 0 }

# Locate the folder edit box: AutomationId "1152" AND ClassName "Edit".
# 实测踩坑：AutomationId=1152 也会出现在文件列表项上，必须用 ClassName=Edit 区分。
# 该控件是 Pane 类型、无 ValuePattern；且 SendKeys/剪贴板在中文路径下会被控制台代码页
# 破坏（实测 "D:\Trae项目\ts-bind-test" 被写成 "D:Traes-bind-test"）。因此改用 Win32
# WM_SETTEXT 直接写入（句柄由 UIA 提供），对 CJK 路径完全可靠。
$edit = $null
foreach ($e in $dlg.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
  if ($e.Current.AutomationId -eq '1152' -and $e.Current.ClassName -eq 'Edit') { $edit = $e; break }
}
if (-not $edit) { Write-Output 'ERR|folder edit box not found'; exit 0 }
$editHwnd = [IntPtr]$edit.Current.NativeWindowHandle
if ($editHwnd -eq [IntPtr]::Zero) { Write-Output 'ERR|folder edit box has no native handle'; exit 0 }
# WM_SETTEXT = 0x000C
[void][TWDlg]::SendMessage($editHwnd, 0x000C, [IntPtr]::Zero, $targetPath)
Start-Sleep -Milliseconds 800

# Click confirm: AutomationId "1" AND ControlType Pane (list rows also use id 1).
$btn = $null
foreach ($e in $dlg.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
  if ($e.Current.AutomationId -eq '1' -and $e.Current.ControlType.ProgrammaticName -eq 'ControlType.Pane') { $btn = $e; break }
}
if ($btn) {
  $br = $btn.Current.BoundingRectangle
  if ($br.Width -gt 0 -and $br.Height -gt 0) {
    [TWDlg]::Click([int]($br.X + $br.Width/2), [int]($br.Y + $br.Height/2))
    Start-Sleep -Milliseconds 2500
    if ((Find-DlgHwnd) -eq [IntPtr]::Zero) { Write-Output 'OK|confirmed via WM_SETTEXT + button click'; exit 0 }
    Write-Output 'ERR|dialog still open after confirm click'
    exit 0
  }
}
Write-Output 'ERR|confirm control (AutomationId=1, Pane) not clickable'
exit 0
`;
}

/** PowerShell 脚本内部用 ASCII 输出（避免控制台代码页乱码），此处映射回中文 */
export function localizeDialogMessage(msg: string): string {
  const map: Record<string, string> = {
    "no target path": "未提供目标路径",
    "dialog not found": "原生「选择文件夹」对话框未出现",
    "cannot get UIA element from hwnd": "无法从窗口句柄取得 UIA 元素",
    "folder edit box not found": "未找到「文件夹」输入框（AutomationId=1152 且 ClassName=Edit）",
    "folder edit box has no native handle": "「文件夹」输入框没有原生窗口句柄",
    "confirmed via WM_SETTEXT + button click": "已通过 WM_SETTEXT 写入路径并点击确认",
    "dialog still open after confirm click": "点击确认后对话框仍存在",
    "confirm control (AutomationId=1, Pane) not clickable": "确认按钮（AutomationId=1 且为 Pane）不可点击",
  };
  return map[msg] ?? msg;
}

/** 在对话框中写入路径并确认（异步，单次 PowerShell 调用） */
async function setPathAndConfirm(projectPath: string): Promise<NativeDialogResult> {
  const res = await runPowerShell(buildSetPathScript(), {
    // 路径经环境变量传递，避免 JS 模板字面量转义问题（\t 等）
    env: { TRAEWORK_DLG_PATH: projectPath, TRAEWORK_DLG_WAIT_MS: String(DIALOG_WAIT_MS) },
    timeoutMs: DIALOG_WAIT_MS + 60_000,
  });
  const line = pickResultLine(res.stdout, ["OK|", "ERR|"]);
  if (!line) {
    return {
      ok: false,
      message: `原生对话框操作无输出（timeout=${res.timedOut} code=${res.code} stderr: ${res.stderr.slice(0, 200)}）`,
    };
  }
  const [tag, msg] = line.split("|");
  return { ok: tag === "OK", message: localizeDialogMessage(msg ?? "") };
}


/**
 * 驱动原生「选择文件夹」对话框选中指定项目目录。
 * 所有窗口操作前先过 guard 白名单；非允许目标一律拒绝。
 *
 * 流程：先在 Node 侧探测对话框是否已出现（给调用方一个明确的「未弹出」信号），
 * 再做白名单校验，最后交给单次 PowerShell 调用完成「等待 + 写入 + 确认」。
 */
export async function pickFolderViaNativeDialog(
  projectPath: string,
  opts: { logger: AgentRunLogger },
): Promise<NativeDialogResult> {
  const { logger } = opts;

  if (process.platform !== "win32") {
    return {
      ok: false,
      message:
        "当前平台不支持自动驱动原生「选择文件夹」对话框（macOS 分支未验证）。请在 TraeWork 里手动打开该项目一次，之后即可在下拉中命中。",
    };
  }

  // 先探测（一次 PowerShell 调用）；未出现时给出「未弹出」的明确结论，
  // 便于上层区分「footer 没点到」与「点了但对话框操作失败」。
  const probe = await findFolderDialog();
  if (!probe.found) {
    return {
      ok: false,
      message: "未检测到原生「选择文件夹」对话框（TraeWork 未弹出或已关闭；请检查下拉底部按钮是否被点到）",
    };
  }

  // 硬边界：白名单校验（仅允许 AI-Agent 的文件夹选择对话框）
  try {
    assertAllowed({ windowTitle: probe.windowTitle, processName: probe.processName, intent: "选择项目文件夹" });
  } catch (e) {
    const msg = e instanceof ComputerUseDeniedError ? e.message : String(e);
    logger.error(`[traework] computer-use 守卫拒绝: ${msg}`);
    return { ok: false, message: msg };
  }

  logger.info(`[traework] 原生对话框已确认（窗口「${probe.windowTitle}」进程「${probe.processName}」），写入路径…`);
  const res = await setPathAndConfirm(projectPath);
  if (res.ok) logger.info(`[traework] 原生对话框已提交：${projectPath}`);
  else logger.warn(`[traework] 原生对话框操作失败：${res.message}`);
  return res;
}
