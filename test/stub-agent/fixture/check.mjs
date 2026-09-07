/**
 * check.mjs — 验收检查：done.txt 存在且内容为 PASS 即通过。
 * 用于 stub-agent 集成测试（模拟真实项目的自动命令检查）。
 */
import fs from "node:fs";

function main() {
  if (!fs.existsSync("done.txt")) {
    console.error("done.txt 不存在");
    process.exit(1);
  }
  const content = fs.readFileSync("done.txt", "utf8").trim();
  if (content !== "PASS") {
    console.error(`done.txt 内容不是 PASS：${content}`);
    process.exit(1);
  }
  console.log("done.txt 检查通过");
  process.exit(0);
}

main();
