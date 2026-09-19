/**
 * Kimi Code 原生「添加工作区」对话框（Windows）。
 *
 * 真机实测（2026-09-20，Kimi Code 1.0.2 / Windows 10）：
 * - 点 `button.ws-action`（「选择文件夹…」）后弹出类名 `#32770`、标题 `添加工作区` 的对话框，
 *   宿主进程为 Kimi Code；
 * - 「文件夹」编辑框：AutomationId=1152 + ClassName=Edit，ControlType 是 Pane，
 *   **没有 ValuePattern** → 只能走 Win32 消息；
 * - 确认按钮「选择文件夹」AutomationId=1、取消 AutomationId=2，且**都不支持 UIA InvokePattern**
 *   → 必须用坐标点击；
 * - 路径必须写成原生形式（`D:\a\b`：盘符大写 + 反斜杠），原生选择器拒绝正斜杠形式。
 *
 * 因此写路径用 `WM_SETTEXT`（避免 CJK 被控制台代码页破坏）并立刻 `WM_GETTEXT` 回读，
 * 不一致绝不点确认。路径一律经环境变量传入脚本，**不拼进脚本源码**。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { ZCODE_SETUP_DEFAULTS } from "../../config/schema.js";

const execFileAsync = promisify(execFile);

export interface NativeDialogOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (stage: string) => void;
}

/** macOS 分支的固定说法（fail-closed，不写未验证的 osascript 流程） */
export const MACOS_FOLDER_DIALOG_UNAVAILABLE =
  "macOS 原生文件夹选择未实现（Kimi Code macOS 适配仍为 research）";

