import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const WINDOWS_LIST_SCRIPT = String.raw`
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
Add-Type -AssemblyName UIAutomationClient
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class TianshuDialogNative {
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
$deadline=(Get-Date).AddSeconds(15)
$window=$null
do {
  $root=[System.Windows.Automation.AutomationElement]::RootElement
  $wins=$root.FindAll([System.Windows.Automation.TreeScope]::Children,[System.Windows.Automation.Condition]::TrueCondition)
  foreach($w in $wins){$h=[string]$w.Current.NativeWindowHandle; $dialogOwnerPid=[string]$w.Current.ProcessId; $title=[string]$w.Current.Name; if($w.Current.ClassName -eq '#32770' -and $baseline -notcontains $h -and $owners -contains $dialogOwnerPid -and $title -match '选择|打开|Select|Choose|Browse|Open'){$window=$w;break}}
  if(-not $window){Start-Sleep -Milliseconds 200}
} while(-not $window -and (Get-Date) -lt $deadline)
if(-not $window){throw '未发现 ZCode 新建的文件夹对话框'}
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
$editDeadline=(Get-Date).AddSeconds(10)
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
  $root=[System.Windows.Automation.AutomationElement]::RootElement
  $wins=$root.FindAll([System.Windows.Automation.TreeScope]::Children,[System.Windows.Automation.Condition]::TrueCondition)
  $window=$null
  foreach($candidateWindow in $wins){if([string]$candidateWindow.Current.NativeWindowHandle -eq $targetHandle){$window=$candidateWindow;break}}
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
[TianshuDialogNative]::SendUnicodeText($env:TIANSHU_ZCODE_FOLDER)
$targetNorm=[IO.Path]::GetFullPath($env:TIANSHU_ZCODE_FOLDER).TrimEnd('\').Replace('\','/').ToLowerInvariant()
Start-Sleep -Milliseconds 200
if([TianshuDialogNative]::GetForegroundWindow().ToInt64() -ne [Int64]$targetHandle){throw 'ZCode 路径提交前对话框未保持前台'}
[TianshuDialogNative]::keybd_event(0x0d,0,0,[UIntPtr]::Zero)
[TianshuDialogNative]::keybd_event(0x0d,0,[TianshuDialogNative]::KEYEVENTF_KEYUP,[UIntPtr]::Zero)
$navigated=$false
$navigationDeadline=(Get-Date).AddSeconds(15)
do {
  Start-Sleep -Milliseconds 200
  $root=[System.Windows.Automation.AutomationElement]::RootElement
  $wins=$root.FindAll([System.Windows.Automation.TreeScope]::Children,[System.Windows.Automation.Condition]::TrueCondition)
  $window=$null
  foreach($candidateWindow in $wins){if([string]$candidateWindow.Current.NativeWindowHandle -eq $targetHandle){$window=$candidateWindow;break}}
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
$confirmButton=$null
$confirmCount=0
$confirmReady=$false
$confirmDeadline=(Get-Date).AddSeconds(5)
do {
  $root=[System.Windows.Automation.AutomationElement]::RootElement
  $wins=$root.FindAll([System.Windows.Automation.TreeScope]::Children,[System.Windows.Automation.Condition]::TrueCondition)
  $window=$null
  foreach($candidateWindow in $wins){if([string]$candidateWindow.Current.NativeWindowHandle -eq $targetHandle){$window=$candidateWindow;break}}
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
[void][TianshuDialogNative]::SendMessage([IntPtr]$confirmButton.Current.NativeWindowHandle,[TianshuDialogNative]::BM_CLICK,[IntPtr]::Zero,[IntPtr]::Zero)
$closeDeadline=(Get-Date).AddSeconds(5)
do {
  Start-Sleep -Milliseconds 200
  $stillOpen=$false
  $root=[System.Windows.Automation.AutomationElement]::RootElement
  $wins=$root.FindAll([System.Windows.Automation.TreeScope]::Children,[System.Windows.Automation.Condition]::TrueCondition)
  foreach($w in $wins){if([string]$w.Current.NativeWindowHandle -eq $targetHandle){$stillOpen=$true;break}}
} while($stillOpen -and (Get-Date) -lt $closeDeadline)
if($stillOpen){throw 'ZCode 文件夹对话框提交后仍未关闭'}`;

