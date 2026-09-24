/**
 * 单元测试：细粒度事件的基础设施（issue #18）。
 * 覆盖尾部有界读取、事件过滤与条数上限、上报钩子的「永不抛错」语义。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import fsp from "node:fs/promises";
import { TaskStore } from "../../src/tasks/task-store.js";
import { Logger } from "../../src/util/log.js";
import { readTextTail } from "../../src/util/fs.js";
import {
  AGENT_EVENT_NAMES,
  isAgentEventName,
  makeEmitter,
  type AgentEvent,
} from "../../src/agents/agent-events.js";
import { makeTmpRoot, rmrf } from "../test-utils.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rmrf(root)));
});

async function tmpDir(tag: string): Promise<string> {
  const dir = await makeTmpRoot(tag);
  roots.push(dir);
  return dir;
}

describe("readTextTail", () => {
  it("文件不超过预算时返回全文", async () => {
    const dir = await tmpDir("tail-small");
    const f = path.join(dir, "a.jsonl");
    await fsp.writeFile(f, "l1\nl2\nl3\n", "utf8");
    expect(await readTextTail(f, 1024)).toBe("l1\nl2\nl3\n");
  });

  it("文件不存在返回 null（不抛错）", async () => {
    const dir = await tmpDir("tail-missing");
    expect(await readTextTail(path.join(dir, "nope.jsonl"), 16)).toBeNull();
  });

  it("超长文件只读尾部，且首个残行被丢弃", async () => {
    const dir = await tmpDir("tail-large");
    const f = path.join(dir, "a.jsonl");
    // 每行 10 字节（含换行），共 100 行
    const lines = Array.from({ length: 100 }, (_, i) => `line-${String(i).padStart(4, "0")}`);
    await fsp.writeFile(f, lines.map((l) => `${l}\n`).join(""), "utf8");

    const tail = await readTextTail(f, 45);
    expect(tail).not.toBeNull();
    const got = tail!.split("\n").filter(Boolean);
    // 不包含任何被截断的半个行
    for (const l of got) expect(l).toMatch(/^line-\d{4}$/);
    // 确实只取了尾部
    expect(got.length).toBeLessThan(lines.length);
    expect(got.at(-1)).toBe("line-0099");
  });

  it("截断点恰好落在换行符上时不丢整行", async () => {
    const dir = await tmpDir("tail-boundary");
    const f = path.join(dir, "a.txt");
    await fsp.writeFile(f, "aaaa\nbbbb\ncccc\n", "utf8");
    // 文件 15 字节；maxBytes=5 → readFrom=9，buf 从 "bbbb\ncccc\n" 的第一个 b 读起？
    // 说明：readFrom = size - maxBytes - 1 = 9，即字符 'b'（第二个 bbbb 的起点）；
    // 该位置不是换行，故丢弃残行 "bbbb"，保留 "cccc"。
    const tail = await readTextTail(f, 5);
    expect(tail).toBe("cccc\n");
  });
});

describe("isAgentEventName / AGENT_EVENT_NAMES", () => {
  it("词表覆盖 issue #18 要求的 5 类事件", () => {
    expect([...AGENT_EVENT_NAMES].sort()).toEqual(
      [
        "awaiting_user_authorization",
        "confirmation_dialog_detected",
        "file_modification_started",
        "rework_triggered",
        "task_dispatched",
      ].sort(),
    );
  });

  it("只认词表内的事件名", () => {
    expect(isAgentEventName("task_dispatched")).toBe(true);
    expect(isAgentEventName("note")).toBe(false);
    expect(isAgentEventName("started")).toBe(false);
  });
});

describe("makeEmitter", () => {
  it("未提供钩子时是空操作且不抛错", async () => {
    const emit = makeEmitter(undefined);
    await expect(emit("task_dispatched", "x")).resolves.toBeUndefined();
  });

  it("原样转发 kind / detail / data", async () => {
    const seen: AgentEvent[] = [];
    const emit = makeEmitter((ev) => {
      seen.push(ev);
    });
    await emit("confirmation_dialog_detected", "检测到原生对话框", { dialog: "source_folder" });
    expect(seen).toEqual([
      { kind: "confirmation_dialog_detected", detail: "检测到原生对话框", data: { dialog: "source_folder" } },
    ]);
  });

  it("钩子抛错被吞掉——上报失败不得影响任务本体", async () => {
    const emit = makeEmitter(() => {
      throw new Error("落盘失败");
    });
    await expect(emit("file_modification_started", "x")).resolves.toBeUndefined();
  });

  it("钩子返回 rejected Promise 同样被吞掉", async () => {
    const emit = makeEmitter(() => Promise.reject(new Error("io")));
    await expect(emit("awaiting_user_authorization", "x")).resolves.toBeUndefined();
  });
});

describe("TaskStore.readRecentAgentEvents", () => {
  async function fixture() {
    const home = await tmpDir("recent-events");
    const store = new TaskStore(home, new Logger(null, "error"));
    return { store, taskId: "tsk_events" };
  }

  it("只返回词表内的事件，忽略 note 等既有事件", async () => {
    const { store, taskId } = await fixture();
    await store.appendEvent(taskId, "created", "queued", "created");
    await store.appendEvent(taskId, "task_dispatched", "running", "已派发");
    await store.appendEvent(taskId, "note", "running", "普通进度");
    await store.appendEvent(taskId, "started", "running", "started");
    await store.appendEvent(taskId, "rework_triggered", "fixing", "进入返修");

    const got = await store.readRecentAgentEvents(taskId, 10);
    expect(got.map((e) => e.event)).toEqual(["task_dispatched", "rework_triggered"]);
    expect(got[0]!.detail).toBe("已派发");
  });

  it("按时间正序返回最近 limit 条", async () => {
    const { store, taskId } = await fixture();
    for (const name of AGENT_EVENT_NAMES) {
      await store.appendEvent(taskId, name, "running", `detail-${name}`);
    }
    const got = await store.readRecentAgentEvents(taskId, 2);
    expect(got.map((e) => e.detail)).toEqual([
      `detail-${AGENT_EVENT_NAMES.at(-2)}`,
      `detail-${AGENT_EVENT_NAMES.at(-1)}`,
    ]);
  });

  it("任务不存在时返回空数组", async () => {
    const { store } = await fixture();
    expect(await store.readRecentAgentEvents("tsk_absent", 10)).toEqual([]);
  });

  it("坏行被跳过而非导致整体失败", async () => {
    const { store, taskId } = await fixture();
    await store.appendEvent(taskId, "task_dispatched", "running", "ok");
    await fsp.appendFile(store.jsonlPath(taskId), "{ 这不是 JSON\n", "utf8");
    await store.appendEvent(taskId, "rework_triggered", "fixing", "ok2");

    const got = await store.readRecentAgentEvents(taskId, 10);
    expect(got.map((e) => e.event)).toEqual(["task_dispatched", "rework_triggered"]);
  });

  it("超过尾部窗口时只保留窗口内的事件（内存不随文件膨胀）", async () => {
    const { store, taskId } = await fixture();
    // 先写一批「远古」事件，再写大量填充把窗口挤出去
    await store.appendEvent(taskId, "task_dispatched", "running", "远古");
    const filler = "x".repeat(512);
    for (let i = 0; i < 200; i++) {
      await store.appendEvent(taskId, "note", "running", `${i}-${filler}`);
    }
    await store.appendEvent(taskId, "rework_triggered", "fixing", "近期");

    const got = await store.readRecentAgentEvents(taskId, 10, 4 * 1024);
    expect(got.map((e) => e.detail)).toEqual(["近期"]);
  });
});
