import { describe, expect, it, vi } from "vitest";
import { parseHTML } from "linkedom";
import { runInNewContext } from "node:vm";
import { ZcodeCdpClient } from "../../src/agents/zcode/cdp.js";
import {
  normalizeZcodeModelSelection,
  uiModelNameMatches,
} from "../../src/agents/zcode/model.js";

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
  /**
   * 回归锁：`data-model-current-value` 的模型名段**自身可能含冒号**（2026-10-08 真机）。
   *
   * 属性格式是 `custom:<provider>:<urlencoded-model>`；旧实现用
   * `decodeURIComponent(v).split(":").at(-1)` 取模型名，假设模型名不含冒号。
   * 真机实测（ZCode 3.14.4.7912）OpenRouter 的免费模型后缀就是 `:free`：
   *
   *   data-model-current-value = custom:openrouter:inclusionai%2Fling-3.0-flash-sante%3Afree
   *   解码后                    = custom:openrouter:inclusionai/ling-3.0-flash-sante:free
   *   split(":").at(-1)        = "free"                        ← 被截断
   *   可见标签                   = OpenRouter/inclusionai/ling-3.0-flash-sante:free
   *   modelName(可见标签)        = inclusionai/ling-3.0-flash-sante:free
   *
   * 两者不等 → 抛「ZCode 当前模型属性与可见标签冲突」，**当前选中此类模型时适配器完全不可用**。
   */
  it("parses currentValue whose model name itself contains a colon (OpenRouter ':free' suffix)", () => {
    // 真机原值（ZCode 3.14.4.7912，OpenRouter/inclusionai/ling-3.0-flash-sante:free）
    const real = {
      display: "OpenRouter/inclusionai/ling-3.0-flash-sante:free",
      ariaLabel: "OpenRouter/inclusionai/ling-3.0-flash-sante:free",
      visibleLabel: "OpenRouter/inclusionai/ling-3.0-flash-sante:free",
      title: "",
      currentValue: "custom:openrouter:inclusionai%2Fling-3.0-flash-sante%3Afree",
      ambiguous: false,
    };
    expect(normalizeZcodeModelSelection(real)).toEqual({
      display: "OpenRouter/inclusionai/ling-3.0-flash-sante:free",
      internal: "inclusionai/ling-3.0-flash-sante:free",
    });
  });
  it("still parses provider-scoped values without a colon in the model name (cline)", () => {
    // 真机原值（ZCode 3.14.4.7912，cline-pass/deepseek-v4.1-flash）——不得被上一条修复破坏
    const real = {
      display: "cline/cline-pass/deepseek-v4.1-flash",
      ariaLabel: "cline/cline-pass/deepseek-v4.1-flash",
      visibleLabel: "cline/cline-pass/deepseek-v4.1-flash",
      title: "",
      currentValue: "custom:new-provider-2:cline-pass%2Fdeepseek-v4.1-flash",
      ambiguous: false,
    };
    expect(normalizeZcodeModelSelection(real)).toEqual({
      display: "cline/cline-pass/deepseek-v4.1-flash",
      internal: "cline-pass/deepseek-v4.1-flash",
    });
  });
  /**
   * 回归锁：显示名带 **UI 分组前缀**时，回读匹配必须剥一层前缀再比（2026-10-08 真机）。
   *
   * 真机 3.14.4.7912：选中后 display=`cline/cline-pass/deepseek-v4.1-flash`
   * （`.composer-provider-prefix` = `cline/`，是**分组显示名**），
   * internal=`cline-pass/deepseek-v4.1-flash`（纯模型名）。
   *
   * 分组显示名与 `供应商/模型` 参数段**没有对应关系**：该模型所属分组显示名是 `cline`
   * （testid `...registry-provider:new-provider-2`），而用户按面板传的参数段是 `cline-pass`。
   * 修复前回读只认完整候选串 → display 三候选全不中 → 判 `model_mismatch`，
   * 尽管模型已成功切换（供应商回退 + hover 分组 + 精确选中全部走通）。
   */
  it("matches a display label carrying a UI group prefix (single strip, both forms)", () => {
    const candidates = ["deepseek-v4.1-flash", "cline-pass/deepseek-v4.1-flash", "cline-pass"];
    // 带前缀的 display：剥一层后命中完整串
    expect(uiModelNameMatches("cline/cline-pass/deepseek-v4.1-flash", candidates)).toBe(true);
    // 不带前缀的形态仍直接命中（回归）
    expect(uiModelNameMatches("cline-pass/deepseek-v4.1-flash", candidates)).toBe(true);
    expect(uiModelNameMatches("deepseek-v4.1-flash", candidates)).toBe(true);
    // 大小写/空白仍按 exactUiName 归一
    expect(uiModelNameMatches("  CLINE/Cline-Pass/DeepSeek-V4.1-Flash  ", candidates)).toBe(true);
  });
  it("does not loosen matching: unrelated names and empty values stay rejected", () => {
    const candidates = ["deepseek-v4.1-flash", "cline-pass/deepseek-v4.1-flash", "cline-pass"];
    // 前缀里是**别的**模型 → 必须仍不匹配（剥前缀不是无条件放行）
    expect(uiModelNameMatches("cline/other-model", candidates)).toBe(false);
    expect(uiModelNameMatches("openrouter/inclusionai/ling-3.0-flash-sante:free", candidates)).toBe(
      false,
    );
    expect(uiModelNameMatches("", candidates)).toBe(false);
    expect(uiModelNameMatches("   ", candidates)).toBe(false);
    expect(uiModelNameMatches("cline/", candidates)).toBe(false);
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
    expect(await client.clickProject(undefined, "D:/项目/Demo")).toMatchObject({ clicked: true });
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
    expect(await client.clickProject(undefined, "D:/项目/Demo")).toMatchObject({
      clicked: false,
      reason: "trigger-unavailable",
    });
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

/**
 * issue #24：ZCode 3.14.x 删除了 `data-project-path` 与 `data-testid^="workspace-item-"`
 * 两处 DOM 契约（issue 作者的 app.asar 全文扫描与 CDP 实测均为 0 命中）。
 * 夹具刻意只保留 3.14.x 实际存在的结构（触发器 + 展开的 menuitemcheckbox 菜单），
 * 用来复现「有项目派单恒败于 project_mismatch」的根因，并锁定修复后的回读契约。
 */
describe("ZCode 3.14.x 契约缺席（issue #24）", () => {
  const v314 =
    '<button data-testid="composer-workspace-trigger">Demo</button>' +
    '<div role="menu">' +
    '<div role="menuitemcheckbox" aria-checked="true">Demo</div>' +
    '<div role="menuitemcheckbox" aria-checked="false">Other</div>' +
    '<div role="menuitemcheckbox" aria-checked="false">不在项目中工作</div>' +
    "</div>";

  it("路径契约缺席时仍能回读当前绑定的显示名", async () => {
    const { client } = fixture(v314);
    const binding = await client.workspaceBinding();
    // 环境事实：3.14.x 没有路径来源——不伪造路径，只补「显示名」这一可用证据。
    expect(binding.projectPath).toBe("");
    expect(binding.projectName).toBe("Demo");
    expect(binding.menuChecked).toEqual(["Demo"]);
    expect(binding.ambiguous).toBe(false);
  });

  it("projects() 改从展开菜单采集，并排除「不在项目中工作」", async () => {
    const { client } = fixture(v314);
    expect(await client.projects()).toEqual([
      { name: "Demo", checked: true },
      { name: "Other", checked: false },
    ]);
  });

  it("菜单中同时勾选多项 → 绑定回读判歧义（fail-closed）", async () => {
    const { client } = fixture(
      '<button data-testid="composer-workspace-trigger">Demo</button>' +
        '<div role="menu">' +
        '<div role="menuitemcheckbox" aria-checked="true">Demo</div>' +
        '<div role="menuitemcheckbox" aria-checked="true">Other</div>' +
        "</div>",
    );
    expect(await client.workspaceBinding()).toMatchObject({ ambiguous: true });
  });

  it("3.11.x 的 workspace-item-* / data-project-path 证据链保持优先（无退化）", async () => {
    const { client } = fixture(
      `${primary}<div data-testid="workspace-item-D:/项目/Demo">Demo</div>` +
        '<div role="menu"><div role="menuitemcheckbox" aria-checked="true">Demo</div></div>',
    );
    // 路径可得时必须仍以路径为准——这是老版本判等的兼容面。
    expect((await client.workspaceBinding()).projectPath).toBe("D:/项目/Demo");
  });
});

/**
 * issue #27：项目采集渠道分裂。
 *
 * 真机现场（ZCode 3.14.3）：`[data-testid^="workspace-item-"]` **并未从 DOM 消失**，
 * 只是尺寸塌陷且被滚出视口。`projects()` 采集 `projectItem` 时不做任何可见性过滤 →
 * 幽灵项入列使 `out.length > 0` → 唯一可信的菜单渠道（`projectMenuItem`）永不执行，
 * 于是 `matchZcodeProject` 命中幽灵项、自动导入分支被跳过，任务卡死在 project_mismatch。
 *
 * 修复判据：不可见的幽灵项必须被剔除；两条渠道始终合并；同名的菜单项覆盖侧边栏项。
 */
describe("ZCode 项目采集渠道分裂（issue #27）", () => {
  const v314Menu =
    '<div role="menu">' +
    '<div role="menuitemcheckbox" aria-checked="true" data-value="proj-demo">Demo</div>' +
    '<div role="menuitemcheckbox" aria-checked="false">Other</div>' +
    "</div>";

  it("视口外的侧边栏幽灵项不得遮蔽展开菜单里的项目", async () => {
    // data-top="1200" 让幽灵项落在视口之外（夹具 innerHeight=1000）：ZCODE_DOM.visible 判 false。
    const { client } = fixture(
      '<div data-testid="workspace-item-D:/项目/Demo" data-top="1200">Demo</div>' +
        '<button data-testid="composer-workspace-trigger">Demo</button>' +
        v314Menu,
    );
    expect(await client.projects()).toEqual([
      { name: "Demo", id: "proj-demo", checked: true },
      { name: "Other", checked: false },
    ]);
  });

  it("菜单未展开时视口外的幽灵项不算可信项目（返回空而不是幽灵项）", async () => {
    const { client } = fixture(
      '<div data-testid="workspace-item-D:/项目/Demo" data-top="1200">Demo</div>' +
        '<button data-testid="composer-workspace-trigger">Demo</button>',
    );
    expect(await client.projects()).toEqual([]);
  });

  it("同名时菜单项覆盖侧边栏项：绑定证据只认菜单的 aria-checked", async () => {
    const { client } = fixture(
      '<div data-testid="workspace-item-D:/项目/Demo">Demo</div>' +
        '<button data-testid="composer-workspace-trigger">Demo</button>' +
        '<div role="menu"><div role="menuitemcheckbox" aria-checked="true">Demo</div></div>',
    );
    const items = await client.projects();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ name: "Demo", checked: true });
    // 侧边栏项从 testid 派生的路径不得残留——它不是菜单给出的绑定证据。
    expect(items[0]!.path).toBeUndefined();
  });

  it("目标项只在视口外存在时 clickProject 报 not-visible 且不发鼠标事件", async () => {
    const { client, send } = fixture(
      '<button data-testid="composer-workspace-trigger">Demo</button>' +
        '<div data-testid="workspace-item-D:/项目/Demo" data-top="1200">Demo</div>',
    );
    expect(await client.clickProject("workspace-item-D:/项目/Demo", "D:/项目/Demo")).toEqual({
      clicked: false,
      reason: "not-visible",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("目标项目完全不在 DOM 里时 clickProject 报 not-found", async () => {
    const { client, send } = fixture('<button data-testid="composer-workspace-trigger">Demo</button>');
    expect(await client.clickProject("missing-id", "D:/项目/Absent")).toEqual({
      clicked: false,
      reason: "not-found",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("3.11.x 可见侧边栏项在无菜单时仍被采集（兼容面不退化）", async () => {
    const { client } = fixture('<div data-testid="workspace-item-D:/项目/Demo">Demo</div>');
    expect(await client.projects()).toEqual([
      { name: "Demo", path: "D:/项目/Demo", id: "workspace-item-D:/项目/Demo" },
    ]);
  });
});

/**
 * issue #27 问题三：思考档位的真实契约来自真机实测（2026-09-30，ZCode 3.14.3-Windows）——
 * 触发器 `chat-thought-level-select-trigger`（combobox）常驻，但选项
 * `chat-thought-level-select-item-{disabled,enabled}` **只在菜单展开时挂载**。
 * 因此读取必须按需展开一次、读完关闭；归一留给 TS 侧纯函数，DOM 层只采集原始事实。
 */
describe("ZCode 思考档位契约（issue #27）", () => {
  const tierTrigger =
    '<button data-testid="chat-thought-level-select-trigger" role="combobox">开启</button>';
  const tierOptions =
    '<div role="listbox">' +
    '<div role="option" data-testid="chat-thought-level-select-item-disabled" aria-checked="false">关闭</div>' +
    '<div role="option" data-testid="chat-thought-level-select-item-enabled" aria-checked="true">开启</div>' +
    "</div>";

  it("触发器未挂载时如实上报，不凭空造档位", async () => {
    const { client, send } = fixture("<div>empty</div>");
    expect(await client.thoughtLevelSnapshot()).toEqual({
      triggerMounted: false,
      opened: false,
      triggerText: "",
      options: [],
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("选项已挂载时直接采集 testid 后缀 / 文本 / 勾选态，不发鼠标事件", async () => {
    const { client, send } = fixture(tierTrigger + tierOptions);
    const snapshot = await client.thoughtLevelSnapshot();
    expect(snapshot).toMatchObject({ triggerMounted: true, opened: false, triggerText: "开启" });
    expect(snapshot.options).toEqual([
      {
        id: "chat-thought-level-select-item-disabled",
        token: "disabled",
        text: "关闭",
        checked: false,
      },
      {
        id: "chat-thought-level-select-item-enabled",
        token: "enabled",
        text: "开启",
        checked: true,
      },
    ]);
    expect(send).not.toHaveBeenCalled();
  });

  it("选项只在菜单展开时挂载：按需点开读一次，读完立刻关闭", async () => {
    const { client, send, document } = fixture(tierTrigger);
    send.mockImplementation(async (_method: string, params?: { type?: string }) => {
      if (params?.type === "mousePressed") {
        document.body.insertAdjacentHTML("beforeend", tierOptions);
        // 动态插入的节点不在夹具的初始 rect 注入范围内，需与既有元素同样处理。
        for (const element of document.querySelectorAll('[role="option"]')) {
          Object.assign(element, {
            getBoundingClientRect: () => ({
              x: 0,
              y: 0,
              left: 0,
              top: 0,
              width: 100,
              height: 20,
              right: 100,
              bottom: 20,
            }),
            scrollIntoView: () => {},
          });
        }
      }
      return {};
    });
    const snapshot = await client.thoughtLevelSnapshot();
    expect(snapshot.opened).toBe(true);
    expect(snapshot.options.map((option) => option.token)).toEqual(["disabled", "enabled"]);
    const escapes = send.mock.calls.filter((call) => {
      const params = call[1] as { key?: string } | undefined;
      return call[0] === "Input.dispatchKeyEvent" && params?.key === "Escape";
    });
    // 读完必须关闭：留一个展开的下拉会污染后续的模型/权限步骤。
    expect(escapes.length).toBeGreaterThanOrEqual(2);
  });

  it("点击档位选项按 testid 精确定位", async () => {
    const { client, send } = fixture(tierTrigger + tierOptions);
    expect(await client.clickThoughtLevelOption("chat-thought-level-select-item-disabled")).toBe(
      true,
    );
    const presses = send.mock.calls.filter(
      (call) => (call[1] as { type?: string } | undefined)?.type === "mousePressed",
    );
    expect(presses).toHaveLength(1);
  });

  it("目标档位选项不在 DOM 时不发鼠标事件", async () => {
    const { client, send } = fixture(tierTrigger);
    expect(await client.clickThoughtLevelOption("chat-thought-level-select-item-enabled")).toBe(
      false,
    );
    expect(send).not.toHaveBeenCalled();
  });
});

/**
 * issue #27 问题三的菜单点击加固：radix 子菜单由 hover 维持，press 时子菜单可能已收回。
 * 命中判据必须落在「点击那一刻该点真的能命中原节点」上，否则坐标点击会打到别的元素，
 * UI 状态毫无变化——那种失败会被误读成「模型不存在」。
 */
describe("ZCode 菜单项点击前的命中校验（issue #27）", () => {
  it("scrollIntoView 之后目标不再可命中时不发鼠标事件", async () => {
    const { client, send, document } = fixture(
      '<button data-testid="chat-model-select-trigger"></button>' +
        '<div role="menuitemradio" data-testid="chat-model-select-item-x" data-model="mdl">mdl</div>',
    );
    const target = document.querySelector('[data-model="mdl"]') as unknown as {
      scrollIntoView: (options?: unknown) => void;
    };
    document.elementFromPoint = () => target as never;
    // 子菜单在展开滚动之后立即收回：此后命中检查必须失败。
    target.scrollIntoView = () => {
      document.elementFromPoint = () => null;
    };
    const result = await client.clickExact("modelOption", "mdl");
    expect(result.clicked).toBe(false);
    expect(result.count).toBe(1);
    expect(send).not.toHaveBeenCalled();
  });
});

/**
 * issue #27 问题三：「两级模型菜单点击不稳」的真机根因（3.14.3 实测）是
 * ① provider 分组 testid 漂移成 `chat-model-select-group-registry-provider:`；
 * ② 模型项在分组的**二级子菜单**里，只有 hover 分组才渲染——click 会选中分组本身或收起菜单。
 */
describe("ZCode 两级模型菜单（issue #27）", () => {
  const providerGroup =
    '<div role="menuitem" data-testid="chat-model-select-group-registry-provider:new-provider">step-plan</div>';

  it("provider 分组漂移为 registry-provider 时仍能命中", async () => {
    const { client, send, document } = fixture(providerGroup);
    const group = document.querySelector('[data-testid^="chat-model-select-group-registry-provider"]');
    document.elementFromPoint = () => group as never;
    const result = await client.clickExact("providerOption", "step-plan", "hover");
    expect(result.clicked).toBe(true);
    expect(result.count).toBe(1);
    // hover 模式只移动指针，不按键——按下会选中分组/收起菜单，子菜单永远等不到渲染。
    const types = send.mock.calls.map((call) => (call[1] as { type?: string } | undefined)?.type);
    expect(types).toEqual(["mouseMoved"]);
  });

  it("click 模式仍会按键（回归：默认行为不变）", async () => {
    const { client, send, document } = fixture(providerGroup);
    const group = document.querySelector('[data-testid^="chat-model-select-group-registry-provider"]');
    document.elementFromPoint = () => group as never;
    await client.clickExact("providerOption", "step-plan");
    const types = send.mock.calls.map((call) => (call[1] as { type?: string } | undefined)?.type);
    expect(types).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
  });
});

/**
 * 权限菜单的真机契约（2026-09-30，ZCode 3.14.3-Windows）与 3.11.x 不同：
 * 项 role 是 `menuitemradio`/`menuitemcheckbox`（**不是** `option`），且可见名写在项内的
 * **直接文本节点**里，后面还跟一句说明（如「完全访问减少确认次数。」）。
 * 两条都会让旧实现 0 命中，进而让整轮派发卡在 `permission_unknown`。
 */
describe("ZCode 权限菜单契约（真机 3.14.3）", () => {
  const yolo =
    '<div role="menuitemradio" aria-checked="false" data-testid="chat-mode-select-item-yolo">完全访问<span>减少确认次数。</span></div>';

  it("role 不是 option 时仍能命中（fallback 去掉 role 限制）", async () => {
    const { client, document } = fixture(yolo);
    document.elementFromPoint = () =>
      document.querySelector('[data-testid^="chat-mode-select-item-"]') as never;
    const result = await client.clickExact("permissionOption", "完全访问");
    expect(result.clicked).toBe(true);
    expect(result.count).toBe(1);
  });

  it("可见名取自直接文本节点，不被后面的说明文本污染", async () => {
    const { client, document } = fixture(yolo);
    document.elementFromPoint = () =>
      document.querySelector('[data-testid^="chat-mode-select-item-"]') as never;
    // 若 label 退化成整段 textContent（「完全访问减少确认次数。」），这里就会匹配失败。
    const result = await client.clickExact("permissionOption", "完全访问");
    expect(result.clicked).toBe(true);
    expect(result.available).toContain("完全访问");
  });
});

