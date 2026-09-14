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
          top: Number(element.getAttribute("data-top") || 0),
          width: hidden ? 0 : 100,
          height: hidden ? 0 : 20,
          right: 100,
          bottom: Number(element.getAttribute("data-top") || 0) + 20,
        };
      },
      scrollIntoView: () => {},
    });
  }
  const client = new ZcodeCdpClient(1, 100, overrides);
  document.elementFromPoint = () =>
    document.querySelector('[data-cover], [data-testid="v4-composer-send"]')!;
  vi.spyOn(client, "evaluate").mockImplementation(
    async <T>(expression: string): Promise<T> =>
      runInNewContext(expression, {
        document,
        innerWidth: 1000,
        innerHeight: 1000,
        getComputedStyle: (e: {
          style: { display?: string; visibility?: string; opacity?: string; overflow?: string };
        }) => ({
          display: e.style.display || "block",
          visibility: e.style.visibility || "visible",
          opacity: e.style.opacity || "1",
          overflow: e.style.overflow || "visible",
        }),
        setTimeout: (callback: () => void) => callback(),
      }) as T,
  );
  const send = vi.spyOn(client, "send").mockResolvedValue({});
  return { client, send, document };
}

const row = '<div data-testid="workspace-item-D:/项目/Demo">Demo</div>';
const primary =
  '<button data-testid="composer-workspace-trigger" aria-label="选择项目">Demo</button>';

