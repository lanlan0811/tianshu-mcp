/**
 * 原生「选择文件夹」对话框驱动（图3）。
 *
 * 仅在「选择文件夹」下拉未命中已有项目时使用（决策 10）。这是本 MCP 唯一
 * 会触碰 Windows 原生 UI 的路径，且必须经 guard.ts 白名单校验。
 *
 * 实现：PowerShell + System.Windows.Automation（UI Automation）：
 *   1. 按标题找到对话框窗口（Select Project Folder / 选择项目文件夹）
 *   2. guard 校验窗口标题 + 宿主进程
 *   3. 把项目绝对路径写入「文件夹:」编辑框
 *   4. 点击「选择文件夹」按钮
 *
 * macOS 分支 fail-closed：明确报错并提示用户手动先在 TraeWork 打开该项目。
 */
import { spawnSync } from "node:child_process";
import { assertAllowed, ComputerUseDeniedError } from "./guard.js";
import type { AgentRunLogger } from "../../adapter.js";

export interface NativeDialogResult {
  ok: boolean;
  message: string;
}

/** 等待原生对话框出现的最长时间 */
const DIALOG_WAIT_MS = 15_000;

/**
 * 探测原生文件夹对话框是否出现（返回标题与进程名）。
 *
 * 实测（2026-09-08，TraeWork 1.107.1）：该对话框不是顶层窗口，
 * 而是 TraeWork 主窗口的 **后代窗口**（UIA TreeScope.Children 看不到，
 * 必须用 Descendants）。标题为英文 `Select Project Folder`。
 */
export function findFolderDialog(): { found: boolean; windowTitle: string; processName: string } {
  if (process.platform !== "win32") return { found: false, windowTitle: "", processName: "" };
  const ps = `
$ErrorActionPreference='SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$winCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
$pattern = 'Select Project Folder|选择项目文件夹|选择文件夹|Select Folder'
$found = $null
# 1) 顶层窗口
$tops = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $winCond)
foreach ($w in $tops) { if ($w.Current.Name -match $pattern) { $found = $w; break } }
# 2) 后代窗口（实测该对话框挂在 TraeWork 主窗口下）
if (-not $found) {
  foreach ($w in $tops) {
    if ($w.Current.Name -match 'TraeWork|TRAE') {
      $desc = $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, $winCond)
      foreach ($d in $desc) { if ($d.Current.Name -match $pattern) { $found = $d; break } }
    }
    if ($found) { break }
  }
}
if ($found) {
  $procId = $found.Current.ProcessId
  $p = (Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName
  Write-Output ("FOUND|" + $found.Current.Name + "|" + $p)
  exit 0
}
Write-Output "NONE||"
`;
  const res = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], {
    encoding: "utf8",
    windowsHide: true,
    timeout: DIALOG_WAIT_MS,
  });
  const out = (res.stdout ?? "").trim();
  const line = out.split(/\r?\n/).find((l) => l.startsWith("FOUND|") || l === "NONE||");
  if (!line || line === "NONE||") return { found: false, windowTitle: "", processName: "" };
  const [, title, proc] = line.split("|");
  return { found: true, windowTitle: title ?? "", processName: proc ? `${proc}.exe` : "" };
}

/** 等待对话框出现 */
async function waitForDialog(logger: AgentRunLogger): Promise<{ found: boolean; windowTitle: string; processName: string }> {
  const deadline = Date.now() + DIALOG_WAIT_MS;
  while (Date.now() < deadline) {
    const d = findFolderDialog();
    if (d.found) return d;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 800));
  }
  logger.warn("[traework] 等待原生「选择文件夹」对话框超时");
  return { found: false, windowTitle: "", processName: "" };
}

