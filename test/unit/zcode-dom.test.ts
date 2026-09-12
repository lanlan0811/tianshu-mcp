import { describe, expect, it, vi } from "vitest";
import { parseHTML } from "linkedom";
import { runInNewContext } from "node:vm";
import { ZcodeCdpClient } from "../../src/agents/zcode/cdp.js";
import { normalizeZcodeModelSelection } from "../../src/agents/zcode/model.js";

function fixture(html: string, overrides: Record<string, string> = {}) {
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  for (const element of document.querySelectorAll("*")) {
    Object.assign(element, {
      getBoundingClientRect: () => {
        const hidden = element.closest('[hidden], [style*="display:none"]');
        return {
          x: 0,
          y: 0,
          left: 0,
          top: 0,
          width: hidden ? 0 : 100,
          height: hidden ? 0 : 20,
          right: 100,
          bottom: 20,
        };
      },
      scrollIntoView: () => {},
    });
  }
  const client = new ZcodeCdpClient(1, 100, overrides);
  vi.spyOn(client, "evaluate").mockImplementation(
    async <T>(expression: string): Promise<T> =>
      runInNewContext(expression, {
        document,
        innerWidth: 1000,
        innerHeight: 1000,
        getComputedStyle: () => ({ display: "block", visibility: "visible" }),
        setTimeout: (callback: () => void) => callback(),
      }) as T,
  );
  const send = vi.spyOn(client, "send").mockResolvedValue({});
  return { client, send };
}

const row = '<div data-testid="workspace-item-D:/项目/Demo">Demo</div>';
const primary =
  '<button data-testid="composer-workspace-trigger" aria-label="选择项目">Demo</button>';

describe("ZCode real CDP expressions against DOM", () => {
  it("uses current attributes over concatenated stale text and rejects malformed evidence", () => {
    expect(
      normalizeZcodeModelSelection({
        display: "old选择模型current",
        ariaLabel: "选择模型",
        currentValue: "custom%3Aprovider%3Acurrent",
      }),
    ).toEqual({ display: "current", internal: "current" });
    expect(() =>
      normalizeZcodeModelSelection({ display: "old选择模型current", ariaLabel: "选择模型" }),
    ).toThrow(/混合/);
    expect(() =>
      normalizeZcodeModelSelection({ display: "current", currentValue: "%broken" }),
    ).toThrow(/编码/);
  });
  it("reads and clicks the primary despite add/move/detach buttons", async () => {
    const { client, send } = fixture(`${primary}${row}
      <button aria-label="添加项目">添加</button><button aria-label="移动项目分区">移动</button>
      <button aria-label="取消选择当前项目">取消</button>`);
    expect(await client.workspaceBinding()).toMatchObject({
      projectPath: "D:/项目/Demo",
      ambiguous: false,
    });
    expect(await client.click("projectTrigger")).toBe(true);
    expect(send).toHaveBeenCalledTimes(3);
  });
  it("shares trigger resolution with project menu clicks", async () => {
    const { client } = fixture(`${primary}${row}<button aria-label="添加项目">添加</button>
      <div role="menu"><button role="menuitemcheckbox">Demo</button></div>`);
    expect(await client.clickProject(undefined, "D:/项目/Demo")).toBe(true);
  });
  it("uses an override before the primary and falls through an absent override", async () => {
    const { client } = fixture(
      `${primary}${row}<button id="override" data-project-path="D:/Other">Other</button>`,
      { projectTrigger: "#override" },
    );
    expect((await client.workspaceBinding()).projectPath).toBe("D:/Other");
    const other = fixture(`${primary}${row}`, { projectTrigger: "#missing" });
    expect((await other.client.workspaceBinding()).projectPath).toBe("D:/项目/Demo");
  });
  it("rejects ambiguity at the winning tier without falling through", async () => {
    const { client, send } = fixture(
      `${primary}${primary}${row}<button aria-label="Choose project">Demo</button>`,
    );
    expect(await client.workspaceBinding()).toMatchObject({ projectPath: "", ambiguous: true });
    expect(await client.click("projectTrigger")).toBe(false);
    expect(await client.clickProject(undefined, "D:/项目/Demo")).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
  it.each(["选择项目", "Select project", "Choose project"])(
    "uses exact fallback %s and ignores hidden primary",
    async (label) => {
      const { client } = fixture(
        `${primary.replace("<button ", "<button hidden ")}${row}<button aria-label="${label}">Demo</button>`,
      );
      expect((await client.workspaceBinding()).projectPath).toBe("D:/项目/Demo");
    },
  );
  it("rejects same-name paths and ignores unrelated sidebar path attributes", async () => {
    const { client } = fixture(
      `${primary}${row}<div data-testid="workspace-item-D:/Other/Demo">Demo</div><div data-project-path="D:/项目/Demo"></div>`,
    );
    expect(await client.workspaceBinding()).toMatchObject({ projectPath: "", ambiguous: true });
  });
  it("keeps explicit current path even when sidebar name matches another path", async () => {
    const { client } = fixture(
      `${primary.replace("<button ", '<button data-project-path="D:/Other/Demo" ')}${row}`,
    );
    expect((await client.workspaceBinding()).projectPath).toBe("D:/Other/Demo");
  });
  it("decodes current model and excludes hidden stale model/accessibility text", async () => {
    const { client } =
      fixture(`<button data-testid="chat-model-select-trigger" aria-label="选择模型" data-model-current-value="custom%3Aprovider%3Acurrent">
      <span hidden>old</span><span>选择模型</span><span title="current">current</span></button>`);
    expect(await client.selection("modelValue")).toEqual({
      display: "current",
      internal: "current",
    });
  });
  it("rejects conflicting visible model evidence", async () => {
    const { client } = fixture(
      '<button data-testid="chat-model-select-trigger" data-model-current-value="custom:provider:current"><span>other</span></button>',
    );
    await expect(client.selection("modelValue")).rejects.toThrow(/冲突/);
  });
  it("uses a visible label when the current attribute is missing", async () => {
    const { client } = fixture(
      '<button data-testid="chat-model-select-trigger" aria-label="Select model"><span hidden>old</span><span>Select model</span><span title="current">current</span></button>',
    );
    expect(await client.selection("modelValue")).toEqual({
      display: "current",
      internal: "current",
    });
  });
});
