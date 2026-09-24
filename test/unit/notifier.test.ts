/**
 * 单元测试：终态通知器的映射 / 订阅过滤 / 默认关闭 / 恰好一次 / 失败不影响调用方（issue #22）。
 *
 * 用真实本地 http 服务而不是打桩 fetch：超时、重试、非 2xx 都发生在真实网络层。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { TaskNotifier, statusToEvent, type NotificationPayload } from "../../src/tasks/notifier.js";
import { WebhookConfigSchema, ServerConfigSchema } from "../../src/config/schema.js";
import { Logger } from "../../src/util/log.js";
import { startMockWebhook, closedPortUrl, waitForCondition, type MockWebhook } from "../test-utils.js";

const silent = new Logger(null, "error");
const hooks: MockWebhook[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(hooks.splice(0).map((h) => h.close()));
});

async function hook(opts: { status?: number; failFirst?: number } = {}): Promise<MockWebhook> {
  const h = await startMockWebhook(opts);
  hooks.push(h);
  return h;
}

function payload(over: Partial<NotificationPayload> = {}): NotificationPayload {
  return {
    taskId: "tsk_n",
    event: "done",
    status: "succeeded",
    ts: "2026-09-24T00:00:00.000Z",
    finishedAt: "2026-09-24T00:00:01.000Z",
    agentId: "stub",
    projectPath: "D:/proj",
    ...over,
  };
}

/** 用给定 webhook 配置构造 notifier（直接给 config，绕过文件） */
function notifierWith(webhook: unknown): TaskNotifier {
  const cfg = ServerConfigSchema.parse({ notifications: { webhook } });
  return new TaskNotifier(async () => cfg, silent);
}

describe("statusToEvent", () => {
  it("映射状态语义：succeeded→done、failed→failed、needs_attention→needs_human、needs_user→needs_user、cancelled/interrupted→cancelled", () => {
    expect(statusToEvent("succeeded")).toBe("done");
    expect(statusToEvent("failed")).toBe("failed");
    expect(statusToEvent("needs_attention")).toBe("needs_human");
    // 非终态与真终态刻意分开，见 schema 注释
    expect(statusToEvent("needs_user")).toBe("needs_user");
    expect(statusToEvent("cancelled")).toBe("cancelled");
    expect(statusToEvent("interrupted")).toBe("cancelled");
  });

  it("非终态/中间态不产生事件", () => {
    for (const s of ["queued", "running", "verify_start", "fixing"] as const) {
      expect(statusToEvent(s)).toBeUndefined();
    }
  });
});

