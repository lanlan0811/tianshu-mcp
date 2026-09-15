#!/usr/bin/env node
/**
 * 跨平台内容判定桩（issue #13 计划 §5 G 组）：
 * 用作测试与 `visual content probe` 演示的自备命令。行为由环境变量决定：
 *   CONTENT_JUDGE_MODE     pass | fail | flip（按调用次数交替）| low-confidence | no-confidence
 *                          | invalid（非法输出）| exit（非零退出）| sleep（睡眠触发超时）
 *   CONTENT_JUDGE_COUNTER  每次调用追加一行的计数文件路径（供采样数与缓存命中断言）
 * 契约：stdout 末行输出 { passed, confidence?, reason }；先校验占位符实参确实可达。
 */
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
};

const counter = process.env.CONTENT_JUDGE_COUNTER;
let calls = 0;
if (counter) {
  try {
    calls = fs.readFileSync(counter, "utf8").trim().split(/\r?\n/).filter(Boolean).length;
  } catch {
    calls = 0;
  }
  fs.mkdirSync(path.dirname(counter), { recursive: true });
  fs.appendFileSync(counter, `${Date.now()}\n`);
}

const imagePath = flag("--image");
const expectFile = flag("--expect-file");
const b64File = flag("--image-b64-file") ?? flag("--b64-file");
const problems = [];
if (imagePath && !fs.existsSync(imagePath)) problems.push(`image missing: ${imagePath}`);
if (expectFile) {
  if (!fs.existsSync(expectFile)) problems.push(`expect file missing: ${expectFile}`);
  else if (!fs.readFileSync(expectFile, "utf8").trim()) problems.push("expect file is empty");
}
if (b64File) {
  if (!fs.existsSync(b64File)) problems.push(`base64 file missing: ${b64File}`);
  else if (!Buffer.from(fs.readFileSync(b64File, "utf8"), "base64").length)
    problems.push("base64 payload is empty");
}
if (problems.length) {
  console.error(problems.join("; "));
  process.exit(3);
}

const expectText = expectFile
  ? fs.readFileSync(expectFile, "utf8").trim().slice(0, 80)
  : "declared expectation";
const mode = process.env.CONTENT_JUDGE_MODE ?? "pass";
switch (mode) {
  case "pass":
    console.log(JSON.stringify({ passed: true, confidence: 0.9, reason: `satisfied: ${expectText}` }));
    break;
  case "fail":
    console.log(JSON.stringify({ passed: false, confidence: 0.9, reason: `not satisfied: ${expectText}` }));
    break;
  case "flip": {
    const passed = calls % 2 === 0;
    console.log(
      JSON.stringify({
        passed,
        confidence: 0.8,
        reason: `sample #${calls + 1}: ${passed ? "ok" : "no"}`,
      }),
    );
    break;
  }
  case "low-confidence":
    console.log(JSON.stringify({ passed: true, confidence: 0.3, reason: "passed but unsure" }));
    break;
  case "no-confidence":
    console.log(JSON.stringify({ passed: true, reason: "passed without confidence" }));
    break;
  case "invalid":
    console.log("this line is not json");
    break;
  case "exit":
    console.error("judge exploded");
    process.exit(2);
    break;
  case "sleep":
    setTimeout(() => console.log(JSON.stringify({ passed: true, reason: "too late" })), 60_000);
    break;
  default:
    console.error(`unknown CONTENT_JUDGE_MODE: ${mode}`);
    process.exit(4);
}
