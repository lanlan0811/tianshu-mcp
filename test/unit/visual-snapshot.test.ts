import { afterEach, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { captureVisualSnapshot, checkVisualSnapshot } from "../../src/visual/snapshot.js";

/**
 * 冻结摘要与语义-only 页面（issue #13 计划 §5 D 组核对点 / D9）：
 * `pixel:false` 页面无像素维度，基线必须显式记 null，且不去读可能残留的无关基准文件——
 * 否则删改一个与该页无关的基准会让冻结摘要漂移，误报 VISUAL_INTEGRITY。
 */
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function projectWith(pages: unknown[]): Promise<string> {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "visual-snapshot-"));
  dirs.push(project);
  await fs.mkdir(path.join(project, ".tianshu-mcp"), { recursive: true });
  await fs.writeFile(
    path.join(project, ".tianshu-mcp", "acceptance.json"),
    JSON.stringify({
      visual: {
        enabled: true,
        viewports: [{ id: "desktop", width: 100, height: 100 }],
        content: {
          enabled: true,
          command: process.execPath,
          argsTemplate: ["-e", "0", "<image:path>"],
        },
        pages,
      },
    }),
  );
  return project;
}

it("records null baselines for semantic-only pages without reading stray files (D9)", async () => {
  const project = await projectWith([
    { id: "home", source: { type: "static", root: "." } },
    {
      id: "login",
      pixel: false,
      source: { type: "static", root: "." },
      content: { expect: "login form" },
    },
  ]);
  // 语义页面派生路径上放一个「残留」基准文件：摘要必须忽略它
  const stray = path.join(
    project,
    "tests",
    "visual",
    "baselines",
    process.platform,
    "managed",
    "login",
    "desktop.png",
  );
  await fs.mkdir(path.dirname(stray), { recursive: true });
  await fs.writeFile(stray, Buffer.from([1, 2, 3]));

  const snapshot = await captureVisualSnapshot(project);
  expect(snapshot.baselines[path.join("tests", "visual", "baselines", process.platform, "managed", "login", "desktop.png")]).toBeNull();
  expect(
    snapshot.baselines[
      `${path.join("tests", "visual", "baselines", process.platform, "managed", "login", "desktop.png")}.manifest.json`
    ],
  ).toBeNull();

  // 同一配置重复采集应稳定；删掉残留文件也不改变冻结摘要
  await fs.rm(stray, { force: true });
  const again = await captureVisualSnapshot(project);
  expect(JSON.stringify(again.baselines)).toBe(JSON.stringify(snapshot.baselines));
  await expect(checkVisualSnapshot(project, snapshot)).resolves.toBeUndefined();
});

it("still records real digests for pixel pages", async () => {
  const project = await projectWith([{ id: "home", source: { type: "static", root: "." } }]);
  const baseline = path.join(
    project,
    "tests",
    "visual",
    "baselines",
    process.platform,
    "managed",
    "home",
    "desktop.png",
  );
  await fs.mkdir(path.dirname(baseline), { recursive: true });
  await fs.writeFile(baseline, Buffer.from([9, 9, 9]));

  const snapshot = await captureVisualSnapshot(project);
  const relative = path.join("tests", "visual", "baselines", process.platform, "managed", "home", "desktop.png");
  expect(snapshot.baselines[relative]).toBeTruthy();
  expect(snapshot.baselines[`${relative}.manifest.json`]).toBeNull();
});
