/**
 * R4 回归测试：MCP 工具参数语义。
 * - get_task_report(round=0) 合法
 * - 手动 verify_task(taskId) 分配下一可用轮次，不覆盖 report-0
 * - extraChecks 追加（不替换基础门禁）；checksMode=replace 才替换
 * - optional:true 失败不影响 verdict；必选失败影响
 * - baselineRef：git ref 有效/无效
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import fsp from "node:fs/promises";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import {
  startTestServer,
  makeGitProject,
  writePlaybook,
  callTool,
  parseMeta,
  waitForTerminal,
  rmrf,
  type TestServer,
} from "../test-utils.js";

let ts: TestServer;
const tempDirs: string[] = [];

beforeAll(async () => {
  ts = await startTestServer();
}, 60_000);
afterAll(async () => {
  await ts?.close();
  for (const d of tempDirs) await rmrf(d).catch(() => {});
  if (ts) await rmrf(ts.home).catch(() => {});
});

describe("R4 get_task_report round 语义", () => {
  it("round=0 显式读取合法；缺省返回最新", async () => {
    const proj = await makeGitProject("good");
    tempDirs.push(proj);
    await writePlaybook(proj, { playbook: "good" });
    const { text } = await callTool(ts.client, "run_task", {
      projectPath: proj,
      agentId: "stub",
      task: "good 一次通过",
      autoVerify: true,
      autoFixRounds: 1,
    });
    const taskId = (parseMeta(text).meta!.taskId as string) ?? "";
    const final = await waitForTerminal(ts.client, taskId, 30_000);
    expect(final.status).toBe("succeeded");
    // round=0 显式读
    const r0 = await callTool(ts.client, "query_info", { type: "report", taskId, round: 0 });
    expect(r0.text).toContain("第 0 轮");
    // 缺省读最新
    const latest = await callTool(ts.client, "query_info", { type: "report", taskId });
    expect(latest.text).toContain("验收");
  }, 60_000);
});

describe("R4/S4 手动 verify_task 轮次与元数据", () => {
  it("verify_task(taskId) 写 report-1，返回 reportRound=1，query 指向 report-1，agentId 保留", async () => {
    const proj = await makeGitProject("good");
    tempDirs.push(proj);
    await writePlaybook(proj, { playbook: "good" });
    // 先跑一次任务产生 report-0（autoVerify succeeded）
    const { text } = await callTool(ts.client, "run_task", {
      projectPath: proj,
      agentId: "stub",
      task: "产生 report-0",
      autoVerify: true,
    });
    const taskId = (parseMeta(text).meta!.taskId as string) ?? "";
    await waitForTerminal(ts.client, taskId, 30_000);
    const dir = path.join(ts.home, "tasks", taskId);
    expect(fs.existsSync(path.join(dir, "report-0.md"))).toBe(true);

    // 手动 verify_task(taskId) —— S4：返回 meta.reportRound=1 且不覆盖 report-0
    const v = await callTool(ts.client, "verify_task", { taskId });
    const vMeta = parseMeta(v.text).meta;
    expect(vMeta?.reportRound).toBe(1);
    expect(vMeta?.verificationSource).toBe("manual");
    expect(vMeta?.agentId).toBe("stub"); // 保留原 agentId，不得改成 manual-verify
    expect(fs.existsSync(path.join(dir, "report-0.md"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "report-1.md"))).toBe(true);

    // S4：后续 query_task 指向 report-1，lastMessage/diffstat 与手动验收一致
    const q = await callTool(ts.client, "query_task", { taskId });
    const qMeta = parseMeta(q.text).meta;
    expect(qMeta?.reportRound).toBe(1);
    expect((qMeta?.reportFiles as { md?: string } | undefined)?.md).toContain("report-1.md");
    expect(qMeta?.message).toContain("[PASS] 手动验收");

    // get_task_report() 缺省返回 report-1；round=0 返回 report-0
    const r0 = await callTool(ts.client, "query_info", { type: "report", taskId, round: 0 });
    expect(r0.text).toContain("第 0 轮");
    const rLatest = await callTool(ts.client, "query_info", { type: "report", taskId });
    expect(rLatest.text).toContain("第 1 轮");
  }, 60_000);
});

describe("R4 extraChecks / optional 语义", () => {
  it("extraChecks 追加：基础门禁仍执行", async () => {
    const proj = await makeGitProject("good");
    tempDirs.push(proj);
    await writePlaybook(proj, { playbook: "good" });
    await fsp.writeFile(path.join(proj, "done.txt"), "PASS\n", "utf8");
    const { text } = await callTool(ts.client, "verify_task", {
      projectPath: proj,
      extraChecks: [{ name: "extra-node", cmd: ["node", "--version"] }],
    });
    const { meta } = parseMeta(text);
    // 读取 report 文件确认各检查都执行了（追加）
    const reportPath = (meta?.reportFiles as { json: string } | undefined)?.json;
    expect(reportPath).toBeTruthy();
    const report = JSON.parse(await fsp.readFile(reportPath!, "utf8"));
    const names = report.checks.map((c: { name: string }) => c.name);
    expect(names).toContain("extra-node");
    expect(names).toContain("done-marker"); // 项目验收配置仍执行（追加）
    expect(names).toContain("git-diff-check"); // 内置检查
  }, 60_000);

  it("optional 检查失败不影响 verdict（passed=true）", async () => {
    const proj = await makeGitProject("good");
    tempDirs.push(proj);
    const acceptancePath = path.join(proj, ".tianshu-mcp", "acceptance.json");
    const acceptance = JSON.parse(await fsp.readFile(acceptancePath, "utf8"));
    acceptance.requireChanges = false;
    await fsp.writeFile(acceptancePath, JSON.stringify(acceptance, null, 2), "utf8");
    await fsp.writeFile(path.join(proj, "done.txt"), "PASS\n", "utf8");
    const { text } = await callTool(ts.client, "verify_task", {
      projectPath: proj,
      extraChecks: [
        { name: "opt-fail", cmd: ["node", "-e", "process.exit(1)"], optional: true },
        { name: "opt-pass", cmd: ["node", "-e", "process.exit(0)"], optional: true },
      ],
    });
    const { meta } = parseMeta(text);
    expect(meta?.ok).toBe(true);
    expect(meta?.status).toBe("succeeded");
    const reportPath = (meta?.reportFiles as { json: string } | undefined)?.json;
    const report = JSON.parse(await fsp.readFile(reportPath!, "utf8"));
    const optFail = report.checks.find((c: { name: string }) => c.name === "opt-fail");
    expect(optFail.passed).toBe(false);
    expect(optFail.optional).toBe(true);
    expect(report.message).toContain("optional 检查未通过");
  }, 60_000);
});

describe("R4 baselineRef", () => {
  it("无效 git ref 返回结构化错误；有效 ref 可用于独立项目验收", async () => {
    const proj = await makeGitProject("good");
    tempDirs.push(proj);
    // 无效 ref
    const bad = await callTool(ts.client, "verify_task", {
      projectPath: proj,
      baselineRef: "no-such-ref-xyz",
    });
    expect(bad.res.isError).toBe(true);
    expect(bad.text).toContain("baselineRef");
    // 有效 ref：当前 HEAD
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: proj, encoding: "utf8" }).trim();
    const ok = await callTool(ts.client, "verify_task", { projectPath: proj, baselineRef: head });
    expect(ok.res.isError).toBe(false);
  }, 60_000);
});

describe("acceptanceOverride 校验独立于线上 schema（v0.8.4 陷阱防护）", () => {
  // 背景：run_task / verify_task 的线上 inputSchema 曾完整内联 PartialAcceptanceConfigSchema
  // （含 9579 字符的 VisualConfigSchema），使 tools/list 达 35581 字符。v0.8.4 起换成骨架形态
  // （AcceptanceOverrideWireSchema）→ 实测降到 11717 字符。
  //
  // 关键风险：骨架形态里 `visual` 是 `z.record(z.unknown())`（不透明），因此
  // **`visual` 内部的字段级非法只能由 handler 下沉校验拦住**——wire/SDK 层放行它们。
  // 下面这组用例专门打这个缝隙，并断言错误**来源是下沉层**（而非 SDK 的 -32602），
  // 以保证「移除下沉校验」真的会让测试变红。
  //
  // 反证记录：实施时曾用 `checks: [{name:"t"}]` 做断言，结果移除下沉校验后测试仍绿——
  // 因为 wire 形态保留了 checks 的完整 AcceptanceCheckSchema，是 SDK 层拦的。故改用 visual 缝隙。
  const SINK_ONLY_CASES: [string, Record<string, unknown>][] = [
    ["visual.browser 类型错", { visual: { browser: "bogus" } }],
    ["visual.enabled 是字符串", { visual: { enabled: "yes" } }],
    ["visual.pages 不是数组", { visual: { pages: "nope" } }],
  ];

  for (const [label, bad] of SINK_ONLY_CASES) {
    it(`verify_task 由 handler 下沉层拒绝：${label}`, async () => {
      const proj = await makeGitProject("good");
      tempDirs.push(proj);
      const r = await callTool(ts.client, "verify_task", {
        projectPath: proj,
        acceptanceOverride: bad,
      });
      expect(r.res.isError, `坏输入「${label}」必须被拒`).toBe(true);
      // 断言来源：必须由 handler 下沉层拒绝。若退化为 SDK 的 -32602 说明骨架又被收紧，
      // 若完全没有错误信息则说明下沉校验被移除（fail-open 回归）。
      expect(r.text, `「${label}」应由 handler 下沉层拒绝（acceptanceOverride 参数不合法）`)
        .toContain("acceptanceOverride 参数不合法");
      expect(r.text, `「${label}」不应由 SDK 层拒绝——那说明骨架形态意外收紧了`).not.toContain(
        "-32602",
      );
    }, 60_000);
  }

  // 补充：wire 层仍守着 `checks`（骨架保留了完整 AcceptanceCheckSchema），
  // 这层拒绝由 SDK 发出——两条防线各自有效，都写进断言。
  it("checks 的字段级非法由 SDK/wire 层拒绝（骨架仍保留 checks 完整校验）", async () => {
    const proj = await makeGitProject("good");
    tempDirs.push(proj);
    const r = await callTool(ts.client, "verify_task", {
      projectPath: proj,
      acceptanceOverride: { checks: [{ name: "t" }] },
    });
    expect(r.res.isError).toBe(true);
  }, 60_000);

  it("合法的 acceptanceOverride 仍被接受（未被过度收紧）", async () => {
    const proj = await makeGitProject("good");
    tempDirs.push(proj);
    await writePlaybook(proj, { playbook: "good" });
    await fsp.writeFile(path.join(proj, "done.txt"), "PASS\n", "utf8");
    const r = await callTool(ts.client, "verify_task", {
      projectPath: proj,
      acceptanceOverride: { requireChanges: false },
    });
    expect(r.res.isError, "合法输入不应被拒").toBeFalsy();
  }, 60_000);

  it("run_task 同样由 handler 下沉层拒绝 visual 内部非法（同一不变量）", async () => {
    const proj = await makeGitProject("good");
    tempDirs.push(proj);
    const r = await callTool(ts.client, "run_task", {
      projectPath: proj,
      task: "t",
      agentId: "stub",
      acceptanceOverride: { visual: { enabled: "yes" } },
    });
    expect(r.res.isError, "run_task 的坏 acceptanceOverride 必须被拒").toBe(true);
    expect(r.text, "run_task 也应由下沉层拒绝").toContain("acceptanceOverride 参数不合法");
  }, 60_000);
});

describe("线上 inputSchema 契约（防 discriminatedUnion/refine 空 schema 陷阱）", () => {
  // 实测：z.discriminatedUnion / .refine() 经 SDK 序列化后线上变成
  // {"type":"object","properties":{}}——参数信息全部丢失，宿主 LLM 看不到任何字段。
  //
  // 注意：`get_profiles` 用 `z.object({})`，它**本来就没有参数**，空 properties 是正确形态。
  // 故本断言排除「设计上无参」的工具，其余工具必须暴露非空 properties。
  const NO_PARAM_TOOLS = new Set(["get_profiles"]);

  it("除无参工具外，每个工具的线上 inputSchema 都必须暴露非空 properties", async () => {
    const { tools } = await ts.client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) {
      const props = (t.inputSchema as { properties?: Record<string, unknown> } | undefined)
        ?.properties;
      const count = props ? Object.keys(props).length : 0;
      if (NO_PARAM_TOOLS.has(t.name)) {
        expect(count, `${t.name} 被列为无参工具，但它的 schema 现在有参数了——请更新 NO_PARAM_TOOLS`)
          .toBe(0);
        continue;
      }
      expect(count, `${t.name} 的线上 schema 参数为空（检出 discriminatedUnion/refine 陷阱）`)
        .toBeGreaterThan(0);
    }
  }, 60_000);
});
