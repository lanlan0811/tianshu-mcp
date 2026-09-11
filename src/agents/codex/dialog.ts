/**
 * Codex 原生文件夹选择器驱动（开发计划决策 3：键盘自动化原生对话框）。
 *
 * Codex「创建项目 → 源文件夹」会弹出 Windows 原生对话框（标题 Select Project Root /
 * 选择文件夹）。CDP 无法触达原生窗口，故用 UIA + SendInput 键盘自动化：
 *   基线枚举 → 定位新对话框 → 地址栏填入绝对路径并回车导航 → 点击确认按钮 → 等关闭。
 *
 * 安全约束（与 ZCode 一致，fail-closed）：
 * - 只操作「基线中不存在」的新对话框，绝不碰用户既有窗口。
 * - 只认属于 ChatGPT.exe 根进程、类名为 #32770、标题匹配选择类的窗口。
 * - 任一步无法唯一定位即抛错，不猜。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const WINDOWS_LIST_SCRIPT = String.raw`
Add-Type @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class TianshuCodexDlg { public delegate bool EnumProc(IntPtr h, IntPtr l); [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l); [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p); }
'@
$ids=($env:TIANSHU_CODEX_PIDS -split ',')
$out=@()
[TianshuCodexDlg]::EnumWindows({param($h,$l) $b=New-Object Text.StringBuilder 256; [void][TianshuCodexDlg]::GetClassName($h,$b,$b.Capacity); [uint32]$ownerPid=0; [void][TianshuCodexDlg]::GetWindowThreadProcessId($h,[ref]$ownerPid); if($b.ToString() -eq '#32770' -and $ids -contains [string]$ownerPid){$script:out += [string]$h.ToInt64()}; return $true},[IntPtr]::Zero)|Out-Null
$out -join ','`;

const WINDOWS_SELECT_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class TianshuCodexNative {
  public const uint BM_CLICK = 0x00F5;
  public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  public const uint MOUSEEVENTF_LEFTUP = 0x0004;
  public const uint KEYEVENTF_KEYUP = 0x0002;
  public const uint KEYEVENTF_UNICODE = 0x0004;
  public const uint INPUT_KEYBOARD = 1;
  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
  [StructLayout(LayoutKind.Explicit)]
  public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public HARDWAREINPUT hi; }
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT { public uint type; public INPUTUNION u; }
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
  [DllImport("user32.dll")] public static extern void keybd_event(byte virtualKey, byte scanCode, uint flags, UIntPtr extraInfo);
  public static void SendUnicodeText(string text) {
    foreach(char ch in text) {
      var inputs = new INPUT[2];
      inputs[0].type = INPUT_KEYBOARD; inputs[0].u.ki.wScan = ch; inputs[0].u.ki.dwFlags = KEYEVENTF_UNICODE;
      inputs[1].type = INPUT_KEYBOARD; inputs[1].u.ki.wScan = ch; inputs[1].u.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
      if(SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT))) != 2) throw new InvalidOperationException("Unicode SendInput failed");
    }
  }
}
'@
$baseline=($env:TIANSHU_DIALOG_BASELINE -split ',')
$owners=($env:TIANSHU_CODEX_PIDS -split ',')
# 用 Win32 EnumWindows 直接找对话框句柄：比 UIA RootElement.Children 更可靠
# （实测 Codex 的 Select Project Root 通过 UIA 顶层枚举会漏掉，但 EnumWindows 能找到）。
$deadline=(Get-Date).AddSeconds(20)
$targetHandle=$null
do {
  $script:found=@()
  [TianshuCodexNative]::EnumWindows({param($h,$l)
    if([TianshuCodexNative]::IsWindowVisible($h)){
      $cls=New-Object Text.StringBuilder 256; [void][TianshuCodexNative]::GetClassName($h,$cls,256)
      if($cls.ToString() -eq '#32770'){
        $t=New-Object Text.StringBuilder 512; [void][TianshuCodexNative]::GetWindowText($h,$t,512)
        [uint32]$p=0; [void][TianshuCodexNative]::GetWindowThreadProcessId($h,[ref]$p)
        if($baseline -notcontains ([string]$h.ToInt64()) -and $owners -contains ([string]$p) -and $t.ToString() -match 'Select Project Root|选择|打开|Select|Choose|Browse'){
          $script:found += $h.ToInt64()
        }
      }
    }
    return $true
  },[IntPtr]::Zero)|Out-Null
  $handles=@($script:found | Sort-Object -Unique)
  if($handles.Count -gt 1){throw "Codex 文件夹对话框无法唯一定位（匹配 $($handles.Count)）"}
  if($handles.Count -eq 1){$targetHandle=[string]$handles[0]}
  if(-not $targetHandle){Start-Sleep -Milliseconds 200}
} while(-not $targetHandle -and (Get-Date) -lt $deadline)
if(-not $targetHandle){throw '未发现 Codex 新建的文件夹对话框'}
$window=[System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][Int64]$targetHandle)
$controls=$window.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
$addressBar=$null; $addressCount=0; $addressEdit=$null; $editCount=0
foreach($candidate in $controls){
  $automationId=[string]$candidate.Current.AutomationId
  if($automationId -eq '1001'){$addressBar=$candidate;$addressCount++}
  if($automationId -eq '41477' -and $candidate.Current.ClassName -eq 'Edit' -and $candidate.Current.NativeWindowHandle -ne 0){$addressEdit=$candidate;$editCount++}
}
if($editCount -gt 1){throw "Codex 文件夹地址输入框无法唯一定位（匹配 $editCount）"}
if($editCount -eq 0){
  if($addressCount -ne 1){throw "Codex 文件夹地址栏无法唯一定位（匹配 $addressCount）"}
  $addressRect=$addressBar.Current.BoundingRectangle
  if($addressRect.Width -lt 20 -or $addressRect.Height -lt 10){throw 'Codex 文件夹地址栏边界无效'}
  $addressX=[int]($addressRect.X+$addressRect.Width-8); $addressY=[int]($addressRect.Y+$addressRect.Height/2)
}
$activationAttempt=0
$editDeadline=(Get-Date).AddSeconds(10)
do {
  if($editCount -eq 0 -and $activationAttempt -in @(0,3)){
    [void][TianshuCodexNative]::SetForegroundWindow([IntPtr][Int64]$targetHandle)
    Start-Sleep -Milliseconds 150
    if([TianshuCodexNative]::GetForegroundWindow().ToInt64() -eq [Int64]$targetHandle){
      [TianshuCodexNative]::keybd_event(0x11,0,0,[UIntPtr]::Zero)
      [TianshuCodexNative]::keybd_event(0x4c,0,0,[UIntPtr]::Zero)
      [TianshuCodexNative]::keybd_event(0x4c,0,2,[UIntPtr]::Zero)
      [TianshuCodexNative]::keybd_event(0x11,0,2,[UIntPtr]::Zero)
    }
  } elseif($editCount -eq 0 -and $activationAttempt -in @(1,4)) {
    [void][TianshuCodexNative]::SetForegroundWindow([IntPtr][Int64]$targetHandle)
    Start-Sleep -Milliseconds 150
    [void][TianshuCodexNative]::SetCursorPos($addressX,$addressY)
    [TianshuCodexNative]::mouse_event([TianshuCodexNative]::MOUSEEVENTF_LEFTDOWN,0,0,0,[UIntPtr]::Zero)
    [TianshuCodexNative]::mouse_event([TianshuCodexNative]::MOUSEEVENTF_LEFTUP,0,0,0,[UIntPtr]::Zero)
  }
  $activationAttempt++
  Start-Sleep -Milliseconds 250
  $window=$null
  try { $window=[System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][Int64]$targetHandle) } catch [System.Windows.Automation.ElementNotAvailableException] { $window=$null }
  $addressEdit=$null; $editCount=0
  if($window){
    try {
      $controls=$window.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
      foreach($candidate in $controls){if([string]$candidate.Current.AutomationId -eq '41477' -and $candidate.Current.ClassName -eq 'Edit' -and $candidate.Current.NativeWindowHandle -ne 0){$addressEdit=$candidate;$editCount++}}
    } catch [System.Windows.Automation.ElementNotAvailableException] {$editCount=0}
  }
} while($editCount -ne 1 -and (Get-Date) -lt $editDeadline)
if($editCount -ne 1){throw "Codex 文件夹地址输入框无法唯一定位（匹配 $editCount）"}
$addressEditHandle=[IntPtr]$addressEdit.Current.NativeWindowHandle
[void][TianshuCodexNative]::SetForegroundWindow([IntPtr][Int64]$targetHandle)
Start-Sleep -Milliseconds 150
$editRect=$addressEdit.Current.BoundingRectangle
[void][TianshuCodexNative]::SetCursorPos([int]($editRect.X+$editRect.Width/2),[int]($editRect.Y+$editRect.Height/2))
[TianshuCodexNative]::mouse_event([TianshuCodexNative]::MOUSEEVENTF_LEFTDOWN,0,0,0,[UIntPtr]::Zero)
[TianshuCodexNative]::mouse_event([TianshuCodexNative]::MOUSEEVENTF_LEFTUP,0,0,0,[UIntPtr]::Zero)
Start-Sleep -Milliseconds 100
if([TianshuCodexNative]::GetForegroundWindow().ToInt64() -ne [Int64]$targetHandle){throw 'Codex 文件夹地址输入前对话框未保持前台'}
[TianshuCodexNative]::keybd_event(0x11,0,0,[UIntPtr]::Zero)
[TianshuCodexNative]::keybd_event(0x41,0,0,[UIntPtr]::Zero)
[TianshuCodexNative]::keybd_event(0x41,0,[TianshuCodexNative]::KEYEVENTF_KEYUP,[UIntPtr]::Zero)
[TianshuCodexNative]::keybd_event(0x11,0,[TianshuCodexNative]::KEYEVENTF_KEYUP,[UIntPtr]::Zero)
[TianshuCodexNative]::SendUnicodeText($env:TIANSHU_CODEX_FOLDER)
$targetNorm=[IO.Path]::GetFullPath($env:TIANSHU_CODEX_FOLDER).TrimEnd('\').Replace('\','/').ToLowerInvariant()
Start-Sleep -Milliseconds 200
if([TianshuCodexNative]::GetForegroundWindow().ToInt64() -ne [Int64]$targetHandle){throw 'Codex 路径提交前对话框未保持前台'}
[TianshuCodexNative]::keybd_event(0x0d,0,0,[UIntPtr]::Zero)
[TianshuCodexNative]::keybd_event(0x0d,0,[TianshuCodexNative]::KEYEVENTF_KEYUP,[UIntPtr]::Zero)
$navigated=$false
$navigationDeadline=(Get-Date).AddSeconds(15)
do {
  Start-Sleep -Milliseconds 200
  $window=$null
  try { $window=[System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][Int64]$targetHandle) } catch [System.Windows.Automation.ElementNotAvailableException] { $window=$null }
  if($window){
    try {
      $controls=$window.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
      foreach($candidate in $controls){
        if([string]$candidate.Current.AutomationId -eq '1001' -and $candidate.Current.ClassName -eq 'ToolbarWindow32'){
          $locationName=([string]$candidate.Current.Name).Replace('\','/').ToLowerInvariant()
          if($locationName.Contains($targetNorm)){$navigated=$true;break}
        }
      }
    } catch [System.Windows.Automation.ElementNotAvailableException] {}
  }
} while(-not $navigated -and (Get-Date) -lt $navigationDeadline)
if(-not $navigated){throw 'Codex 文件夹对话框未导航到目标绝对路径'}
$confirmButton=$null; $confirmCount=0; $confirmReady=$false
$confirmDeadline=(Get-Date).AddSeconds(5)
do {
  $window=$null
  try { $window=[System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][Int64]$targetHandle) } catch [System.Windows.Automation.ElementNotAvailableException] { $window=$null }
  if(-not $window){$confirmCount=0;$confirmReady=$false;Start-Sleep -Milliseconds 200;continue}
  try {
    $controls=$window.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
    $confirmButton=$null; $confirmCount=0
    foreach($candidate in $controls){if([string]$candidate.Current.AutomationId -eq '1' -and $candidate.Current.ClassName -eq 'Button' -and $candidate.Current.NativeWindowHandle -ne 0){$confirmButton=$candidate;$confirmCount++}}
    $confirmReady=$confirmCount -eq 1 -and $confirmButton.Current.IsEnabled -and $confirmButton.Current.NativeWindowHandle -ne 0
  } catch [System.Windows.Automation.ElementNotAvailableException] {$confirmCount=0;$confirmReady=$false}
  if(-not $confirmReady){Start-Sleep -Milliseconds 200}
} while(-not $confirmReady -and (Get-Date) -lt $confirmDeadline)
if(-not $confirmReady){throw "Codex 文件夹确认按钮未就绪（匹配 $confirmCount）"}
[void][TianshuCodexNative]::SendMessage([IntPtr]$confirmButton.Current.NativeWindowHandle,[TianshuCodexNative]::BM_CLICK,[IntPtr]::Zero,[IntPtr]::Zero)
$closeDeadline=(Get-Date).AddSeconds(5)
do {
  Start-Sleep -Milliseconds 200
  $stillOpen=$false
  $script:still=@()
  [TianshuCodexNative]::EnumWindows({param($h,$l) if(([string]$h.ToInt64()) -eq $targetHandle -and [TianshuCodexNative]::IsWindowVisible($h)){$script:still += 1};return $true},[IntPtr]::Zero)|Out-Null
  if($script:still.Count -gt 0){$stillOpen=$true}
} while($stillOpen -and (Get-Date) -lt $closeDeadline)
if($stillOpen){throw 'Codex 文件夹对话框提交后仍未关闭'}`;

/**
 * 关闭属于指定进程的残留原生对话框。
 * 上一轮失败可能留下「Select Project Root」等窗口，它会遮挡界面、
 * 并让下一次运行把「无新对话框」误判为失败。只操作我们自己 pid 的 #32770。
 */