describe("ZCode real CDP expressions against DOM", () => {
  it("waits for the send button to become enabled and submits exactly once", async () => {
    const { client, send, document } = fixture(
      '<button data-testid="v4-composer-send" disabled>Send</button>',
    );
    const evaluate = vi.mocked(client.evaluate).getMockImplementation()!;
    let probes = 0;
    vi.spyOn(client, "evaluate").mockImplementation(async <T>(expression: string): Promise<T> => {
      if (expression.includes("elementFromPoint") && ++probes === 3)
        document.querySelector("button")!.removeAttribute("disabled");
      return evaluate(expression) as Promise<T>;
    });
    await client.sendMessage();
    expect(probes).toBe(3);
    expect(send.mock.calls.map((call) => call[1]?.type)).toEqual([
      "mouseMoved",
      "mousePressed",
      "mouseReleased",
    ]);
  });
  it.each(["disabled", 'aria-disabled="true"', "data-cover"])(
    "does not submit a disabled or covered send button (%s)",
    async (attribute) => {
      const html =
        attribute === "data-cover"
          ? '<div data-cover></div><button data-testid="v4-composer-send">Send</button>'
          : `<button data-testid="v4-composer-send" ${attribute}>Send</button>`;
      const { client, send } = fixture(html);
      await expect(client.sendMessage()).rejects.toThrow(/未发送/);
      expect(send).not.toHaveBeenCalled();
    },
  );
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
    const { client, send, document } = fixture(`${primary}${row}
      <button aria-label="添加项目">添加</button><button aria-label="移动项目分区">移动</button>
      <button aria-label="取消选择当前项目">取消</button>`);
    pointAt(document, triggerSelector);
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
  it("excludes transparent ancestors and clipped animation text", async () => {
    const { client } = fixture(
      '<button data-testid="chat-model-select-trigger" data-model-current-value="custom:provider:current"><span style="opacity:0"><span>old-transparent</span></span><span style="overflow:hidden"><span data-top="30">old-clipped</span><span>current</span></span></button>',
    );
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
  it("reads provider/model labels split across sibling spans", async () => {
    const { client } = fixture(
      '<button data-testid="chat-model-select-trigger" data-model-current-value="custom:provider:current"><span title="Vendor/current"><span>Vendor/</span><span>current</span></span></button>',
    );
    expect(await client.selection("modelValue")).toEqual({
      display: "Vendor/current",
      internal: "current",
    });
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

const triggerSelector = '[data-testid="composer-workspace-trigger"]';

/** 把 elementFromPoint 指向指定节点（夹具默认返回 null，会让探测判为「被遮挡」）。 */
function pointAt(document: ReturnType<typeof fixture>["document"], selector: string): void {
  document.elementFromPoint = () => document.querySelector(selector) as never;
}

describe("ZCode project trigger probe", () => {
  it("reports missing when no trigger is mounted", async () => {
    const { client } = fixture("<div>empty</div>");
    expect(await client.probeProjectTrigger()).toMatchObject({
      state: "missing",
      mounted: 0,
      count: 0,
      ready: false,
    });
  });

  it("distinguishes mounted-but-hidden from never mounted", async () => {
    const { client } = fixture(primary.replace("<button ", "<button hidden "));
    expect(await client.probeProjectTrigger()).toMatchObject({
      state: "hidden",
      mounted: 1,
      count: 0,
      ready: false,
    });
  });

  it("reports ambiguity with the match count and never a click point", async () => {
    const { client } = fixture(`${primary}${primary}`);
    const probe = await client.probeProjectTrigger();
    expect(probe).toMatchObject({ state: "ambiguous", count: 2, ready: false });
    expect(probe.point).toBeUndefined();
  });

  it("reports an aria-disabled trigger as not ready", async () => {
    const { client } = fixture(
      '<button data-testid="composer-workspace-trigger" aria-disabled="true">Demo</button>',
    );
    expect(await client.probeProjectTrigger()).toMatchObject({ state: "disabled", ready: false });
  });

  it("reports a covered trigger as not ready and names the covering node", async () => {
    const { client, document } = fixture(`${primary}<div data-testid="overlay">遮罩</div>`);
    pointAt(document, '[data-testid="overlay"]');
    const probe = await client.probeProjectTrigger();
    expect(probe).toMatchObject({ state: "covered", count: 1, ready: false });
    expect(probe.detail).toContain("overlay");
  });

  it("accepts a descendant under the centre point as a hit on the trigger", async () => {
    const { client, document } = fixture(
      '<button data-testid="composer-workspace-trigger"><span id="trigger-label">Demo</span></button>',
    );
    pointAt(document, "#trigger-label");
    const probe = await client.probeProjectTrigger();
    expect(probe).toMatchObject({ state: "ready", ready: true, count: 1 });
    expect(probe.point).toEqual({ x: 50, y: 10 });
  });

  it("reports ready with the click point for a single visible trigger", async () => {
    const { client, document } = fixture(primary);
    pointAt(document, triggerSelector);
    expect(await client.probeProjectTrigger()).toMatchObject({
      state: "ready",
      ready: true,
      count: 1,
      selector: triggerSelector,
      point: { x: 50, y: 10 },
    });
  });

  it("refuses to click a trigger the probe is not ready for", async () => {
    const { client, send } = fixture(`${primary}${primary}`);
    expect(await client.click("projectTrigger")).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("confirms the project menu opened after a real click", async () => {
    const { client, document } = fixture(
      `${primary}<div role="menu"><button role="menuitemcheckbox">Demo</button></div>`,
    );
    pointAt(document, triggerSelector);
    expect(await client.projectMenuOpen()).toBe(true);
    const outcome = await client.clickProjectTriggerAndConfirm(Date.now() + 1_000);
    expect(outcome.opened).toBe(true);
  });

  it("reports a click that leaves the menu closed as not opened", async () => {
    const { client, document } = fixture(primary);
    pointAt(document, triggerSelector);
    const outcome = await client.clickProjectTriggerAndConfirm(Date.now() + 200);
    expect(outcome.opened).toBe(false);
    expect(outcome.reason).toBe("menu-not-open");
  });

  it("treats an already-open menu as opened without clicking the trigger", async () => {
    // Radix 下拉是 toggle：菜单已开时再点触发器会把它关掉，随后整段等待都会失败。
    const { client, send, document } = fixture(
      `${primary}<div role="menu"><button role="menuitemcheckbox">Demo</button></div>`,
    );
    pointAt(document, triggerSelector);
    const outcome = await client.clickProjectTriggerAndConfirm(Date.now() + 300);
    expect(outcome.opened).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it("re-clicks the trigger while the menu stays closed (bounded retries)", async () => {
    // 真机实测：ZCode 窗口被遮挡时页面被节流，首次点击常被吞掉，第二次点击才打开菜单。
    // 所以「点一次然后干等」是错的——应在等待窗口内有界地重新点击。
    const { client, send, document } = fixture(primary);
    pointAt(document, triggerSelector);
    const outcome = await client.clickProjectTriggerAndConfirm(Date.now() + 3_200);
    expect(outcome.opened).toBe(false);
    expect(outcome.reason).toBe("menu-not-open");
    const presses = send.mock.calls.filter((c) => c[1]?.type === "mousePressed").length;
    expect(presses).toBeGreaterThan(1);
  });
});

describe("ZCode 发送失败诊断", () => {
  it("页面被节流（visibilityState=hidden）时归因为窗口不在前台，而不是按钮问题", async () => {
    // 真机证据（3.11.2-Windows）：窗口被遮挡时 document.visibilityState=hidden、
    // elementFromPoint 命中非按钮节点，sendMessage 连续拿不到可点按钮；
    // 只报「按钮未启用或被遮挡」会把用户引向按钮，而真因是窗口不在前台。
    const { client } = fixture('<button data-testid="v4-composer-send" disabled>Send</button>');
    const evaluate = vi.mocked(client.evaluate).getMockImplementation()!;
    vi.spyOn(client, "evaluate").mockImplementation(async <T>(expression: string): Promise<T> => {
      if (expression.includes("visibilityState")) return true as T;
      return evaluate(expression) as Promise<T>;
    });
    await expect(client.sendMessage()).rejects.toThrow(/置于前台/);
  });

  it("页面可见时保留原有的按钮归因文案", async () => {
    const { client } = fixture('<button data-testid="v4-composer-send" disabled>Send</button>');
    await expect(client.sendMessage()).rejects.toThrow(/未在观察期内启用或被遮挡/);
  });
});
