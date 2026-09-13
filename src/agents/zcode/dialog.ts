import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import { ZCODE_SETUP_DEFAULTS } from "../../config/schema.js";
export interface NativeDialogOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  platform?: NodeJS.Platform;
  onProgress?: (stage: string) => void;
}

export function parseMacSheetBaseline(baseline: string[]): number | null {
  if (baseline.length !== 1) return null;
  const matched = /^sheet-count:(\d+)$/.exec(baseline[0] ?? "");
  if (!matched) return null;
  const count = Number(matched[1]);
  return Number.isSafeInteger(count) ? count : null;
}

export function validateMacSheetBaseline(
  baseline: string[],
): { ok: true; count: 0 } | { ok: false; message: string } {
  const count = parseMacSheetBaseline(baseline);
  if (count == null) return { ok: false, message: "macOS ZCode 文件夹面板基线无效，拒绝自动化" };
  if (count !== 0)
    return {
      ok: false,
      message: `检测到 ${count} 个既有 ZCode sheet，无法唯一证明新文件夹面板，拒绝自动化`,
    };
  return { ok: true, count: 0 };
}

const WINDOWS_LIST_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
Add-Type @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class TianshuDlg { public delegate bool EnumProc(IntPtr h, IntPtr l); [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l); [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p); }
'@
$ids=($env:TIANSHU_ZCODE_PIDS -split ',')
$out=@()
[TianshuDlg]::EnumWindows({param($h,$l) $b=New-Object Text.StringBuilder 256; [void][TianshuDlg]::GetClassName($h,$b,$b.Capacity); [uint32]$dialogOwnerPid=0; [void][TianshuDlg]::GetWindowThreadProcessId($h,[ref]$dialogOwnerPid); if($b.ToString() -eq '#32770' -and $ids -contains [string]$dialogOwnerPid){$script:out += [string]$h.ToInt64()}; return $true},[IntPtr]::Zero)|Out-Null
$out -join ','`;

const WINDOWS_SELECT_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
$operationDeadline=[DateTimeOffset]::FromUnixTimeMilliseconds([Int64]$env:TIANSHU_DIALOG_DEADLINE).LocalDateTime
function Assert-Deadline { if((Get-Date) -ge $operationDeadline){throw 'ZCODE_DIALOG_TIMEOUT'} }
Write-Output 'native:initialize'

Add-Type -AssemblyName UIAutomationClient
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class TianshuDialogNative {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
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
  public struct INPUTUNION {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
    [FieldOffset(0)] public HARDWAREINPUT hi;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT { public uint type; public INPUTUNION u; }
  [DllImport("user32.dll", CharSet = CharSet.Auto)]
  public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]
  public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
  [DllImport("user32.dll")]
  public static extern void keybd_event(byte virtualKey, byte scanCode, uint flags, UIntPtr extraInfo);
  public static void SendUnicodeText(string text) {
    foreach(char ch in text) {
      var inputs = new INPUT[2];
      inputs[0].type = INPUT_KEYBOARD;
      inputs[0].u.ki.wScan = ch;
      inputs[0].u.ki.dwFlags = KEYEVENTF_UNICODE;
      inputs[1].type = INPUT_KEYBOARD;
      inputs[1].u.ki.wScan = ch;
      inputs[1].u.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
      if(SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT))) != 2) throw new InvalidOperationException("Unicode SendInput failed");
    }
  }
}
'@
$baseline=($env:TIANSHU_DIALOG_BASELINE -split ',')
$owners=($env:TIANSHU_ZCODE_PIDS -split ',')
function Get-OwnedDialogs {
  $script:ownedHandles=@()
  [TianshuDialogNative]::EnumWindows({param($h,$l)
    [uint32]$ownerId=0
    [void][TianshuDialogNative]::GetWindowThreadProcessId($h,[ref]$ownerId)
    if($owners -contains [string]$ownerId){
      $class=New-Object Text.StringBuilder 256
      [void][TianshuDialogNative]::GetClassName($h,$class,$class.Capacity)
      if($class.ToString() -eq '#32770'){$script:ownedHandles += $h}
    }
    return $true
  },[IntPtr]::Zero)|Out-Null
  foreach($handle in $script:ownedHandles){[System.Windows.Automation.AutomationElement]::FromHandle($handle)}
}
function Get-TargetDialog {
  $handle=[IntPtr][Int64]$targetHandle
  if(-not [TianshuDialogNative]::IsWindow($handle)){return $null}
  [uint32]$ownerId=0
  [void][TianshuDialogNative]::GetWindowThreadProcessId($handle,[ref]$ownerId)
  if($owners -notcontains [string]$ownerId){throw 'ZCODE_DIALOG_OWNER_CHANGED'}
  return [System.Windows.Automation.AutomationElement]::FromHandle($handle)
}
$deadline=$operationDeadline
$window=$null
Write-Output 'native:find-owned-dialog'
do {
  $wins=@(Get-OwnedDialogs)
  $candidates=@()
  foreach($w in $wins){$h=[string]$w.Current.NativeWindowHandle; $dialogOwnerPid=[string]$w.Current.ProcessId; $title=[string]$w.Current.Name; if($w.Current.ClassName -eq '#32770' -and $baseline -notcontains $h -and $owners -contains $dialogOwnerPid -and $title -match '选择|打开|Select|Choose|Browse|Open'){$candidates += $w}}
  if($candidates.Count -gt 1){throw 'AMBIGUOUS_NEW_ZCODE_FOLDER_DIALOG'}
  if($candidates.Count -eq 1){$window=$candidates[0]}
  if(-not $window){Start-Sleep -Milliseconds 200}
} while(-not $window -and (Get-Date) -lt $deadline)
if(-not $window){throw '未发现 ZCode 新建的文件夹对话框'}
Write-Output 'native:find-address-control'
$targetHandle=[string]$window.Current.NativeWindowHandle
$controls=$window.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
$addressBar=$null
$addressCount=0
$addressEdit=$null
$editCount=0
foreach($candidate in $controls){
  $automationId=[string]$candidate.Current.AutomationId
  if($automationId -eq '1001'){$addressBar=$candidate;$addressCount++}
  if($automationId -eq '41477' -and $candidate.Current.ClassName -eq 'Edit' -and $candidate.Current.NativeWindowHandle -ne 0){$addressEdit=$candidate;$editCount++}
}
if($editCount -gt 1){throw "ZCode 文件夹地址输入框无法唯一定位（匹配 $editCount）"}
if($editCount -eq 0){
  if($addressCount -ne 1){throw "ZCode 文件夹地址栏无法唯一定位（匹配 $addressCount）"}
  $addressRect=$addressBar.Current.BoundingRectangle
  if($addressRect.Width -lt 20 -or $addressRect.Height -lt 10){throw 'ZCode 文件夹地址栏边界无效'}
  $addressX=[int]($addressRect.X+$addressRect.Width-8)
  $addressY=[int]($addressRect.Y+$addressRect.Height/2)
}
$activationAttempt=0
Write-Output 'native:activate-address-control'
$editDeadline=$operationDeadline
do {
  if($editCount -eq 0 -and $activationAttempt -in @(0,3)){
    [void][TianshuDialogNative]::SetForegroundWindow([IntPtr][Int64]$targetHandle)
    Start-Sleep -Milliseconds 150
    if([TianshuDialogNative]::GetForegroundWindow().ToInt64() -eq [Int64]$targetHandle){
      [TianshuDialogNative]::keybd_event(0x11,0,0,[UIntPtr]::Zero)
      [TianshuDialogNative]::keybd_event(0x4c,0,0,[UIntPtr]::Zero)
      [TianshuDialogNative]::keybd_event(0x4c,0,2,[UIntPtr]::Zero)
      [TianshuDialogNative]::keybd_event(0x11,0,2,[UIntPtr]::Zero)
    }
  } elseif($editCount -eq 0 -and $activationAttempt -in @(1,4)) {
    [void][TianshuDialogNative]::SetForegroundWindow([IntPtr][Int64]$targetHandle)
    Start-Sleep -Milliseconds 150
    [void][TianshuDialogNative]::SetCursorPos($addressX,$addressY)
    [TianshuDialogNative]::mouse_event([TianshuDialogNative]::MOUSEEVENTF_LEFTDOWN,0,0,0,[UIntPtr]::Zero)
    [TianshuDialogNative]::mouse_event([TianshuDialogNative]::MOUSEEVENTF_LEFTUP,0,0,0,[UIntPtr]::Zero)
  }
  $activationAttempt++
  Start-Sleep -Milliseconds 250
  $window=Get-TargetDialog
  $addressEdit=$null
  $editCount=0
  if($window){
    try {
      $controls=$window.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
      foreach($candidate in $controls){if([string]$candidate.Current.AutomationId -eq '41477' -and $candidate.Current.ClassName -eq 'Edit' -and $candidate.Current.NativeWindowHandle -ne 0){$addressEdit=$candidate;$editCount++}}
    } catch [System.Windows.Automation.ElementNotAvailableException] {$editCount=0}
  }
} while($editCount -ne 1 -and (Get-Date) -lt $editDeadline)
if($editCount -ne 1){throw "ZCode 文件夹地址输入框无法唯一定位（匹配 $editCount）"}
$addressEditHandle=[IntPtr]$addressEdit.Current.NativeWindowHandle
[void][TianshuDialogNative]::SetForegroundWindow([IntPtr][Int64]$targetHandle)
Start-Sleep -Milliseconds 150
$editRect=$addressEdit.Current.BoundingRectangle
[void][TianshuDialogNative]::SetCursorPos([int]($editRect.X+$editRect.Width/2),[int]($editRect.Y+$editRect.Height/2))
[TianshuDialogNative]::mouse_event([TianshuDialogNative]::MOUSEEVENTF_LEFTDOWN,0,0,0,[UIntPtr]::Zero)
[TianshuDialogNative]::mouse_event([TianshuDialogNative]::MOUSEEVENTF_LEFTUP,0,0,0,[UIntPtr]::Zero)
Start-Sleep -Milliseconds 100
if([TianshuDialogNative]::GetForegroundWindow().ToInt64() -ne [Int64]$targetHandle){throw 'ZCode 文件夹地址输入前对话框未保持前台'}
[TianshuDialogNative]::keybd_event(0x11,0,0,[UIntPtr]::Zero)
[TianshuDialogNative]::keybd_event(0x41,0,0,[UIntPtr]::Zero)
[TianshuDialogNative]::keybd_event(0x41,0,[TianshuDialogNative]::KEYEVENTF_KEYUP,[UIntPtr]::Zero)
[TianshuDialogNative]::keybd_event(0x11,0,[TianshuDialogNative]::KEYEVENTF_KEYUP,[UIntPtr]::Zero)
Assert-Deadline
Write-Output 'native:input-path'
[TianshuDialogNative]::SendUnicodeText($env:TIANSHU_ZCODE_FOLDER)
$targetNorm=[IO.Path]::GetFullPath($env:TIANSHU_ZCODE_FOLDER).TrimEnd('\').Replace('\','/').ToLowerInvariant()
Start-Sleep -Milliseconds 200
if([TianshuDialogNative]::GetForegroundWindow().ToInt64() -ne [Int64]$targetHandle){throw 'ZCode 路径提交前对话框未保持前台'}
[TianshuDialogNative]::keybd_event(0x0d,0,0,[UIntPtr]::Zero)
[TianshuDialogNative]::keybd_event(0x0d,0,[TianshuDialogNative]::KEYEVENTF_KEYUP,[UIntPtr]::Zero)
$navigated=$false
Write-Output 'native:verify-navigation'
$navigationDeadline=$operationDeadline
do {
  Start-Sleep -Milliseconds 200
  $window=Get-TargetDialog
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
if(-not $navigated){throw 'ZCode 文件夹对话框未导航到目标绝对路径'}
Write-Output 'native:find-confirm-button'
$confirmButton=$null
$confirmCount=0
$confirmReady=$false
$confirmDeadline=$operationDeadline
do {
  $window=Get-TargetDialog
  if(-not $window){$confirmCount=0;$confirmReady=$false;Start-Sleep -Milliseconds 200;continue}
  try {
    $controls=$window.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
    $confirmButton=$null
    $confirmCount=0
    foreach($candidate in $controls){if([string]$candidate.Current.AutomationId -eq '1' -and $candidate.Current.ClassName -eq 'Button' -and $candidate.Current.NativeWindowHandle -ne 0){$confirmButton=$candidate;$confirmCount++}}
    $confirmReady=$confirmCount -eq 1 -and $confirmButton.Current.IsEnabled -and $confirmButton.Current.NativeWindowHandle -ne 0
  } catch [System.Windows.Automation.ElementNotAvailableException] {$confirmCount=0;$confirmReady=$false}
  if(-not $confirmReady){Start-Sleep -Milliseconds 200}
} while(-not $confirmReady -and (Get-Date) -lt $confirmDeadline)
if(-not $confirmReady){throw "ZCode 文件夹确认按钮未就绪（匹配 $confirmCount）"}
Assert-Deadline
Write-Output 'native:submit-once'
[void][TianshuDialogNative]::SendMessage([IntPtr]$confirmButton.Current.NativeWindowHandle,[TianshuDialogNative]::BM_CLICK,[IntPtr]::Zero,[IntPtr]::Zero)
$closeDeadline=$operationDeadline
do {
  Start-Sleep -Milliseconds 200
  $stillOpen=$null -ne (Get-TargetDialog)
} while($stillOpen -and (Get-Date) -lt $closeDeadline)
if($stillOpen){throw 'ZCode 文件夹对话框提交后仍未关闭'}`;