export async function closeStrayDialogs(pids: number[]): Promise<number> {
  if (process.platform !== "win32" || pids.length === 0) return 0;
  const script = String.raw`
$ErrorActionPreference='SilentlyContinue'
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class TianshuCodexDlgClose {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
}
'@
$owners=($env:TIANSHU_CODEX_PIDS -split ',')
$script:closed=0
[TianshuCodexDlgClose]::EnumWindows({param($h,$l)
  if([TianshuCodexDlgClose]::IsWindowVisible($h)){
    $c=New-Object Text.StringBuilder 256; [void][TianshuCodexDlgClose]::GetClassName($h,$c,256)
    if($c.ToString() -eq '#32770'){
      [uint32]$p=0; [void][TianshuCodexDlgClose]::GetWindowThreadProcessId($h,[ref]$p)
      if($owners -contains ([string]$p)){ [void][TianshuCodexDlgClose]::SendMessage($h,0x0010,[IntPtr]::Zero,[IntPtr]::Zero); $script:closed++ }
    }
  }
  return $true
},[IntPtr]::Zero)|Out-Null
Write-Output $script:closed`;
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-Command", script],
      { env: { ...process.env, TIANSHU_CODEX_PIDS: pids.join(",") }, windowsHide: true, timeout: 30_000 },
    );
    return Number(stdout.trim()) || 0;
  } catch {
    return 0;
  }
}

