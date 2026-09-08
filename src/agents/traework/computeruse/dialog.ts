/**
 * 原生「选择文件夹」对话框驱动（图3）。
 *
 * 仅在「选择文件夹」下拉未命中已有项目时使用（决策 10）。这是本 MCP 唯一
 * 会触碰 Windows 原生 UI 的路径，且必须经 guard.ts 白名单校验。
 *
 * 实现：PowerShell + Win32 EnumWindows（找窗口）+ UI Automation（定位控件）+ Win32 消息（写/点）。
 *
 * 实测关键结论（2026-09-08）：
 *   1. **PowerShell 冷启动约 4.5–6s**，与用 UIA 还是 Win32 探测无关 → 等待必须放在
 *      单次 PowerShell 调用内轮询，不能在 Node 侧反复 spawn。
 *   2. 该对话框是 TraeWork 的**拥有者窗口**（class `#32770`），UIA 顶层子窗口看不到，
 *      必须用 Win32 `EnumWindows` 按标题找。
 *   3. **脚本必须纯 ASCII**：控制台代码页会把中文 literal 变乱码（`-match '选择文件夹'`
 *      永不命中、错误信息在 Node 侧读成乱码）→ 输出用英文，Node 侧映射回中文。
 *   4. **中文路径不能用 SendKeys/剪贴板**（会被代码页破坏）→ 用 Win32 `WM_SETTEXT` 写入。
 *   5. **写入后必须回读校验**（`WM_GETTEXT`）：`WM_SETTEXT` 的返回值不足以证明写入成功，
 *      若静默失败而仍然点击确认，就会「选中当前目录」——这正是 v0.1.6 的真实故障。
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

/** 探测到的文件夹选择对话框 */
export interface FolderDialogInfo {
  /** 原生窗口句柄（十进制整数，可跨 PowerShell 调用传递） */
  hwnd: number;
  windowTitle: string;
  processName: string;
}

/** 等待原生对话框出现的最长时间（单次 PowerShell 调用内轮询） */
const DIALOG_WAIT_MS = 30_000;

/** 对话框出现后等待其 UIA 子树就绪（定位编辑框）的最长时间 */
const EDIT_WAIT_MS = 8_000;

/** 写入路径的尝试次数（每次都会回读校验） */
const WRITE_ATTEMPTS = 3;

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

/** 解析 PowerShell 输出的最后一条结果行（`FOUND|...` / `NONE||` / `OK|...` / `ERR|...`） */
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

/** 公共 C# P/Invoke 声明（找窗口 + 发消息 + 点击） */
const CS_PINVOKE = `
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
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, string l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, StringBuilder l);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
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
`;

/** 列出当前所有可见的文件夹选择对话框（含 hwnd） */
export async function listFolderDialogs(): Promise<FolderDialogInfo[]> {
  if (process.platform !== "win32") return [];
  const ps = `
$ErrorActionPreference='SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type @'
${CS_PINVOKE}
'@
$script:list = New-Object System.Collections.ArrayList
[void][TWDlg]::EnumWindows({ param($h, $l)
  $sb = New-Object System.Text.StringBuilder 512
  [void][TWDlg]::GetWindowText($h, $sb, 512)
  $t = $sb.ToString()
  $cb = New-Object System.Text.StringBuilder 64
  [void][TWDlg]::GetClassName($h, $cb, 64)
  # ASCII-only match: the folder picker is class #32770 titled "Select Project Folder".
  if (($t -match 'Select Project Folder|Select Folder') -and ($cb.ToString() -eq '#32770')) {
    if ([TWDlg]::IsWindowVisible($h)) {
      $procId = 0
      [void][TWDlg]::GetWindowThreadProcessId($h, [ref]$procId)
      [void]$script:list.Add([IntPtr]$h)
    }
  }
  return $true
}, [IntPtr]::Zero)
foreach ($h in $script:list) {
  $procId = 0
  [void][TWDlg]::GetWindowThreadProcessId($h, [ref]$procId)
  $p = (Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName
  Write-Output ('DLG|' + $h.ToInt64() + '|' + $p)
}
`;
  const res = await runPowerShell(ps, { timeoutMs: DIALOG_WAIT_MS });
  const out: FolderDialogInfo[] = [];
  for (const raw of res.stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("DLG|")) continue;
    const [, hwnd, proc] = line.split("|");
    const n = Number(hwnd);
    if (!Number.isFinite(n) || n === 0) continue;
    out.push({ hwnd: n, windowTitle: "Select Project Folder", processName: proc ? `${proc}.exe` : "" });
  }
  return out;
}