/**
 * macOS NSOpenPanel 以**独立窗口**出现（3.11.2 实测：标题 "Open"，sheets 恒 0；
 * 旧的 sheet 语义在 macOS 找不到面板）。baseline 的 sheet-count:N 线格式保留，
 * 但语义 = ZCode 进程内标题命中面板集合的窗口数。
 */
const MAC_PANEL_TITLES = ["Open", "打开", "Choose", "选择", "选取"];
const MAC_PANEL_CONFIRM = ["Open", "打开", "Choose", "选择", "选取"];

const asList = (items: string[]): string => items.map((t) => `"${t}"`).join(", ");

export async function listOwnedDialogs(
  pids: number[],
  options: NativeDialogOptions = {},
): Promise<string[]> {
  const timeoutMs = options.timeoutMs ?? ZCODE_SETUP_DEFAULTS.dialogProbeTimeoutMs;
  const platform = options.platform ?? process.platform;
  if (platform === "darwin") {
    const script = `tell application "System Events"
set panelTitles to {${asList(MAC_PANEL_TITLES)}}
tell process "ZCode"
  set total to 0
  repeat with w in windows
    if (name of w) is in panelTitles then set total to total + 1
  end repeat
  return "sheet-count:" & total
end tell
end tell`;
    const { stdout } = await execFileAsync("osascript", ["-e", script], {
      timeout: timeoutMs,
      signal: options.signal,
    });
    const baseline = [stdout.trim()];
    if (parseMacSheetBaseline(baseline) === null) throw new Error("macOS 文件夹面板基线未知");
    return baseline;
  }
  if (platform !== "win32") return [];
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-Command", WINDOWS_LIST_SCRIPT],
    {
      env: { ...process.env, TIANSHU_ZCODE_PIDS: pids.join(",") },
      windowsHide: true,
      timeout: timeoutMs,
      signal: options.signal,
    },
  );
  return stdout.trim() ? stdout.trim().split(",") : [];
}