/** 枚举属于指定 PID 的原生 #32770 对话框句柄（基线用） */
export async function listCodexDialogs(pids: number[]): Promise<string[]> {
  if (process.platform !== "win32") return [];
  // Add-Type 首次编译内联 C# 可能耗时 10s+（冷启动），超时需放宽；
  // 失败时返回空基线而非抛错：选择步骤自身仍会做类名/标题/属主/新窗口校验，
  // 不会因为基线枚举的一次抖动而让整个任务失败。
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-Command", WINDOWS_LIST_SCRIPT],
      {
        env: { ...process.env, TIANSHU_CODEX_PIDS: pids.join(",") },
        windowsHide: true,
        timeout: 45_000,
      },
    );
    return stdout.trim() ? stdout.trim().split(",") : [];
  } catch {
    return [];
  }
}

/**
 * 在原生文件夹对话框中选择目录：地址栏填绝对路径 → 回车导航 → 点确认 → 等关闭。
 * 使用反斜杠分隔符（Windows 原生对话框要求）。
 */
export async function selectCodexFolder(
  folder: string,
  ownerPids: number[],
  baseline: string[],
): Promise<{ ok: boolean; needsPermission?: boolean; message: string }> {
  if (process.platform !== "win32")
    return { ok: false, message: `Codex 原生文件夹对话框驱动仅支持 Windows（当前 ${process.platform}）` };
  const winPath = folder.split(/[\\/]+/).join("\\");
  try {
    await execFileAsync("powershell.exe", ["-NoProfile", "-Command", WINDOWS_SELECT_SCRIPT], {
      env: {
        ...process.env,
        TIANSHU_CODEX_FOLDER: winPath,
        TIANSHU_CODEX_PIDS: ownerPids.join(","),
        TIANSHU_DIALOG_BASELINE: baseline.join(","),
      },
      windowsHide: true,
      timeout: 90_000,
    });
    return { ok: true, message: "Codex 原生文件夹对话框已提交并完成路径回读" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, message: msg };
  }
}