/**
 * 探测是否存在文件夹选择对话框（返回第一个匹配项，兼容旧调用）。
 * 新增：返回 hwnd，便于后续操作同一窗口。
 */
export async function findFolderDialog(): Promise<{ found: boolean; windowTitle: string; processName: string; hwnd: number }> {
  const all = await listFolderDialogs();
  const first = all[0];
  if (!first) return { found: false, windowTitle: "", processName: "", hwnd: 0 };
  return { found: true, windowTitle: first.windowTitle, processName: first.processName, hwnd: first.hwnd };
}

/**
 * 关闭遗留的文件夹选择对话框（上次运行失败残留）。
 * 绑定新项目前调用，避免自动化写到旧窗口上。
 * @returns 关闭的窗口数
 */
export async function closeStaleFolderDialogs(logger: AgentRunLogger): Promise<number> {
  if (process.platform !== "win32") return 0;
  const dialogs = await listFolderDialogs();
  if (dialogs.length === 0) return 0;

  logger.warn(`[traework] 检测到 ${dialogs.length} 个遗留的「选择文件夹」对话框，先关闭：${dialogs.map((d) => d.hwnd).join(", ")}`);
  const ps = `
$ErrorActionPreference='SilentlyContinue'
Add-Type @'
${CS_PINVOKE}
'@
$hwnds = $env:TRAEWORK_DLG_CLOSE_HWNDS -split ','
foreach ($s in $hwnds) {
  $n = 0
  if ([int64]::TryParse($s, [ref]$n)) {
    $h = [IntPtr]$n
    if ([TWDlg]::IsWindow($h)) { [void][TWDlg]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) }
  }
}
Start-Sleep -Milliseconds 800
Write-Output 'CLOSED'
`;
  await runPowerShell(ps, { env: { TRAEWORK_DLG_CLOSE_HWNDS: dialogs.map((d) => String(d.hwnd)).join(",") } });
  return dialogs.length;
}

/**
 * 在对话框中写入路径并确认（单次 PowerShell 调用内完成「定位 → 写入 → 回读校验 → 确认」）。
 *
 * 之所以把等待也放进同一个脚本：PowerShell 冷启动约 4.5–6s，若在 Node 侧反复
 * spawn 轮询，预算很快被吃光；放进脚本内则以 ~400ms 间隔轮询，代价仅一次启动。
 */