export async function listOwnedDialogs(pids: number[]): Promise<string[]> {
  if (process.platform === "darwin") {
    const script = `tell application "System Events"
tell process "ZCode"
  set total to 0
  repeat with w in windows
    set total to total + (count of sheets of w)
  end repeat
  return "sheet-count:" & total
end tell
end tell`;
    try {
      const { stdout } = await execFileAsync("osascript", ["-e", script], { timeout: 10_000 });
      return [stdout.trim() || "sheet-count:0"];
    } catch {
      return ["sheet-count:0"];
    }
  }
  if (process.platform !== "win32") return [];
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-Command", WINDOWS_LIST_SCRIPT],
    {
      env: { ...process.env, TIANSHU_ZCODE_PIDS: pids.join(",") },
      windowsHide: true,
      timeout: 10_000,
    },
  );
  return stdout.trim() ? stdout.trim().split(",") : [];
}

export async function selectZcodeFolder(
  folder: string,
  ownerPids: number[],
  baseline: string[],
): Promise<{ ok: boolean; needsPermission?: boolean; message: string }> {
  if (process.platform === "win32") {
    try {
      await execFileAsync("powershell.exe", ["-NoProfile", "-Command", WINDOWS_SELECT_SCRIPT], {
        env: {
          ...process.env,
          TIANSHU_ZCODE_FOLDER: folder,
          TIANSHU_ZCODE_PIDS: ownerPids.join(","),
          TIANSHU_DIALOG_BASELINE: baseline.join(","),
        },
        windowsHide: true,
        timeout: 20_000,
      });
      return { ok: true, message: "Windows 文件夹对话框已提交并完成路径回读" };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }
  if (process.platform === "darwin") {
    const baselineCount = Number(/^sheet-count:(\d+)$/.exec(baseline[0] ?? "")?.[1] ?? 0);
    const script = `on run argv
set targetFolder to item 1 of argv
set baselineCount to (item 2 of argv) as integer
tell application "System Events"
  if UI elements enabled is false then error "ACCESSIBILITY_PERMISSION_REQUIRED"
  tell process "ZCode"
    set frontmost to true
    set deadline to (current date) + 15
    repeat
      set total to 0
      repeat with w in windows
        set total to total + (count of sheets of w)
      end repeat
      if total > baselineCount then exit repeat
      if (current date) > deadline then error "NEW_ZCODE_FOLDER_SHEET_NOT_FOUND"
      delay 0.2
    end repeat
    keystroke "g" using {command down, shift down}
    delay 0.3
    keystroke targetFolder
    key code 36
    delay 0.5
    set targetSheet to sheet 1 of window 1
    set submitted to false
    set defaultButtons to every button of targetSheet whose subrole is "AXDefaultButton"
    if (count of defaultButtons) is 1 then
      click item 1 of defaultButtons
      set submitted to true
    end if
    if submitted is false then
      repeat with buttonName in {"Choose", "Open", "选择", "打开"}
        if exists button buttonName of targetSheet then
          click button buttonName of targetSheet
          set submitted to true
          exit repeat
        end if
      end repeat
    end if
    if submitted is false then error "ZCODE_FOLDER_CONFIRM_BUTTON_NOT_FOUND"
    set closeDeadline to (current date) + 5
    repeat
      set total to 0
      repeat with w in windows
        set total to total + (count of sheets of w)
      end repeat
      if total is less than or equal to baselineCount then exit repeat
      if (current date) > closeDeadline then error "ZCODE_FOLDER_SHEET_STILL_OPEN"
      delay 0.2
    end repeat
  end tell
end tell
end run`;
    try {
      await execFileAsync("osascript", ["-e", script, folder, String(baselineCount)], {
        timeout: 20_000,
      });
      return { ok: true, message: "macOS 文件夹面板已提交" };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        needsPermission: /ACCESSIBILITY_PERMISSION_REQUIRED|not authorized|辅助功能/i.test(msg),
        message: msg,
      };
    }
  }
  return { ok: false, message: `ZCode 文件夹对话框不支持平台 ${process.platform}` };
}
