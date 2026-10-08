/**
 * lastRunSignal 提取契约（回归锁）。
 *
 * 背景（真机测试发现）：`fix-loop.ts` 的 onProgress 用 `/运行证据=([^；]+)/` 从适配器的
 * 进度 note 里提取 `lastRunSignal`，该字段是 query_task meta 的对外文档化字段
 * （usage-examples.md 明列）。codex / kimicode / minimax / opendesign / zcode
 * 五个适配器均按 `运行证据=` 契约书写 note；traework 曾用 `运行信号：` / `诊断：`，
 * 导致它的 `lastRunSignal` 永远为 undefined —— smoke 脚本的取消触发条件
 * （`status===running && lastRunSignal==="stop_button"`）因此永不成立，
 * 取消路径在真机上完全走不到。
 *
 * 本测试锁定「适配器 note 文案 → lastRunSignal」这一跨模块契约：
 *   1. 每个 GUI 适配器的 note 都能被 fix-loop 的正则提取出非空 evidence；
 *   2. traework 的两种 note 形态（运行中 / 静止）都能提取。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const REPO = path.resolve(__dirname, "../..");

/** fix-loop.ts 提取 lastRunSignal 用的正则（与生产实现逐字一致） */
const LAST_RUN_SIGNAL_RE = /运行证据=([^；]+)/;

/**
 * 从适配器源文件里抽出所有含 `运行证据=` 的 note 模板，
 * 并把 `${...}` 占位符替换为一个哨兵值，便于对正则行为做断言。
 */
function extractNotes(agentId: string): string[] {
  const file = path.join(REPO, "src", "agents", agentId, "run.ts");
  const src = fs.readFileSync(file, "utf8");
  const notes: string[] = [];
  // 先剥离行注释与块注释：注释里的说明文字（如「写成 运行证据=<值>；形式」）
  // 不是真实 note，不应被抽取——否则测试会对着注释断言。
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  // 抓取所有含「运行证据=」的模板字面量（支持跨行，如三元运算符的两个分支）
  for (const m of code.matchAll(/`([^`]*运行证据=[^`]*)`/g)) {
    notes.push(m[1]!.replace(/\$\{[^}]*\}/g, "SENTINEL"));
  }
  return notes;
}

const GUI_AGENTS = ["codex", "kimicode", "minimax", "opendesign", "zcode", "traework"];

describe("适配器进度 note 的 lastRunSignal 提取契约", () => {
  it.each(GUI_AGENTS)("%s 的 note 使用「运行证据=」契约且可被 fix-loop 提取", (agentId) => {
    const notes = extractNotes(agentId);
    expect(notes.length, `${agentId} 未找到任何含「运行证据=」的 note 模板`).toBeGreaterThan(0);
    for (const tpl of notes) {
      const m = LAST_RUN_SIGNAL_RE.exec(tpl);
      expect(m?.[1], `${agentId} 的 note 无法被 /运行证据=([^；]+)/ 提取`).toBeTruthy();
      // 值必须干净：正则的 [^；]+ 会吃进任何非「；」字符，若模板写成
      // `运行证据=X）`，提取结果会是 "X）" —— 破坏调用方的等值比较。
      expect(m![1], `${agentId} 提取出的 evidence 含尾随脏字符（值后应紧跟「；」）："${m![1]}"`)
        .toBe("SENTINEL");
    }
  });

  it("traework 运行中与静止两种 note 都能提取出非空 evidence", () => {
    const notes = extractNotes("traework");
    // 至少两条：running 分支与等待分支
    expect(notes.length, "traework 应有两个分支的 note 均带「运行证据=」").toBeGreaterThanOrEqual(2);
    for (const tpl of notes) {
      const extracted = LAST_RUN_SIGNAL_RE.exec(tpl)?.[1];
      expect(extracted, `无法从 note「${tpl}」提取 evidence`).toBe("SENTINEL");
    }
    // 反向锁：旧的「运行信号：」措辞不应再出现在源码中（避免回归）
    const file = path.join(REPO, "src", "agents", "traework", "run.ts");
    const src = fs.readFileSync(file, "utf8");
    expect(src.includes("运行信号："), "traework 的进度 note 不应再使用「运行信号：」（fix-loop 提取不到）")
      .toBe(false);
  });
});