export function buildSetPathScript(): string {
  // 实测踩坑（必须处理）：
  //   1. 路径经 JS 模板字面量直接插入会被解释（\t → 制表符）→ 改用环境变量传递。
  //   2. 输入/点击前必须**强制把对话框置于前台**：第三方工具（如 Snipaste 截图器）
  //      会抢焦点，导致点击落到别的窗口。
  //   3. 对话框是 TraeWork 的**拥有者窗口**，用 Win32 EnumWindows 按标题找最稳。
  //   4. 脚本必须纯 ASCII（见文件头注释）。
  //   5. **写入后必须回读校验**：WM_SETTEXT 返回值不足以证明成功，必须 WM_GETTEXT 比对。
  return `
$ErrorActionPreference='Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
${CS_PINVOKE}
'@
$targetPath = $env:TRAEWORK_DLG_PATH
if (-not $targetPath) { Write-Output 'ERR|no target path'; exit 0 }
$waitMs = [int]$env:TRAEWORK_DLG_WAIT_MS
if (-not $waitMs -or $waitMs -le 0) { $waitMs = 30000 }
$editWaitMs = [int]$env:TRAEWORK_DLG_EDIT_WAIT_MS
if (-not $editWaitMs -or $editWaitMs -le 0) { $editWaitMs = 8000 }
$attempts = [int]$env:TRAEWORK_DLG_WRITE_ATTEMPTS
if (-not $attempts -or $attempts -le 0) { $attempts = 3 }
$wantHwnd = 0
if ($env:TRAEWORK_DLG_HWND) { [void][int64]::TryParse($env:TRAEWORK_DLG_HWND, [ref]$wantHwnd) }

function Norm-Path($p) {
  if (-not $p) { return '' }
  return ($p.Replace('/', [char]92)).TrimEnd([char]92)
}
$wantNorm = Norm-Path $targetPath

function Find-DlgHwnd {
  $script:found = [IntPtr]::Zero
  [void][TWDlg]::EnumWindows({ param($h, $l)
    $sb = New-Object System.Text.StringBuilder 512
    [void][TWDlg]::GetWindowText($h, $sb, 512)
    $t = $sb.ToString()
    $cb = New-Object System.Text.StringBuilder 64
    [void][TWDlg]::GetClassName($h, $cb, 64)
    if (($t -match 'Select Project Folder|Select Folder') -and ($cb.ToString() -eq '#32770')) {
      if ([TWDlg]::IsWindowVisible($h)) { $script:found = $h }
    }
    return $true
  }, [IntPtr]::Zero)
  return $script:found
}

# 优先使用调用方指定的 hwnd（保证操作的就是刚弹出的那个窗口）
$hwnd = [IntPtr]::Zero
if ($wantHwnd -ne 0) {
  $h = [IntPtr]$wantHwnd
  if ([TWDlg]::IsWindow($h)) { $hwnd = $h }
}
if ($hwnd -eq [IntPtr]::Zero) {
  $deadline = (Get-Date).AddMilliseconds($waitMs)
  while ((Get-Date) -lt $deadline) {
    $hwnd = Find-DlgHwnd
    if ($hwnd -ne [IntPtr]::Zero) { break }
    Start-Sleep -Milliseconds 400
  }
}
if ($hwnd -eq [IntPtr]::Zero) { Write-Output 'ERR|dialog not found'; exit 0 }
Write-Output ('HWND|' + $hwnd.ToInt64())

[TWDlg]::Force($hwnd)
Start-Sleep -Milliseconds 800

$dlg = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
if (-not $dlg) { Write-Output 'ERR|cannot get UIA element from hwnd'; exit 0 }

# 定位「文件夹」编辑框：AutomationId=1152 且 ClassName=Edit（列表项也用 1152，必须区分）。
# 对话框刚出现时 UIA 子树可能尚未就绪 → 轮询等待，而不是单次 FindAll 就放弃。
function Find-Edit {
  foreach ($e in $dlg.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
    if ($e.Current.AutomationId -eq '1152' -and $e.Current.ClassName -eq 'Edit') { return $e }
  }
  return $null
}
$edit = $null
$editDeadline = (Get-Date).AddMilliseconds($editWaitMs)
while ((Get-Date) -lt $editDeadline) {
  $edit = Find-Edit
  if ($edit) { break }
  Start-Sleep -Milliseconds 300
}
if (-not $edit) { Write-Output 'ERR|folder edit box not found'; exit 0 }
$editHwnd = [IntPtr]$edit.Current.NativeWindowHandle
if ($editHwnd -eq [IntPtr]::Zero) { Write-Output 'ERR|folder edit box has no native handle'; exit 0 }

# 写入 + 回读校验（最多 $attempts 次）。校验失败绝不点击确认，避免选中错误目录。
# WM_SETTEXT=0x000C, WM_GETTEXT=0x000D
$written = $false
for ($i = 1; $i -le $attempts; $i++) {
  [void][TWDlg]::SendMessage($editHwnd, 0x000C, [IntPtr]::Zero, $targetPath)
  Start-Sleep -Milliseconds 400
  $buf = New-Object System.Text.StringBuilder 1024
  [void][TWDlg]::SendMessage($editHwnd, 0x000D, [IntPtr]1024, $buf)
  $got = Norm-Path $buf.ToString()
  Write-Output ('READBACK|' + $i + '|' + $buf.ToString())
  if ($got -ieq $wantNorm) { $written = $true; break }
  Start-Sleep -Milliseconds 300
}
if (-not $written) { Write-Output 'ERR|path write verification failed'; exit 0 }

# 确认按钮：AutomationId=1 且 ControlType=Pane，且矩形位于对话框下半部（排除同名 Pane 误命中）。
function Find-Confirm {
  $dlgRect = $dlg.Current.BoundingRectangle
  $midY = $dlgRect.Y + ($dlgRect.Height / 2)
  foreach ($e in $dlg.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
    if ($e.Current.AutomationId -eq '1' -and $e.Current.ControlType.ProgrammaticName -eq 'ControlType.Pane') {
      $r = $e.Current.BoundingRectangle
      if ($r.Width -gt 0 -and $r.Height -gt 0 -and $r.Y -ge $midY) { return $e }
    }
  }
  return $null
}
$btn = $null
$btnDeadline = (Get-Date).AddMilliseconds(3000)
while ((Get-Date) -lt $btnDeadline) {
  $btn = Find-Confirm
  if ($btn) { break }
  Start-Sleep -Milliseconds 300
}
if (-not $btn) { Write-Output 'ERR|confirm control (AutomationId=1, Pane, lower half) not found'; exit 0 }
$br = $btn.Current.BoundingRectangle
[TWDlg]::Click([int]($br.X + $br.Width/2), [int]($br.Y + $br.Height/2))

# 复查：必须是我们操作的那个 hwnd 已消失（而不是「任意匹配窗口消失」）
$gone = $false
$closeDeadline = (Get-Date).AddMilliseconds(8000)
while ((Get-Date) -lt $closeDeadline) {
  if (-not [TWDlg]::IsWindow($hwnd)) { $gone = $true; break }
  Start-Sleep -Milliseconds 300
}
if ($gone) { Write-Output 'OK|path verified and dialog closed'; exit 0 }
Write-Output 'ERR|dialog still open after confirm click'
exit 0
`;
}

