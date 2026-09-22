/**
 * 单元测试：GUI 停止结果的如实披露（issue #14）。
 * 红线 8 要求「未确认停止时终态必须明示」——本文件锁死三种输入（已确认停止 / 点击过未确认 /
 * 无停止结果）的判定与文案，防止 shutdown 路径再次出现「进程已终止」式的失真断言。
 * 另覆盖 `guiAppNameOf()`：窗口名由 profile 派生，且绝不因剥词把名字剥空。
 */
import { describe, it, expect } from "vitest";
import { guiAppNameOf, guiStopDisclosure } from "../../src/tasks/task.js";

describe("guiAppNameOf：profile 派生的窗口称呼", () => {
  it("剥掉括号内的说明段与通用后缀，保留产品名", () => {
    expect(guiAppNameOf("Codex (ChatGPT 桌面端 GUI)", "codex")).toBe("Codex");
    expect(guiAppNameOf("Kimi Code 桌面端", "kimicode")).toBe("Kimi Code");
    expect(guiAppNameOf("TraeWork (GUI)", "traework")).toBe("TraeWork");
  });

  it("保留有实际意义的括号段（不做无限剥离）", () => {
    expect(guiAppNameOf("TraeWork（测试）", "traework")).toBe("TraeWork（测试）");
    expect(guiAppNameOf("Qoder CN", "qoder")).toBe("Qoder CN");
    expect(guiAppNameOf("ZCode", "zcode")).toBe("ZCode");
  });

  it("无 displayName 时回退 agentId，且剥词剥空时退回原名", () => {
    expect(guiAppNameOf(undefined, "codex")).toBe("codex");
    expect(guiAppNameOf("", "kimicode")).toBe("kimicode");
    // 只有通用词的 displayName 不得被剥成空串——文案可以长，不能失真
    expect(guiAppNameOf("桌面端", "custom")).toBe("桌面端");
    expect(guiAppNameOf("App 客户端", "custom")).toBe("App 客户端");
  });

  it("收敛多余空白", () => {
    expect(guiAppNameOf("  Kimi   Code  ", "kimicode")).toBe("Kimi Code");
  });
});

describe("guiStopDisclosure：已停止 / 未确认 / 无结果 三态", () => {
  const app = "Kimi Code";

  it("idle=true → 已确认停止，明示已停止且不出现可能仍在继续", () => {
    const d = guiStopDisclosure({ clicked: true, idle: true }, app);
    expect(d.clean).toBe(true);
    expect(d.text).toContain("已确认 Kimi Code 内运行停止");
    expect(d.text).not.toContain("可能仍在继续");
  });

  it("idle=false（点击过但未确认）→ 明示未确认停止并要求人工确认", () => {
    const d = guiStopDisclosure({ clicked: true, idle: false }, app);
    expect(d.clean).toBe(false);
    expect(d.text).toContain("Kimi Code 内运行未确认停止");
    expect(d.text).toContain("窗口中的任务可能仍在继续");
    expect(d.text).toContain("请人工打开 Kimi Code 确认无残留运行");
  });

  it("无停止结果（无停止能力 / 未及尝试）→ 同样不得声称已停止", () => {
    const d = guiStopDisclosure(undefined, app);
    expect(d.clean).toBe(false);
    expect(d.text).toContain("Kimi Code 内运行无停止结果可确认");
    expect(d.text).toContain("窗口中的任务可能仍在继续");
    expect(d.text).not.toContain("已确认");
  });

  it("clicked=false 但 idle=true 仍算已确认（界面本来就空闲）", () => {
    expect(guiStopDisclosure({ clicked: false, idle: true }, app).clean).toBe(true);
  });

  it("任何输入都不得包含 spawn 语义的「进程已终止」断言", () => {
    for (const stop of [undefined, { clicked: false, idle: false }, { clicked: true, idle: true }]) {
      expect(guiStopDisclosure(stop, app).text).not.toContain("进程已终止");
    }
  });
});