/** 把任务路径转成 Windows 原生形式：盘符大写 + 反斜杠（原生选择器拒绝正斜杠） */
export function toNativeDialogPath(value: string): string {
  let out = path.win32.normalize(value).replace(/\//g, "\\").replace(/\\+$/, "");
  // win32.normalize 会把「仅盘符」补成 `d:.`；对话框里要的是盘根 `D:\`。
  if (/^[a-zA-Z]:\.?$/.test(out)) out = `${out.slice(0, 2)}\\`;
  return out.replace(/^([a-z]):/, (_match, drive: string) => `${drive.toUpperCase()}:`);
}

const WINDOWS_LIST_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
Add-Type @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class TianshuKimicodeList { public delegate bool EnumProc(IntPtr h, IntPtr l); [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l); [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n); [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p); }
'@
$ids=($env:TIANSHU_KIMICODE_PIDS -split ',')
$out=@()
[TianshuKimicodeList]::EnumWindows({param($h,$l)
  [uint32]$dialogOwnerPid=0
  [void][TianshuKimicodeList]::GetWindowThreadProcessId($h,[ref]$dialogOwnerPid)
  if($ids -contains [string]$dialogOwnerPid){
    $cls=New-Object Text.StringBuilder 256
    [void][TianshuKimicodeList]::GetClassName($h,$cls,$cls.Capacity)
    if($cls.ToString() -eq '#32770'){
      $t=New-Object Text.StringBuilder 512
      [void][TianshuKimicodeList]::GetWindowText($h,$t,$t.Capacity)
      $script:out += "dialog:$($h.ToInt64()):$($t.ToString())"
    }
  }
  return $true
},[IntPtr]::Zero)|Out-Null
if($out.Count -eq 0){''} else {$out -join ','}`;

const WINDOWS_SELECT_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
$operationDeadline=[DateTimeOffset]::FromUnixTimeMilliseconds([Int64]$env:TIANSHU_DIALOG_DEADLINE).LocalDateTime
function Assert-Deadline { if((Get-Date) -ge $operationDeadline){throw 'KIMICODE_DIALOG_TIMEOUT'} }
Write-Output 'native:initialize'
Add-Type -AssemblyName UIAutomationClient
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class TianshuKimicodeDialog {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, string l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, StringBuilder l);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
  public const uint WM_SETTEXT = 0x000C;
  public const uint WM_GETTEXT = 0x000D;
  public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  public const uint MOUSEEVENTF_LEFTUP = 0x0004;
}
'@
$owners=($env:TIANSHU_KIMICODE_PIDS -split ',')
$baseline=@($env:TIANSHU_DIALOG_BASELINE -split ',' | Where-Object { $_ -ne '' })
$nativePath=$env:TIANSHU_KIMICODE_FOLDER
$dialogTitle=$env:TIANSHU_KIMICODE_DIALOG_TITLE
# 只操作「新出现」的对话框：基线与本次枚举使用同一身份格式 dialog:<hwnd>:<title>。
function Get-NewDialogHandles {
  $script:found=@()
  [TianshuKimicodeDialog]::EnumWindows({param($h,$l)
    [uint32]$dialogOwnerPid=0
    [void][TianshuKimicodeDialog]::GetWindowThreadProcessId($h,[ref]$dialogOwnerPid)
    if($owners -contains [string]$dialogOwnerPid){
      $cls=New-Object Text.StringBuilder 256
      [void][TianshuKimicodeDialog]::GetClassName($h,$cls,$cls.Capacity)
      if($cls.ToString() -eq '#32770'){
        $t=New-Object Text.StringBuilder 512
        [void][TianshuKimicodeDialog]::GetWindowText($h,$t,$t.Capacity)
        $identity="dialog:$($h.ToInt64()):$($t.ToString())"
        if($baseline -notcontains $identity){$script:found += $h}
      }
    }
    return $true
  },[IntPtr]::Zero)|Out-Null
  return $script:found
}
Write-Output 'native:find-new-dialog'
$dialogHandle=[IntPtr]::Zero
do {
  $handles=@(Get-NewDialogHandles)
  if($handles.Count -gt 1){throw 'AMBIGUOUS_NEW_KIMICODE_WORKSPACE_DIALOG'}
  if($handles.Count -eq 1){$dialogHandle=$handles[0]}
  if($dialogHandle -eq [IntPtr]::Zero){Start-Sleep -Milliseconds 200}
} while($dialogHandle -eq [IntPtr]::Zero -and (Get-Date) -lt $operationDeadline)
if($dialogHandle -eq [IntPtr]::Zero){throw '未发现 Kimi Code 新建的「添加工作区」对话框'}
$dialog=[System.Windows.Automation.AutomationElement]::FromHandle($dialogHandle)
# 标题只作诊断：守卫是「新出现 + 属目标进程 + 类名 #32770 + 唯一」四元组，
# 标题不符时如实在进度里报出来，不静默假定，也不据此放弃这台真实对话框。
$title=[string]$dialog.Current.Name
if($dialogTitle -ne '' -and $title -ne $dialogTitle){Write-Output "native:title-mismatch:$title"} else {Write-Output 'native:title-ok'}
Write-Output 'native:find-folder-edit'
$edit=$null
$editCount=0
foreach($candidate in $dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)){
  if([string]$candidate.Current.AutomationId -eq '1152' -and $candidate.Current.ClassName -eq 'Edit' -and $candidate.Current.NativeWindowHandle -ne 0){$edit=$candidate;$editCount++}
}
if($editCount -ne 1){throw "Kimi Code 工作区路径输入框无法唯一定位（匹配 $editCount）"}
$editHandle=[IntPtr]$edit.Current.NativeWindowHandle
Write-Output 'native:input-path'
$readbackOk=$false
$readback=''
for($attempt=1;$attempt -le 3;$attempt++){
  Assert-Deadline
  [void][TianshuKimicodeDialog]::SetForegroundWindow($dialogHandle)
  Start-Sleep -Milliseconds 100
  [void][TianshuKimicodeDialog]::SendMessage($editHandle,[TianshuKimicodeDialog]::WM_SETTEXT,[IntPtr]::Zero,$nativePath)
  Start-Sleep -Milliseconds 150
  $buffer=New-Object Text.StringBuilder 1024
  [void][TianshuKimicodeDialog]::SendMessage($editHandle,[TianshuKimicodeDialog]::WM_GETTEXT,[IntPtr]1024,$buffer)
  $readback=$buffer.ToString()
  $expected=[IO.Path]::GetFullPath($nativePath).TrimEnd('\')
  $actual=[IO.Path]::GetFullPath($readback).TrimEnd('\')
  if($actual -ieq $expected){$readbackOk=$true;break}
}
if(-not $readbackOk){throw "Kimi Code 工作区路径回读不一致（回读：$readback），未点确认"}
Write-Output 'native:find-confirm-button'
# 确认按钮 ControlType 是 Pane 且无 InvokePattern：只按 AutomationId=1 定位，并要求
# 其矩形落在对话框下半部（上半部是列表区，命中说明控件结构已漂移）。
$dialogRect=$dialog.Current.BoundingRectangle
$confirm=$null
$confirmCount=0
$confirmReady=$false
do {
  $dialog=[System.Windows.Automation.AutomationElement]::FromHandle($dialogHandle)
  $confirm=$null
  $confirmCount=0
  foreach($candidate in $dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)){
    if([string]$candidate.Current.AutomationId -eq '1' -and $candidate.Current.NativeWindowHandle -ne 0){$confirm=$candidate;$confirmCount++}
  }
  if($confirmCount -eq 1 -and $confirm.Current.IsEnabled){
    $rect=$confirm.Current.BoundingRectangle
    if($rect.Width -gt 0 -and $rect.Height -gt 0 -and ($rect.Y + $rect.Height/2) -gt ($dialogRect.Y + $dialogRect.Height/2)){$confirmReady=$true}
  }
  if(-not $confirmReady){Start-Sleep -Milliseconds 200}
} while(-not $confirmReady -and (Get-Date) -lt $operationDeadline)
if(-not $confirmReady){throw "Kimi Code 工作区确认按钮未就绪（匹配 $confirmCount）"}
Assert-Deadline
Write-Output 'native:submit-once'
[void][TianshuKimicodeDialog]::SetForegroundWindow($dialogHandle)
Start-Sleep -Milliseconds 150
$rect=$confirm.Current.BoundingRectangle
[void][TianshuKimicodeDialog]::SetCursorPos([int]($rect.X+$rect.Width/2),[int]($rect.Y+$rect.Height/2))
[TianshuKimicodeDialog]::mouse_event([TianshuKimicodeDialog]::MOUSEEVENTF_LEFTDOWN,0,0,0,[UIntPtr]::Zero)
[TianshuKimicodeDialog]::mouse_event([TianshuKimicodeDialog]::MOUSEEVENTF_LEFTUP,0,0,0,[UIntPtr]::Zero)
do {
  Start-Sleep -Milliseconds 200
  $stillOpen=[TianshuKimicodeDialog]::IsWindow($dialogHandle)
} while($stillOpen -and (Get-Date) -lt $operationDeadline)
if($stillOpen){throw 'Kimi Code 工作区对话框提交后仍未关闭'}
Write-Output 'native:done'`;

/**
 * 枚举目标进程当前拥有的 `#32770` 窗口，输出 `dialog:<hwnd>:<title>`。
 * 非 Windows 平台返回空集（Kimi Code 的 macOS 原生对话框未实现，不做未验证的枚举）。
 */
export async function listOwnedDialogs(
  pids: number[],
  options: NativeDialogOptions = {},
): Promise<string[]> {
  if (process.platform !== "win32") return [];
  const timeoutMs = options.timeoutMs ?? ZCODE_SETUP_DEFAULTS.dialogProbeTimeoutMs;
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-Command", WINDOWS_LIST_SCRIPT],
    {
      env: { ...process.env, TIANSHU_KIMICODE_PIDS: pids.join(",") },
      windowsHide: true,
      timeout: timeoutMs,
      signal: options.signal,
    },
  );
  const trimmed = stdout.trim();
  return trimmed ? trimmed.split(",") : [];
}