/** 在对话框中写入路径并确认 */
function setPathAndConfirm(projectPath: string): NativeDialogResult {
  // 实测（TraeWork 1.107.1）：这是 Win32 传统文件夹选择器（class #32770，DirectUI 绘制），
  // UIA 只暴露部分控件：
  //   - 「文件夹:」输入框 id=1152 是 Pane（无 ValuePattern）
  //   - 确认按钮「选择文件夹」id=1 是 Pane（无 InvokePattern）→ 坐标点击
  //
  // 三个实测踩坑（必须处理）：
  //   1. 路径经 JS 模板字面量直接插入会被解释（\t → 制表符）→ 改用环境变量传递，
  //      彻底规避 JS/PowerShell 双重转义（曾经 JSON.stringify 导致反斜杠翻倍）。
  //   2. 输入/点击前必须**强制把对话框置于前台**：第三方工具（如 Snipaste 截图器）
  //      会抢焦点，导致 SendKeys 与坐标点击落到别的窗口（实测踩坑）。
  //      用 AttachThreadInput + BringWindowToTop + SetForegroundWindow 强制激活。
  const ps = `
$ErrorActionPreference='Continue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
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
if (-not $targetPath) { Write-Output 'ERR|未提供目标路径'; exit 0 }

function Find-Dlg {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $winCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
  $pat = 'Select Project Folder|选择项目文件夹|选择文件夹|Select Folder'
  $tops = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $winCond)
  foreach ($w in $tops) { if ($w.Current.Name -match $pat) { return $w } }
  foreach ($w in $tops) {
    if ($w.Current.Name -match 'TraeWork|TRAE') {
      foreach ($d in $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, $winCond)) { if ($d.Current.Name -match $pat) { return $d } }
    }
  }
  return $null
}
$dlg = Find-Dlg
if (-not $dlg) { Write-Output 'ERR|对话框未找到'; exit 0 }

$hwnd = [IntPtr]$dlg.Current.NativeWindowHandle
[TWDlg]::Force($hwnd)
Start-Sleep -Milliseconds 800

# 先试标准 Edit + ValuePattern（部分 Windows 版本可用）
$editBox = $null
foreach ($id in @('1150','1152')) {
  $c = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, $id)
  $e = $dlg.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $c)
  if ($e) {
    $vpObj = $null
    if ($e.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vpObj)) { $editBox = $e; break }
  }
}
if ($editBox) {
  $vp = $editBox.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
  $vp.SetValue($targetPath)
  Start-Sleep -Milliseconds 700
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  Start-Sleep -Milliseconds 1500
  if (-not (Find-Dlg)) { Write-Output 'OK|已通过 ValuePattern 提交路径'; exit 0 }
}

# 回退：点中「文件夹:」输入框 → 粘贴路径 → 回车
Set-Clipboard -Value $targetPath
$target = $null
foreach ($id in @('1152','1150')) {
  $c = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, $id)
  $target = $dlg.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $c)
  if ($target) { break }
}
if ($target) {
  $r = $target.Current.BoundingRectangle
  if ($r.Width -gt 0) { [TWDlg]::Click([int]($r.X + $r.Width/2), [int]($r.Y + $r.Height/2)); Start-Sleep -Milliseconds 400 }
}
[System.Windows.Forms.SendKeys]::SendWait('^a')
Start-Sleep -Milliseconds 250
[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds 900
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
Start-Sleep -Milliseconds 1800

# 若对话框仍在，坐标点击「选择文件夹」
$still = Find-Dlg
if ($still) {
  [TWDlg]::Force([IntPtr]$still.Current.NativeWindowHandle)
  Start-Sleep -Milliseconds 500
  $id1 = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, '1')
  $btn = $still.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $id1)
  if ($btn -and $btn.Current.Name -match '选择文件夹|Select Folder') {
    $br = $btn.Current.BoundingRectangle
    if ($br.Width -gt 0 -and $br.Height -gt 0) {
      [TWDlg]::Click([int]($br.X + $br.Width/2), [int]($br.Y + $br.Height/2))
      Start-Sleep -Milliseconds 1500
      if (-not (Find-Dlg)) { Write-Output 'OK|已通过坐标点击确认按钮'; exit 0 }
      Write-Output 'ERR|点击确认后对话框仍存在'
      exit 0
    }
  }
  Write-Output 'ERR|确认按钮未找到或不可点击'
  exit 0
}
Write-Output 'OK|已通过剪贴板粘贴提交路径'
`;
  const res = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
    // 路径经环境变量传递，避免 JS 模板字面量转义问题（\t 等）
    env: { ...process.env, TRAEWORK_DLG_PATH: projectPath },
  });
  const out = (res.stdout ?? "").trim();
  const line = out.split(/\r?\n/).find((l) => l.startsWith("OK|") || l.startsWith("ERR|"));
  if (!line) return { ok: false, message: `原生对话框操作无输出（stderr: ${(res.stderr ?? "").slice(0, 200)}）` };
  const [tag, msg] = line.split("|");
  return { ok: tag === "OK", message: msg ?? "" };
}

/**
 * 驱动原生「选择文件夹」对话框选中指定项目目录。
 * 所有窗口操作前先过 guard 白名单；非允许目标一律拒绝。
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

  const dlg = await waitForDialog(logger);
  if (!dlg.found) {
    return { ok: false, message: "未检测到原生「选择文件夹」对话框（TraeWork 可能未弹出或已被关闭）" };
  }

  // 硬边界：白名单校验（仅允许 AI-Agent 的文件夹选择对话框）
  try {
    assertAllowed({ windowTitle: dlg.windowTitle, processName: dlg.processName, intent: "选择项目文件夹" });
  } catch (e) {
    const msg = e instanceof ComputerUseDeniedError ? e.message : String(e);
    logger.error(`[traework] computer-use 守卫拒绝: ${msg}`);
    return { ok: false, message: msg };
  }

  logger.info(`[traework] 原生对话框已确认（窗口「${dlg.windowTitle}」进程「${dlg.processName}」），写入路径…`);
  const res = setPathAndConfirm(projectPath);
  if (res.ok) logger.info(`[traework] 原生对话框已提交：${projectPath}`);
  else logger.warn(`[traework] 原生对话框操作失败：${res.message}`);
  return res;
}
