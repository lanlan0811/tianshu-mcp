import { describe, expect, it } from "vitest";
import { DEEPLINK_EVENT, DEEPLINK_SCHEME, firstDeepLinkTarget, parseDeepLink } from "@/core/deeplink";

describe("A8b 深链解析", () => {
  it("接受 tianshu://task/<任务ID>（含查询串 / 片段 / 末尾斜杠）", () => {
    expect(parseDeepLink("tianshu://task/tsk_20260926135200_d4e5f6")).toEqual({
      view: "task",
      taskId: "tsk_20260926135200_d4e5f6",
    });
    expect(parseDeepLink("tianshu://task/tsk_1/")).toEqual({ view: "task", taskId: "tsk_1" });
    expect(parseDeepLink("tianshu://task/tsk_1?source=cli#x")).toEqual({
      view: "task",
      taskId: "tsk_1",
    });
    // 大小写不敏感（URL 会把 scheme / host 小写化）
    expect(parseDeepLink("TIANSHU://TASK/tsk_1")).toEqual({ view: "task", taskId: "tsk_1" });
  });

  it("拒绝其它 scheme / 其它 host / 缺 ID / 多段路径", () => {
    for (const bad of [
      "",
      "   ",
      "not-a-url",
      "https://task/tsk_1",
      "tianshu://insights",
      "tianshu://task",
      "tianshu://task/",
      "tianshu://task/tsk_1/extra",
      "tianshu://task/tsk_1/other/",
    ]) {
      expect(parseDeepLink(bad), bad).toBeNull();
    }
  });

  it("任务 ID 走字符白名单，挡住路径穿越（深链是外部输入，ID 会拼进文件路径）", () => {
    for (const bad of [
      "tianshu://task/..",
      "tianshu://task/../secrets",
      "tianshu://task/a%2Fb",
      "tianshu://task/tsk%5C1",
      "tianshu://task/tsk 1",
      "tianshu://task/tsk.1",
    ]) {
      expect(parseDeepLink(bad), bad).toBeNull();
    }
    // 合法字符集（字母 / 数字 / 下划线 / 连字符）
    expect(parseDeepLink("tianshu://task/vfy_2026-09-26_x1")?.taskId).toBe("vfy_2026-09-26_x1");
  });

  it("firstDeepLinkTarget：取第一条可识别的，全不可识别为 null", () => {
    expect(firstDeepLinkTarget(["tianshu://task/tsk_1", "tianshu://task/tsk_2"])?.taskId).toBe("tsk_1");
    expect(firstDeepLinkTarget(["bad", "tianshu://task/tsk_2"])?.taskId).toBe("tsk_2");
    expect(firstDeepLinkTarget(["bad", ""])).toBeNull();
    expect(firstDeepLinkTarget([])).toBeNull();
  });

  it("畸形百分号编码不抛错，按「无法识别」返回 null（issue #33）", () => {
    for (const bad of [
      // ① 转义格式非法：不是合法的 %XX 序列
      "tianshu://task/%zz",
      "tianshu://task/%",
      "tianshu://task/%z",
      "tianshu://task/%2",
      "tianshu://task/%%",
      "tianshu://task/%C3%28",
      "tianshu://task/%E0%A4%A",
      // ② 格式合法但解码结果非合法 UTF-8（孤立续接字节 / 非法序列）
      "tianshu://task/%80",
      "tianshu://task/%ED%A0%80",
      "tianshu://task/%FF",
    ]) {
      // 契约（文件头）：其余一律返回 null，不抛错。深链是外部输入，畸形转义必然走到解析层。
      expect(() => parseDeepLink(bad), bad).not.toThrow();
      expect(parseDeepLink(bad), bad).toBeNull();
    }
  });

  it("畸形链接不阻断同批合法链接（issue #33）", () => {
    // 现状：畸形链接抛错会中断整批，后面那条合法链接一起被吞掉
    expect(firstDeepLinkTarget(["tianshu://task/%zz", "tianshu://task/tsk_2"])?.taskId).toBe("tsk_2");
    // 全畸形批：如实返回「无可识别目标」，而不是抛错
    expect(firstDeepLinkTarget(["tianshu://task/%zz"])).toBeNull();
  });

  it("解码顺序不变量：先解码、再判白名单（issue #33 修复不得改变既有语义）", () => {
    // 合法转义 → 解码后才落在白名单内：必须仍能通过。
    // 若把 try/catch 放到白名单之后、或改成「先校验原串」，这条会从绿转红。
    expect(parseDeepLink("tianshu://task/tsk%5F1")).toEqual({ view: "task", taskId: "tsk_1" });
    // 解码结果落在白名单之外：仍为 null（顺序不变则结果不变）
    expect(parseDeepLink("tianshu://task/a%2Fb")).toBeNull();
    expect(parseDeepLink("tianshu://task/tsk%5C1")).toBeNull();
  });

  it("事件名与协议名与 Rust / tauri.conf 约定一致", () => {
    expect(DEEPLINK_EVENT).toBe("gui://deeplink");
    expect(DEEPLINK_SCHEME).toBe("tianshu");
  });
});