describe("配置 schema", () => {
  it("默认只订阅真终态（needs_user 不在默认集）", () => {
    const cfg = WebhookConfigSchema.parse({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.events).toEqual(["done", "failed", "needs_human"]);
    expect(cfg.timeoutMs).toBe(5_000);
    expect(cfg.maxRetries).toBe(2);
    expect(cfg.backoffMs).toBe(500);
  });

  it("enabled=true 但缺 url 被 schema 拒绝（禁止「开了却不发」的静默混淆）", () => {
    expect(() => WebhookConfigSchema.parse({ enabled: true })).toThrow(/url/);
  });

  it("缺 notifications 整段时 ServerConfig 仍可解析（默认关闭）", () => {
    const cfg = ServerConfigSchema.parse({});
    expect(cfg.notifications?.webhook).toBeUndefined();
  });
});

describe("默认关闭：完全不发起请求", () => {
  it("未配置 webhook 时零请求", async () => {
    const h = await hook();
    const n = new TaskNotifier(async () => ServerConfigSchema.parse({}), silent);
    n.notify(payload({ taskId: "tsk_off" }));
    await new Promise((r) => setTimeout(r, 400));
    expect(h.attempts()).toBe(0);
  });

  it("enabled=false 时零请求", async () => {
    const h = await hook();
    notifierWith({ enabled: false, url: h.url }).notify(payload({ taskId: "tsk_disabled" }));
    await new Promise((r) => setTimeout(r, 400));
    expect(h.attempts()).toBe(0);
  });

  it("事件不在订阅集时零请求", async () => {
    const h = await hook();
    // 只订阅 cancelled，却发 done
    notifierWith({ enabled: true, url: h.url, events: ["cancelled"] }).notify(
      payload({ taskId: "tsk_filtered" }),
    );
    await new Promise((r) => setTimeout(r, 400));
    expect(h.attempts()).toBe(0);
  });

  it("needs_user（非终态）默认不通知，显式加进 events 后才通知", async () => {
    const h = await hook();
    // 默认订阅集只含真终态 → needs_user 类别不在其中，零请求
    notifierWith({ enabled: true, url: h.url }).notify(
      payload({ taskId: "tsk_nu1", event: "needs_user", status: "needs_user" }),
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(h.attempts()).toBe(0);

    // 显式订阅后即通知
    notifierWith({ enabled: true, url: h.url, events: ["needs_user"] }).notify(
      payload({ taskId: "tsk_nu2", event: "needs_user", status: "needs_user" }),
    );
    expect(await waitForCondition(() => h.attempts() === 1)).toBe(true);
  });

  it("needs_attention（真终态）默认就通知", async () => {
    const h = await hook();
    notifierWith({ enabled: true, url: h.url }).notify(
      payload({ taskId: "tsk_na", event: "needs_human", status: "needs_attention" }),
    );
    expect(await waitForCondition(() => h.attempts() === 1)).toBe(true);
  });
});

describe("成功发送", () => {
  it("POST 请求体含任务标识与状态，且带事件头", async () => {
    const h = await hook();
    notifierWith({ enabled: true, url: h.url }).notify(payload({ taskId: "tsk_ok", message: "完成" }));
    expect(await waitForCondition(() => h.received.length === 1)).toBe(true);

    const got = h.received[0]!;
    expect(got.headers["x-tianshu-event"]).toBe("done");
    expect((got.body as Record<string, unknown>).taskId).toBe("tsk_ok");
    expect((got.body as Record<string, unknown>).status).toBe("succeeded");
    expect((got.body as Record<string, unknown>).event).toBe("done");
    expect((got.body as Record<string, unknown>).message).toBe("完成");
  });

  it("配了 secret 时附 HMAC-SHA256 签名，且签名可用同一 secret 复算校验", async () => {
    const h = await hook();
    notifierWith({ enabled: true, url: h.url, secret: "s3cr3t" }).notify(payload({ taskId: "tsk_sig" }));
    expect(await waitForCondition(() => h.received.length === 1)).toBe(true);

    const sig = h.received[0]!.headers["x-tianshu-signature"] as string;
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    const expectSig = createHmac("sha256", "s3cr3t")
      .update(JSON.stringify(h.received[0]!.body), "utf8")
      .digest("hex");
    expect(sig).toBe(`sha256=${expectSig}`);
  });

  it("不配 secret 时不带签名头", async () => {
    const h = await hook();
    notifierWith({ enabled: true, url: h.url }).notify(payload({ taskId: "tsk_nosig" }));
    expect(await waitForCondition(() => h.received.length === 1)).toBe(true);
    expect(h.received[0]!.headers["x-tianshu-signature"]).toBeUndefined();
  });
});

describe("恰好一次", () => {
  it("同一 taskId+status+finishedAt 重复 notify 只发一次", async () => {
    const h = await hook();
    const n = notifierWith({ enabled: true, url: h.url });
    const p = payload({ taskId: "tsk_once" });
    n.notify(p);
    n.notify(p);
    n.notify(p);
    expect(await waitForCondition(() => h.attempts() === 1)).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    expect(h.attempts()).toBe(1);
  });

  it("finishedAt 不同（返修后的新回合）→ 再次通知", async () => {
    const h = await hook();
    const n = notifierWith({ enabled: true, url: h.url });
    n.notify(payload({ taskId: "tsk_again", finishedAt: "2026-09-24T00:00:01.000Z" }));
    expect(await waitForCondition(() => h.attempts() === 1)).toBe(true);
    n.notify(payload({ taskId: "tsk_again", finishedAt: "2026-09-24T05:00:00.000Z" }));
    expect(await waitForCondition(() => h.attempts() === 2)).toBe(true);
  });

  it("同 taskId 但状态不同 → 各自通知一次", async () => {
    const h = await hook();
    const n = notifierWith({ enabled: true, url: h.url, events: ["done", "failed"] });
    n.notify(payload({ taskId: "tsk_multi", event: "failed", status: "failed", finishedAt: "t1" }));
    n.notify(payload({ taskId: "tsk_multi", event: "done", status: "succeeded", finishedAt: "t2" }));
    expect(await waitForCondition(() => h.attempts() === 2)).toBe(true);
  });
});

describe("失败不阻塞、不外抛", () => {
  it("服务端恒 500：重试到上限后放弃，且 notify 不抛错", async () => {
    const h = await hook({ status: 500 });
    const warn = vi.spyOn(silent, "warn").mockImplementation(() => {});
    const n = notifierWith({ enabled: true, url: h.url, maxRetries: 1, backoffMs: 0 });
    expect(() => n.notify(payload({ taskId: "tsk_500" }))).not.toThrow();
    expect(await waitForCondition(() => h.attempts() === 2)).toBe(true);
    expect(warn).toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 300));
    expect(h.attempts()).toBe(2); // 1 + maxRetries，不再多试
  });

  it("先失败后成功：重试一次即送达", async () => {
    const h = await hook({ failFirst: 1 });
    notifierWith({ enabled: true, url: h.url, maxRetries: 2, backoffMs: 0 }).notify(
      payload({ taskId: "tsk_flaky" }),
    );
    // 注意 received 记录**每一次**请求（含被拒的），所以不能等 received.length===1 就断言成功；
    // 要等第二次尝试到达，并核对两次的状态码。
    expect(await waitForCondition(() => h.attempts() === 2)).toBe(true);
    expect(h.received.map((r) => r.status)).toEqual([500, 200]);
    expect(h.attempts()).toBe(2); // 第二次即成功，不再多试
  });

  it("端口不可达：仅告警，notify 立即返回且不抛错", async () => {
    const url = await closedPortUrl();
    const warn = vi.spyOn(silent, "warn").mockImplementation(() => {});
    const n = notifierWith({ enabled: true, url, maxRetries: 0, backoffMs: 0 });
    expect(() => n.notify(payload({ taskId: "tsk_dead" }))).not.toThrow();
    expect(await waitForCondition(() => warn.mock.calls.length > 0, 15_000)).toBe(true);
  });

  it("读取配置抛错：只告警并跳过，不影响调用方", async () => {
    const warn = vi.spyOn(silent, "warn").mockImplementation(() => {});
    const n = new TaskNotifier(async () => {
      throw new Error("配置读失败");
    }, silent);
    expect(() => n.notify(payload({ taskId: "tsk_cfgerr" }))).not.toThrow();
    expect(await waitForCondition(() => warn.mock.calls.length > 0)).toBe(true);
  });
});
