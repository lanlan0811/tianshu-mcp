import { describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { runInNewContext } from "node:vm";
import {
  bindWorkspace,
  normalizeWorkspacePath,
  readWorkspaceValue,
  workspaceMatches,
  type OpenDesignPage,
} from "../../src/agents/opendesign/workspace.js";
import { GuiProfileSchema, ZCODE_SETUP_DEFAULTS } from "../../src/config/schema.js";
import type { FolderDialogOutcome } from "../../src/agents/opendesign/dialog.js";

/** 采集后写回 selectors.ts 的样子（测试用稳定钩子，不代表最终 CSS） */
const CAPTURED: Record<string, string> = {
  title: '[data-od="title"]',
  composer: '[data-od="composer"]',
  inputBox: '[data-od="input"]',
  workingDirTrigger: '[data-od="working-dir"]',
  workingDirValue: '[data-od="working-dir-value"]',
  selectDirItem: '[data-od="select-dir"]',
  modelTrigger: '[data-od="model"]',
  designSystemTrigger: '[data-od="design-system"]',
  designDirectionTrigger: '[data-od="direction"]',
  sendButton: '[data-od="send"]',
  conversationText: '[data-od="conversation"]',
};

const TARGET = "D:\\Trae项目\\tianshu-mcp";
const OTHER = "D:\\Other";

interface PageBehaviour {
  /** 点击「工作目录」后是否挂出「选择目录」菜单项（默认 true） */
  panelOpens?: boolean;
  /** 回调收到 node，返回 true = 模拟应用接受该目录（界面显示值更新） */
  onNativeDialog?: (node: { setWorkspaceValue: (v: string) => void }) => void;
}

function makePage(workspaceValue: string, behaviour: PageBehaviour = {}) {
  const panelOpens = behaviour.panelOpens ?? true;
  const { document } = parseHTML(`<html><body>
    <header><h1 data-od="title">让我们创建原型</h1></header>
    <main>
      <form data-od="composer">
        <textarea data-od="input"></textarea>
        <button data-od="working-dir" aria-haspopup="menu" aria-expanded="false">工作目录</button>
        <span data-od="working-dir-value">${workspaceValue}</span>
        <button data-od="model" aria-haspopup="menu">v4.1-flash</button>
        <button data-od="design-system" aria-haspopup="dialog">Claude (Anthropic)</button>
        <button data-od="direction" aria-haspopup="menu">原型</button>
        <button data-od="send" type="submit">发送</button>
      </form>
      <div data-od="conversation" role="log"></div>
    </main>
  </body></html>`);

  /**
   * 给**当前**所有元素打上可见性补丁。
   * 必须在每次动态插入节点后重新调用：只做一次初始化的话，后插入的节点没有
   * `getBoundingClientRect`，`odVisible` 直接抛错 → 表现为「菜单项明明在却判 no-item」。
   */
  const patchVisibility = (): void => {
    for (const element of document.querySelectorAll("*")) {
      Object.assign(element, {
        getBoundingClientRect: () => {
          const hidden = element.closest("[hidden], [style*='display:none']");
          const top = Number(element.getAttribute("data-top") || 0);
          return {
            x: 0,
            y: top,
            left: 0,
            top,
            width: hidden ? 0 : 100,
            height: hidden ? 0 : 20,
            right: 100,
            bottom: top + 20,
          };
        },
      });
    }
  };
  patchVisibility();

  const clicks: string[] = [];
  const setWorkspaceValue = (v: string): void => {
    const el = document.querySelector('[data-od="working-dir-value"]');
    if (el) el.textContent = v;
  };

  const page: OpenDesignPage = {
    async evaluate<T>(expression: string): Promise<T> {
      return runInNewContext(expression, {
        document,
        location: { href: "od://app/drafts" },
        innerWidth: 1366,
        innerHeight: 705,
        getComputedStyle: (e: {
          style: { display?: string; visibility?: string; opacity?: string };
        }) => ({
          display: e.style.display || "block",
          visibility: e.style.visibility || "visible",
          opacity: e.style.opacity || "1",
        }),
        KeyboardEvent: class {
          constructor(
            public type: string,
            public init: Record<string, unknown> = {},
          ) {}
        },
      }) as T;
    },
    async send() {
      return {};
    },
    async clickAt(_point, options) {
      const expect = options?.expect ?? "unknown";
      clicks.push(expect);
      if (expect === "working-dir-panel") {
        if (!panelOpens) return false;
        const menu = document.createElement("div");
        menu.setAttribute("role", "menu");
        menu.innerHTML = '<div role="menuitem" data-od="select-dir">选择目录</div>';
        document.querySelector("form")!.appendChild(menu);
        patchVisibility(); // 新插入的节点同样需要可见性补丁（见 patchVisibility 注释）
        return true;
      }
      if (expect === "native-folder-dialog") {
        behaviour.onNativeDialog?.({ setWorkspaceValue });
        return true;
      }
      return false;
    },
  };
  return { page, clicks, setWorkspaceValue };
}

function gui() {
  return GuiProfileSchema.parse({
    ...ZCODE_SETUP_DEFAULTS,
    cdpPort: 9889,
    projectTriggerTimeoutMs: 200,
  });
}

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const OK_NATIVE: FolderDialogOutcome = {
  ok: true,
  mode: "wm-settext",
  readback: TARGET,
  message: "已确认",
};

/** 默认依赖：原生成功且**应用接受**新目录 */
function deps(over: Partial<Parameters<typeof bindWorkspace>[0]["deps"]> = {}) {
  return {
    listDialogs: async () => [] as string[],
    selectFolder: async () => OK_NATIVE,
    sleep: async () => {},
    ...over,
  };
}

describe("Open Design 工作目录：路径比较", () => {
  it("归一大小写/斜杠/尾斜杠", () => {
    expect(normalizeWorkspacePath("D:/Trae项目/tianshu-mcp/")).toBe("d:\\trae项目\\tianshu-mcp");
    expect(normalizeWorkspacePath("d:\\Trae项目\\tianshu-mcp")).toBe("d:\\trae项目\\tianshu-mcp");
  });

  it("盘根补成 `D:\\`", () => {
    expect(normalizeWorkspacePath("d:")).toBe("d:\\");
  });

  it("完全一致 → 命中", () => {
    expect(workspaceMatches("D:\\proj", "d:/proj/")).toBe(true);
  });

  it("界面截断（省略号结尾）时按前缀命中", () => {
    expect(workspaceMatches("D:\\Trae项目\\tian…", TARGET)).toBe(true);
    expect(workspaceMatches("D:\\Other\\tian…", TARGET)).toBe(false);
  });

  it("空值一律不命中（空显示值不得当成已绑定）", () => {
    expect(workspaceMatches("", TARGET)).toBe(false);
    expect(workspaceMatches(undefined, TARGET)).toBe(false);
    expect(workspaceMatches("D:\\proj", "")).toBe(false);
  });
});

describe("Open Design 工作目录绑定：成功路径", () => {
  it("已是目标目录 → already-bound，且**不做任何点击**", async () => {
    const { page, clicks } = makePage(TARGET);
    const res = await bindWorkspace({
      page,
      targetPath: TARGET,
      ownerPids: [1],
      gui: gui(),
      logger,
      overrides: CAPTURED,
      deps: deps(),
    });
    expect(res.ok).toBe(true);
    expect(res.reason).toBe("already-bound");
    expect(clicks).toEqual([]);
  });

  it("展开 → 点选择目录 → 原生对话框 → 回读一致 → 成功", async () => {
    const { page, clicks } = makePage(OTHER, {
      onNativeDialog: ({ setWorkspaceValue }) => setWorkspaceValue(TARGET),
    });
    const res = await bindWorkspace({
      page,
      targetPath: TARGET,
      ownerPids: [1],
      gui: gui(),
      logger,
      overrides: CAPTURED,
      deps: deps(),
    });
    expect(res.ok).toBe(true);
    expect(res.shown).toBe(TARGET);
    expect(clicks).toEqual(["working-dir-panel", "native-folder-dialog"]);
  });

  it("**基线在点击「选择目录」之前采样**，并原样传给原生流程", async () => {
    const order: string[] = [];
    let baselineSeen: string[] = [];
    const { page } = makePage(OTHER, {
      onNativeDialog: ({ setWorkspaceValue }) => {
        order.push("native");
        setWorkspaceValue(TARGET);
      },
    });
    await bindWorkspace({
      page,
      targetPath: TARGET,
      ownerPids: [7],
      gui: gui(),
      logger,
      overrides: CAPTURED,
      deps: deps({
        listDialogs: async () => {
          order.push("baseline");
          return ["dialog:100:选择文件夹"];
        },
        selectFolder: async (_p, _pids, baseline) => {
          baselineSeen = baseline;
          return OK_NATIVE;
        },
      }),
    });
    expect(order).toEqual(["baseline", "native"]);
    expect(baselineSeen).toEqual(["dialog:100:选择文件夹"]);
  });
});

describe("Open Design 工作目录绑定：失败路径", () => {
  it("触发器无法唯一定位 → no-panel，且不点任何东西", async () => {
    const { page, clicks } = makePage(OTHER);
    // 抹掉触发器：让 singlePoint 匹配数为 0
    const patched: OpenDesignPage = {
      ...page,
      evaluate: async <T>(expression: string): Promise<T> => {
        if (expression.includes("od:point")) return { count: 0 } as unknown as T;
        return page.evaluate<T>(expression);
      },
    };
    const res = await bindWorkspace({
      page: patched,
      targetPath: TARGET,
      ownerPids: [1],
      gui: gui(),
      logger,
      overrides: CAPTURED,
      deps: deps(),
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("no-panel");
    expect(clicks).toEqual([]);
  });

  it("展开后没有「选择目录」项 → no-item（预算内轮询后如实失败）", async () => {
    const { page } = makePage(OTHER, { panelOpens: false });
    const res = await bindWorkspace({
      page,
      targetPath: TARGET,
      ownerPids: [1],
      gui: gui(),
      logger,
      overrides: CAPTURED,
      deps: deps(),
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("click");
  });

  it("面板打开但菜单项缺失 → no-item", async () => {
    const { page } = makePage(OTHER, { panelOpens: true });
    const patched: OpenDesignPage = {
      ...page,
      evaluate: async <T>(expression: string): Promise<T> => {
        // 展开成功后立刻移除菜单项，模拟渲染失败
        const result = await page.evaluate<T>(expression);
        if (expression.includes("od:exists")) return false as unknown as T;
        return result;
      },
    };
    const res = await bindWorkspace({
      page: patched,
      targetPath: TARGET,
      ownerPids: [1],
      gui: gui(),
      logger,
      overrides: CAPTURED,
      deps: deps(),
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("no-item");
  });

  it("原生对话框失败（歧义）→ 原样上报 message 与细节", async () => {
    const { page } = makePage(OTHER);
    const native: FolderDialogOutcome = {
      ok: false,
      reason: "ambiguous",
      message: "同时出现多个新的 #32770 对话框",
    };
    const res = await bindWorkspace({
      page,
      targetPath: TARGET,
      ownerPids: [1],
      gui: gui(),
      logger,
      overrides: CAPTURED,
      deps: deps({ selectFolder: async () => native }),
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("native");
    expect(res.message).toContain("多个");
    expect(res.native).toBe(native);
  });

  it("**原生成功但回读不一致 → readback 失败**（对话框关闭 ≠ 应用已接受）", async () => {
    const { page } = makePage(OTHER); // 界面显示值不变
    const res = await bindWorkspace({
      page,
      targetPath: TARGET,
      ownerPids: [1],
      gui: gui(),
      logger,
      overrides: CAPTURED,
      deps: deps(),
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("readback");
    expect(res.shown).toBe(OTHER);
    expect(res.message).toContain("未把绑定当成成功");
  });
});

describe("Open Design 工作目录：回读", () => {
  it("readWorkspaceValue 读触发器文本；页面无该元素时返回空串", async () => {
    const ok = makePage(TARGET);
    expect(await readWorkspaceValue(ok.page, CAPTURED)).toBe(TARGET);
    const missing = makePage("");
    expect(await readWorkspaceValue(missing.page, CAPTURED)).toBe("");
  });
});