export async function selectZcodeFolder(
  folder: string,
  ownerPids: number[],
  baseline: string[],
  options: NativeDialogOptions = {},
): Promise<{ ok: boolean; needsPermission?: boolean; message: string }> {
  const timeoutMs = options.timeoutMs ?? ZCODE_SETUP_DEFAULTS.dialogOperationTimeoutMs;
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    try {
      const execution = execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-Command", WINDOWS_SELECT_SCRIPT],
        {
          env: {
            ...process.env,
            TIANSHU_ZCODE_FOLDER: folder,
            TIANSHU_ZCODE_PIDS: ownerPids.join(","),
            TIANSHU_DIALOG_BASELINE: baseline.join(","),
            TIANSHU_DIALOG_DEADLINE: String(Date.now() + timeoutMs),
          },
          windowsHide: true,
          timeout: timeoutMs,
          signal: options.signal,
        },
      );
      let output = "";
      execution.child?.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        const lines = output.split(/\r?\n/);
        output = lines.pop() ?? "";
        for (const line of lines) {
          if (!options.signal?.aborted && line.startsWith("native:")) options.onProgress?.(line);
        }
      });
      await execution;
      return { ok: true, message: "Windows 文件夹对话框已提交并完成路径回读" };
    } catch (e) {
      if (options.signal?.aborted) throw e;
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }
  if (platform === "darwin") {
    // macOS：面板是独立窗口（标题命中 MAC_PANEL_TITLES）。基线必须 0——存在旧面板时无法
    // 证明哪个是新面板，fail-closed 绝不操作可能属于用户的既有面板（与旧 sheet 语义一致）。
    const checkedBaseline = validateMacSheetBaseline(baseline);
    if (!checkedBaseline.ok) return checkedBaseline;
    const baselineCount = checkedBaseline.count;
    const script = `on run argv
set targetFolder to item 1 of argv
set baselineCount to (item 2 of argv) as integer
set operationDeadline to (current date) + ((item 3 of argv) as real)
if baselineCount is not 0 then error "EXISTING_ZCODE_SHEET_REFUSED"
tell application "System Events"
  if UI elements enabled is false then error "ACCESSIBILITY_PERMISSION_REQUIRED"
  set panelTitles to {${asList(MAC_PANEL_TITLES)}}
  set confirmNames to {${asList(MAC_PANEL_CONFIRM)}}
  tell process "ZCode"
    set frontmost to true
    set deadline to operationDeadline
    repeat
      set panelWins to {}
      repeat with w in windows
        if (name of w) is in panelTitles then set end of panelWins to w
      end repeat
      set total to count of panelWins
      if total is 1 then exit repeat
      if total > 1 then error "AMBIGUOUS_NEW_ZCODE_FOLDER_SHEET"
      if (current date) > deadline then error "NEW_ZCODE_FOLDER_SHEET_NOT_FOUND"
      delay 0.2
    end repeat
    set panelWin to item 1 of panelWins
    keystroke "g" using {command down, shift down}
    delay 0.5
    -- keystroke 会被中文输入法截获改写成乱码（实测拼音 IME 下路径变“特没谱…”），
    -- 且字段可能残留上次路径——必须 AX 直写 value（免疫 IME 与旧内容）
    if (count of sheets of panelWin) is 0 then error "ZCODE_GOTO_FIELD_NOT_OPEN"
    set value of text field 1 of sheet 1 of panelWin to targetFolder
    delay 0.3
    key code 36
    delay 0.8
    -- go-to 字段偶需二次回车确认；等其收起到最多 5s
    set gotoDeadline to (current date) + 5
    repeat
      if not (exists panelWin) then exit repeat
      set sheetCount to count of sheets of panelWin
      if sheetCount is 0 then exit repeat
      if (current date) > gotoDeadline then error "ZCODE_GOTO_FIELD_STUCK"
      key code 36
      delay 0.5
    end repeat
    if not (exists panelWin) then error "ZCODE_FOLDER_PANEL_VANISHED"
    -- 确认按钮：优先 AXDefaultButton，其次标题命中
    set submitted to false
    set sg to first splitter group of panelWin
    set defaultButtons to every button of sg whose subrole is "AXDefaultButton"
    if (count of defaultButtons) is 1 then
      click item 1 of defaultButtons
      set submitted to true
    end if
    if submitted is false then
      repeat with b in (every button of sg)
        if (name of b) is in confirmNames then
          click b
          set submitted to true
          exit repeat
        end if
      end repeat
    end if
    if submitted is false then error "ZCODE_FOLDER_CONFIRM_BUTTON_NOT_FOUND"
    set closeDeadline to operationDeadline
    repeat
      set total to 0
      repeat with w in windows
        if (name of w) is in panelTitles then set total to total + 1
      end repeat
      if total is 0 then exit repeat
      if (current date) > closeDeadline then error "ZCODE_FOLDER_SHEET_STILL_OPEN"
      delay 0.2
    end repeat
  end tell
end tell
end run`;
    try {
      await execFileAsync(
        "osascript",
        ["-e", script, folder, String(baselineCount), String(timeoutMs / 1000)],
        {
          timeout: timeoutMs,
          signal: options.signal,
        },
      );
      return { ok: true, message: "macOS 文件夹面板已提交" };
    } catch (e) {
      if (options.signal?.aborted) throw e;
      // 权限判定必须看 stderr 的 execution error 行——execFile 的 message 会内嵌完整脚本文本
      // （其中含 ACCESSIBILITY_PERMISSION_REQUIRED 字面量），曾把一切面板失败误报成权限问题。
      const err = e as { message?: string; stderr?: string };
      const detail = String(err.stderr ?? "");
      const msg = err.message ?? String(e);
      return {
        ok: false,
        // 只判 stderr：execFile 的 message 内嵌完整脚本文本（含 ACCESSIBILITY_PERMISSION_REQUIRED
        // 字面量），permissionError(e) 会把一切面板失败恒报成权限问题并跳过自动恢复——
        // 冲突裁决时曾因此把本修复又合并回去（二次引入，勿再并联）。
        needsPermission:
          /ACCESSIBILITY_PERMISSION_REQUIRED|not authorized|辅助功能|errAEEventNotPermitted|-1743/i.test(
            detail,
          ),
        message: msg,
      };
    }
  }
  return { ok: false, message: `ZCode 文件夹对话框不支持平台 ${process.platform}` };
}
