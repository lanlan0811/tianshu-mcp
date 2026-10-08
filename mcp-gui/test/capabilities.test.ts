import { describe, expect, it } from "vitest";
import { CAPABILITY_FAMILIES, MCP_TOOLS, toolsInFamily, type ToolCapability } from "@/core/capabilities";
import { zhCN } from "@/i18n/zh-CN";
import { enUS } from "@/i18n/en-US";
import { lookup } from "@/i18n";

/**
 * 「MCP 能力」视图的内嵌清单自检。
 * 跨仓一致性（与 `src/mcp/tools.ts` 的 TOOL_DEFS）由 `scripts/check-schema-parity.mjs` 守住；
 * 这里守住 GUI 内部契约：数量 / 待等原语在列 / 三族归属 / 审批语义 / 两种语言的说明非空。
 */
describe("MCP 能力清单（GUI 镜像）", () => {
  it("共 8 个工具（v0.9.0 合并后），名称唯一", () => {
    expect(MCP_TOOLS).toHaveLength(8);
    expect(new Set(MCP_TOOLS.map((t) => t.name)).size).toBe(8);
  });

  it("包含等待原语 wait_task（v0.9.0 已并入 wait_any）：read 族、免审批", () => {
    const entry = MCP_TOOLS.find((t) => t.name === "wait_task");
    expect(entry, "wait_task 应在清单中").toBeDefined();
    expect(entry!.capability, "wait_task capability").toBe("read");
    expect(entry!.requireApproval, "wait_task requireApproval").toBe(false);
  });

  it("v0.9.0 合并后的新工具在清单中", () => {
    for (const [name, cap] of [
      ["manage_task", "write"],
      ["query_info", "read"],
    ] as const) {
      const entry = MCP_TOOLS.find((t) => t.name === name);
      expect(entry, `${name} 应在清单中`).toBeDefined();
      expect(entry!.capability, `${name} capability`).toBe(cap);
    }
  });

  it("三族划分覆盖全部工具，且 capability 取值合法", () => {
    const valid: ToolCapability[] = ["read", "write", "execute"];
    const total = CAPABILITY_FAMILIES.reduce((n, fam) => n + toolsInFamily(fam).length, 0);
    expect(total).toBe(MCP_TOOLS.length);
    for (const tool of MCP_TOOLS) {
      expect(valid, tool.name).toContain(tool.capability);
    }
  });

  it("审批语义与能力族一致（read/execute 免审批、write 需审批）", () => {
    for (const tool of MCP_TOOLS) {
      if (tool.capability === "write") {
        expect(tool.requireApproval, `${tool.name}（write）应需审批`).toBe(true);
      } else {
        expect(tool.requireApproval, `${tool.name}（${tool.capability}）应免审批`).toBe(false);
      }
    }
  });

  it("每个工具在两种语言都有非空说明（缺失即失败，不静默返回键名）", () => {
    for (const tool of MCP_TOOLS) {
      const key = `capabilities.tools.${tool.name}`;
      for (const [lang, bundle] of [
        ["zh-CN", zhCN],
        ["en-US", enUS],
      ] as const) {
        const text = lookup(bundle, key);
        expect(text, `${lang} ${key} 缺失`).not.toBe(key);
        expect(text.trim(), `${lang} ${key} 为空`).not.toBe("");
      }
    }
  });
});