/**
 * 把内部规范化路径（小写盘符 + 正斜杠，见 util/path.ts normPath）转成 Windows 原生形式。
 *
 * 实测（2026-09-08）：原生文件夹选择器**不接受** `d:/a/b` 这种正斜杠形式——写入后
 * 回读虽一致，但点击确认时对话框不会关闭（路径未被接受）。必须转成 `D:\a\b`。
 */
export function toNativeWindowsPath(p: string): string {
  if (!p) return p;
  let out = p.replace(/\//g, "\\");
  if (/^[a-zA-Z]:/.test(out)) out = out.charAt(0).toUpperCase() + out.slice(1);
  return out;
}

/** PowerShell 脚本内部用 ASCII 输出（避免控制台代码页乱码），此处映射回中文 */
export function localizeDialogMessage(msg: string): string {
  const map: Record<string, string> = {
    "no target path": "未提供目标路径",
    "dialog not found": "原生「选择文件夹」对话框未出现",
    "cannot get UIA element from hwnd": "无法从窗口句柄取得 UIA 元素",
    "folder edit box not found": "未找到「文件夹」输入框（AutomationId=1152 且 ClassName=Edit）",
    "folder edit box has no native handle": "「文件夹」输入框没有原生窗口句柄",
    "path write verification failed": "路径写入后回读校验失败（未点击确认，避免选中错误目录）",
    "path verified and dialog closed": "路径已写入并通过回读校验，对话框已关闭",
    "dialog still open after confirm click": "点击确认后对话框仍存在",
    "confirm control (AutomationId=1, Pane, lower half) not found": "未找到确认按钮（AutomationId=1 且为 Pane，且位于对话框下半部）",
  };
  return map[msg] ?? msg;
}

/** 在对话框中写入路径并确认（异步，单次 PowerShell 调用） */
async function setPathAndConfirm(projectPath: string, hwnd: number, logger: AgentRunLogger): Promise<NativeDialogResult> {
  // 关键：必须用原生 Windows 形式（D:\a\b）——正斜杠/小写盘符会被选择器拒绝。
  const nativePath = toNativeWindowsPath(projectPath);
  const res = await runPowerShell(buildSetPathScript(), {
    // 路径经环境变量传递，避免 JS 模板字面量转义问题（\t 等）
    env: {
      TRAEWORK_DLG_PATH: nativePath,
      TRAEWORK_DLG_WAIT_MS: String(DIALOG_WAIT_MS),
      TRAEWORK_DLG_EDIT_WAIT_MS: String(EDIT_WAIT_MS),
      TRAEWORK_DLG_WRITE_ATTEMPTS: String(WRITE_ATTEMPTS),
      TRAEWORK_DLG_HWND: String(hwnd),
    },
    timeoutMs: DIALOG_WAIT_MS + 60_000,
  });
  // 记录脚本全过程输出（HWND/READBACK 等），排障时是唯一的一手证据
  const trace = res.stdout.trim().replace(/\r?\n/g, " / ").slice(0, 600);
  if (trace) logger.info(`[traework] 对话框脚本输出: ${trace}`);
  if (res.stderr.trim()) logger.warn(`[traework] 对话框脚本 stderr: ${res.stderr.trim().slice(0, 300)}`);
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
 * @param opts.hwnd 调用方（footer 点击后）已探测到的对话框句柄，保证操作同一窗口；
 *                  缺省时自行等待对话框出现。
 */
export async function pickFolderViaNativeDialog(
  projectPath: string,
  opts: { logger: AgentRunLogger; hwnd?: number },
): Promise<NativeDialogResult> {
  const { logger } = opts;

  if (process.platform !== "win32") {
    return {
      ok: false,
      message:
        "当前平台不支持自动驱动原生「选择文件夹」对话框（macOS 分支未验证）。请在 TraeWork 里手动打开该项目一次，之后即可在下拉中命中。",
    };
  }

  // 确定目标对话框：优先用调用方给的 hwnd；否则自行等待出现。
  let hwnd = opts.hwnd ?? 0;
  let info: FolderDialogInfo | undefined;
  if (hwnd > 0) {
    info = (await listFolderDialogs()).find((d) => d.hwnd === hwnd);
  }
  if (!info) {
    const deadline = Date.now() + DIALOG_WAIT_MS;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const all = await listFolderDialogs();
      const first = all[0];
      if (first) {
        info = first;
        hwnd = first.hwnd;
        break;
      }
      if (Date.now() >= deadline) break;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 1_500));
    }
  }
  if (!info || hwnd <= 0) {
    return {
      ok: false,
      message: "未检测到原生「选择文件夹」对话框（TraeWork 未弹出或已关闭；请检查下拉底部按钮是否被点到）",
    };
  }

  // 硬边界：白名单校验（仅允许 AI-Agent 的文件夹选择对话框）
  try {
    assertAllowed({ windowTitle: info.windowTitle, processName: info.processName, intent: "选择项目文件夹" });
  } catch (e) {
    const msg = e instanceof ComputerUseDeniedError ? e.message : String(e);
    logger.error(`[traework] computer-use 守卫拒绝: ${msg}`);
    return { ok: false, message: msg };
  }

  logger.info(`[traework] 原生对话框已确认（窗口「${info.windowTitle}」进程「${info.processName}」hwnd=${hwnd}），写入路径并回读校验…`);
  const res = await setPathAndConfirm(projectPath, hwnd, logger);
  if (res.ok) logger.info(`[traework] 原生对话框已提交：${projectPath}`);
  else logger.warn(`[traework] 原生对话框操作失败：${res.message}`);
  return res;
}
