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
[TianshuDlg]::EnumWindows({param($h,$l) $b=New-Object Text.StringBuilder 256; [void][TianshuDlg]::GetClassName($h,$b,$b.Capacity); [uint32]$pid=0; [void][TianshuDlg]::GetWindowThreadProcessId($h,[ref]$pid); if($b.ToString() -eq '#32770' -and $ids -contains [string]$pid){$script:out += [string]$h.ToInt64()}; return $true},[IntPtr]::Zero)|Out-Null
$out -join ','`;

const WINDOWS_SELECT_SCRIPT = String.raw`
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName System.Windows.Forms
$baseline=($env:TIANSHU_DIALOG_BASELINE -split ',')
$owners=($env:TIANSHU_ZCODE_PIDS -split ',')
$deadline=(Get-Date).AddSeconds(15)
$window=$null
do {
  $root=[System.Windows.Automation.AutomationElement]::RootElement
  $wins=$root.FindAll([System.Windows.Automation.TreeScope]::Children,[System.Windows.Automation.Condition]::TrueCondition)
  foreach($w in $wins){$h=[string]$w.Current.NativeWindowHandle; $pid=[string]$w.Current.ProcessId; $title=[string]$w.Current.Name; if($w.Current.ClassName -eq '#32770' -and $baseline -notcontains $h -and $owners -contains $pid -and $title -match '选择|打开|Select|Choose|Browse|Open'){$window=$w;break}}
  if(-not $window){Start-Sleep -Milliseconds 200}
} while(-not $window -and (Get-Date) -lt $deadline)
if(-not $window){throw '未发现 ZCode 新建的文件夹对话框'}
$edits=$window.FindAll([System.Windows.Automation.TreeScope]::Descendants,(New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Edit)))
$edit=$null
foreach($e in $edits){if($e.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$null)){$edit=$e;break}}
if(-not $edit){[System.Windows.Forms.SendKeys]::SendWait('%d');Start-Sleep -Milliseconds 200;$edits=$window.FindAll([System.Windows.Automation.TreeScope]::Descendants,(New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Edit)));$edit=$edits[$edits.Count-1]}
$pattern=$edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
$pattern.SetValue($env:TIANSHU_ZCODE_FOLDER)
if([IO.Path]::GetFullPath($pattern.Current.Value).TrimEnd('\') -ne [IO.Path]::GetFullPath($env:TIANSHU_ZCODE_FOLDER).TrimEnd('\')){throw '文件夹路径回读不一致'}
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')`;

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
    if exists button "Choose" of sheet 1 of window 1 then click button "Choose" of sheet 1 of window 1
    if exists button "Open" of sheet 1 of window 1 then click button "Open" of sheet 1 of window 1
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