/**
 * 操作**新出现**的「添加工作区」对话框选定文件夹。
 * 基线由 listOwnedDialogs 在点击前采样：只有不在基线里的窗口才可能是本次弹出的。
 */
export async function selectKimicodeFolder(
  targetPath: string,
  ownerPids: number[],
  baseline: string[],
  options: NativeDialogOptions = {},
): Promise<{ ok: boolean; needsPermission?: boolean; message: string }> {
  if (process.platform === "darwin") return { ok: false, message: MACOS_FOLDER_DIALOG_UNAVAILABLE };
  if (process.platform !== "win32")
    return { ok: false, message: `Kimi Code 原生文件夹选择不支持平台 ${process.platform}` };
  const timeoutMs = options.timeoutMs ?? ZCODE_SETUP_DEFAULTS.dialogOperationTimeoutMs;
  // 路径只经环境变量进入脚本（脚本源码里没有路径字面量/插值），避免 CJK 被命令行代码页破坏。
  const nativePath = toNativeDialogPath(targetPath);
  if (!nativePath) return { ok: false, message: `工作区路径无效：${targetPath}` };
  try {
    const execution = execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-Command", WINDOWS_SELECT_SCRIPT],
      {
        env: {
          ...process.env,
          TIANSHU_KIMICODE_FOLDER: nativePath,
          TIANSHU_KIMICODE_PIDS: ownerPids.join(","),
          TIANSHU_KIMICODE_DIALOG_TITLE: "添加工作区",
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
    return { ok: true, message: "Windows「添加工作区」对话框已提交并完成路径回读" };
  } catch (e) {
    if (options.signal?.aborted) throw e;
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}