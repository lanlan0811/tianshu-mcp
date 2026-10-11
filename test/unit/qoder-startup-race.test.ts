/**
 * Qoder 启动竞态回归（真机缺陷，2026-10-11）。
 *
 * 真机现象（模型 Qwen3.8-Max，思考强度中，工作区 D:\Trae项目\AI游戏\Minecraft）：
 *   任务在**首次派发**时立即转 needs_user：
 *     agentEndReason: "login_required"
 *     message: "Qoder 工作界面不可用，请完成登录或引导后继续。"
 *   而 Qoder **已经启动成功**：日志显示「已启动 Qoder CN.exe，CDP 端口 9777」
 *   「已接入 Qoder CN 主工作台」。
 *
 * 真机时序（决定性）：
 *   06:34:44  任务启动
 *   06:34:46  启动 Qoder CN.exe（CDP 9777）
 *   06:34:59  判定 login_required      ← 距启动仅 13 秒
 *
 * 根因：`ensureInstance` 的「就绪」判据是「CDP 端口可连 + 有 page target」，
 * 这**不代表界面渲染完成**。`newTask`（`[data-e2e="chat.new"]`）要等 React 挂载后才出现，
 * 13 秒时还不存在 → `!await c.exists(...)` 为真 → 直接判 `login_required` 并停下。
 *
 * 关键证据：**同一实例在 2 分钟后所有锚点全部就绪**（实测 newTask / input / model / permission 全 OK）。
 * 即这不是「需要登录」，而是「界面还没渲染完」被误诊。
 *
 * 而适配器手上其实有 **120 秒**的 setup 预算（`setupRecoveryTimeoutMs`），却在这个判据上
 * 做了一次**瞬时检查**、完全没用预算——与同文件其他等待（line 112 等 `input`、line 145 等 `send`）
 * 形成鲜明对比：那些都用了有界等待，唯独这个「界面可用性」判据没有。
 *
 * 正解：改成**有界等待**（界面渲染完就继续；真的始终不出现才判 login_required）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const runTs = readFileSync(resolve(here, '../../src/agents/qoder/run.ts'), 'utf8');

describe('Qoder 启动竞态：界面可用性判据必须有界等待（真机回归）', () => {
  it('login_required 不得建立在一次瞬时 exists 检查上', () => {
    // 反例形态（真机 bug）：`if(!await c.exists(<任意参数>)) return pause('login_required', ...)`
    //
    // 注意正则别写 `[^)]*` —— exists 的参数常含嵌套括号（如 `c.selector('newTask')`），
    // 那样会在第一个 `)` 处提前断掉、把真实 bug 漏过去（本测试第一版就栽在这里）。
    // 用 `[\s\S]{0,120}?` 跨过整个参数区，允许嵌套。
    const instant = /if\s*\(\s*!\s*await\s+c\.exists\([\s\S]{0,120}?\)\s*\)\s*return\s*pause\(\s*'login_required'/;
    expect(
      instant.test(runTs),
      'login_required 不能由一次瞬时 exists 判定 —— 界面未渲染完会被误诊成需要登录（真机 13 秒时踩到）',
    ).toBe(false);
  });

  it('newTask 的可用性必须走有界等待（wait），而不是瞬时检查', () => {
    // 修复形态：用 wait(...) 等 newTask 出现，超时才落 login_required。
    // 变量名可能是 c 或 client（收窄后的局部常量），两种都接受。
    expect(
      /await\s+wait\(\s*async\s*\(\)\s*=>\s*await\s+\w+\.exists\(\s*\w+\.selector\(\s*['"]newTask['"]\s*\)\s*\)/.test(
        runTs,
      ),
      '必须以有界等待探测 newTask —— 与同文件其他等待（等 input / 等 send）同构',
    ).toBe(true);
  });

  it('等待超时后仍要 fail-closed 到 login_required（不能静默继续）', () => {
    // 修复不得削弱原有的 fail-closed 语义：真等不到就必须报 login_required
    expect(runTs, '超时后仍须保留 login_required 出口').toContain("login_required");
    expect(runTs, '超时后的文案应说明是「界面不可用」而非静默失败').toContain('工作界面不可用');
  });
});
