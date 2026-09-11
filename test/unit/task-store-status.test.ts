import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskStore } from "../../src/tasks/task-store.js";
import type { TaskMeta } from "../../src/tasks/task.js";
import { Logger } from "../../src/util/log.js";
import { makeTmpRoot, rmrf } from "../test-utils.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rmrf(root)));
});

async function fixture(status: TaskMeta["status"] = "queued") {
  const home = await makeTmpRoot("task-store-status");
  roots.push(home);
  const store = new TaskStore(home, new Logger(null, "error"));
  const now = new Date().toISOString();
  const meta: TaskMeta = {
    taskId: "tsk_status_race",
    status,
    projectPath: home,
    displayPath: home,
    agentId: "stub",
    task: "状态持久化竞态回归",
    autoVerify: false,
    autoFixRounds: 0,
    taskTimeoutMs: 60_000,
    round: 0,
    roundsUsed: 0,
    createdAt: now,
    updatedAt: now,
  };
  return { store, meta };
}

describe("TaskStore 状态写入串行化", () => {
  it("终态不会被迟到的活动态或其他终态写入覆盖", async () => {
    const { store, meta } = await fixture("cancelled");
    meta.finishedAt = meta.updatedAt;
    await store.writeSnapshot(meta);

    await store.updateStatus(meta, "running", "迟到的 orchestrator 启动事件", "started");
    await store.updateStatus(meta, "failed", "迟到的 manager 异常收尾");

    expect(meta.status).toBe("cancelled");
    expect((await store.readSnapshot(meta.taskId))?.status).toBe("cancelled");
    expect(await store.readEvents(meta.taskId)).toHaveLength(0);
  });

  it("状态写入屏障等待事件和快照全部落盘", async () => {
    const { store, meta } = await fixture();
    const originalAppend = store.appendEvent.bind(store);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(store, "appendEvent").mockImplementation(async (...args) => {
      await gate;
      return originalAppend(...args);
    });

    const update = store.updateStatus(meta, "cancelled", "用户取消");
    await vi.waitFor(() => expect(meta.status).toBe("cancelled"));
    let barrierFinished = false;
    const barrier = store.waitForStatusWrite(meta.taskId).then(() => {
      barrierFinished = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(barrierFinished).toBe(false);

    release();
    await Promise.all([update, barrier]);
    expect((await store.readEvents(meta.taskId)).at(-1)?.event).toBe("cancelled");
    expect((await store.readSnapshot(meta.taskId))?.status).toBe("cancelled");
  });
});
