import fs from "node:fs/promises";
import path from "node:path";
import type { VisualConfig } from "./schema.js";
import { VisualError } from "./errors.js";

export class VisualBudget {
  readonly controller = new AbortController();
  readonly signal: AbortSignal;
  readonly deadline: number;
  bytes = 0;
  private timer: ReturnType<typeof setTimeout>;
  private readonly onAbort = (): void => {
    this.controller.abort(this.parent?.reason);
  };
  constructor(
    readonly limits: VisualConfig["limits"],
    private readonly parent?: AbortSignal,
  ) {
    this.signal = this.controller.signal;
    this.deadline = Date.now() + limits.roundTimeoutMs;
    this.timer = setTimeout(
      () =>
        this.controller.abort(new VisualError("ROUND_TIMEOUT", "Visual round deadline exceeded")),
      limits.roundTimeoutMs,
    );
    if (parent?.aborted) this.onAbort();
    else parent?.addEventListener("abort", this.onAbort, { once: true });
  }
  check(): void {
    if (this.parent?.aborted)
      throw new VisualError("CANCELLED", "Visual acceptance cancelled", "cancelled");
    if (this.signal.aborted || Date.now() >= this.deadline)
      throw new VisualError("ROUND_TIMEOUT", "Visual round deadline exceeded");
  }
  timeout(limit: number, itemDeadline = this.deadline): number {
    this.check();
    const remaining = Math.min(limit, itemDeadline - Date.now(), this.deadline - Date.now());
    if (remaining <= 0) throw new VisualError("ITEM_TIMEOUT", "Visual item deadline exceeded");
    return remaining;
  }
  async write(filename: string, content: Uint8Array | string): Promise<void> {
    this.check();
    const size = typeof content === "string" ? Buffer.byteLength(content) : content.byteLength;
    if (this.bytes + size > this.limits.artifactBytes)
      throw new VisualError(
        "ARTIFACT_BUDGET",
        "Visual artifact budget exceeded; previous evidence retained",
      );
    this.bytes += size;
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, content, { flag: "wx" });
  }
  dispose(): void {
    clearTimeout(this.timer);
    this.parent?.removeEventListener("abort", this.onAbort);
  }
}
