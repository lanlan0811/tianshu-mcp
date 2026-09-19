import { describe, expect, it } from "vitest";
import {
  assertLevelSupported,
  defaultLevelFor,
  describeLevelValueError,
  exactUiName,
  levelOfToken,
  levelTokenMatches,
  normalizeReasoningLevel,
  parseKimicodeModel,
  parseTriggerValue,
  tierSetOf,
} from "../../src/agents/kimicode/model.js";

/**
 * M3 单测：模型与思考档位。
 *
 * 事实依据（真机实测 2026-09-20，Kimi Code 1.0.2）：
 * - 官方模型档位 `Low / High / Max`；非官方模型档位只有 `On / Off`；
 * - 触发器文本 `K3 · High`（中点 + 两侧空格），非官方模型为 `stepfun/… · 思考`（无档位 token）；
 * - `K3` 与 `K3-256k` 是并存的真实模型名 → 一切比较必须精确，不得前缀命中。
 */
describe("Kimi Code 思考等级归一", () => {
  it("中英双语都归一到同一档位", () => {
    expect(normalizeReasoningLevel("low")).toEqual({ level: "low" });
    expect(normalizeReasoningLevel("低")).toEqual({ level: "low" });
    expect(normalizeReasoningLevel("High")).toEqual({ level: "high" });
    expect(normalizeReasoningLevel(" 高 ")).toEqual({ level: "high" });
    expect(normalizeReasoningLevel("ＭＡＸ")).toEqual({ level: "max" });
    expect(normalizeReasoningLevel("On")).toEqual({ level: "on" });
    expect(normalizeReasoningLevel("OFF")).toEqual({ level: "off" });
  });

  it("中/medium 与其他值不归一，原值进 unsupported", () => {
    expect(normalizeReasoningLevel("中")).toEqual({ unsupported: "中" });
    expect(normalizeReasoningLevel("medium")).toEqual({ unsupported: "medium" });
    expect(normalizeReasoningLevel("极高")).toEqual({ unsupported: "极高" });
    expect(normalizeReasoningLevel(undefined)).toEqual({});
    expect(normalizeReasoningLevel("   ")).toEqual({});
  });

  it("档位 token 精确匹配，不做包含判断", () => {
    expect(levelOfToken("Max")).toBe("max");
    expect(levelOfToken("思考")).toBeUndefined();
    expect(levelTokenMatches("High", "high")).toBe(true);
    expect(levelTokenMatches("higher", "high")).toBe(false);
    expect(levelTokenMatches("极高", "high")).toBe(false);
  });
});

describe("Kimi Code 触发器文本解析", () => {
  it("官方模型：`模型 · 档位`", () => {
    expect(parseTriggerValue("K3 · High")).toEqual({ model: "K3", levelToken: "High" });
    expect(parseTriggerValue("K3 · Max")).toEqual({ model: "K3", levelToken: "Max" });
    expect(parseTriggerValue("K2.8 Preview · Low")).toEqual({
      model: "K2.8 Preview",
      levelToken: "Low",
    });
  });

  it("非官方模型：后缀是「思考」而不是档位，不当作档位 token", () => {
    expect(parseTriggerValue("stepfun/step-3.7-flash:free · 思考")).toEqual({
      model: "stepfun/step-3.7-flash:free",
    });
  });

  it("无分隔符时整串即模型名（模型名本身含空格，不能按空格切）", () => {
    expect(parseTriggerValue("K3")).toEqual({ model: "K3" });
    expect(parseTriggerValue("K2.8 Preview")).toEqual({ model: "K2.8 Preview" });
    expect(parseTriggerValue("")).toEqual({ model: "" });
  });
});

describe("Kimi Code 档位集合归类", () => {
  it("含 max 且含 low/high → official（按规范顺序输出）", () => {
    expect(tierSetOf(["Low", "High", "Max"])).toEqual({
      tiers: ["low", "high", "max"],
      kind: "official",
    });
    expect(tierSetOf(["Max", "High"])).toEqual({ tiers: ["high", "max"], kind: "official" });
    expect(tierSetOf(["低", "高", "Max"]).kind).toBe("official");
  });

  it("含 on 且含 off → onoff", () => {
    expect(tierSetOf(["On", "Off"])).toEqual({ tiers: ["on", "off"], kind: "onoff" });
    expect(tierSetOf(["on"]).kind).toBe("unknown");
  });

  it("读不到可识别档位 → unknown（fail-closed 的依据）", () => {
    expect(tierSetOf([])).toEqual({ tiers: [], kind: "unknown" });
    expect(tierSetOf(["思考"]).kind).toBe("unknown");
  });
});

describe("Kimi Code 档位校验", () => {
  it("官方模型收到「中」：报错并写明支持的档位与收到的值", () => {
    const spec = parseKimicodeModel("K3", "中");
    expect(() => assertLevelSupported(spec, tierSetOf(["Low", "High", "Max"]))).toThrow(
      "模型 K3 的思考等级仅支持 Low/High/Max，收到「中」（medium）",
    );
  });

  it("非官方模型收到「高」：报错并写明 On/Off", () => {
    const spec = parseKimicodeModel("stepfun/step-3.7-flash:free", "高");
    expect(() => assertLevelSupported(spec, tierSetOf(["On", "Off"]))).toThrow(
      "模型 stepfun/step-3.7-flash:free 的思考等级仅支持 On/Off，收到「高」（high）",
    );
  });

  it("合法组合通过：官方收 max、非官方收 on、省略时也通过", () => {
    expect(() =>
      assertLevelSupported(parseKimicodeModel("K3", "max"), tierSetOf(["Low", "High", "Max"])),
    ).not.toThrow();
    expect(() =>
      assertLevelSupported(
        parseKimicodeModel("stepfun/step-3.7-flash:free", "on"),
        tierSetOf(["On", "Off"]),
      ),
    ).not.toThrow();
    expect(() =>
      assertLevelSupported(parseKimicodeModel("K3", undefined), tierSetOf(["Low", "High", "Max"])),
    ).not.toThrow();
  });

  it("档位集合读不到时一律 fail-closed，不按内置名单猜测", () => {
    expect(() =>
      assertLevelSupported(parseKimicodeModel("K3", undefined), tierSetOf([])),
    ).toThrow(/无法从界面读到模型 K3 的思考档位标签/);
  });

  it("函数式调用方无界面状态时只能报取值错误", () => {
    expect(describeLevelValueError(parseKimicodeModel("K3", "中"))).toMatch(/不支持「中」（medium）/);
    expect(describeLevelValueError(parseKimicodeModel("K3", "high"))).toBeUndefined();
  });
});

describe("Kimi Code 省略档位时的默认策略", () => {
  it("官方模型沿用界面当前值（返回 undefined 表示不切换）", () => {
    expect(defaultLevelFor("official", "low")).toBeUndefined();
    expect(defaultLevelFor("official")).toBeUndefined();
  });

  it("非官方模型强制 on，已是 on 时不再切换", () => {
    expect(defaultLevelFor("onoff", "off")).toBe("on");
    expect(defaultLevelFor("onoff")).toBe("on");
    expect(defaultLevelFor("onoff", "on")).toBeUndefined();
  });
});

describe("Kimi Code 模型名精确比较", () => {
  it("K3 与 K3-256k 必须区分（前缀命中会跳过切换）", () => {
    expect(exactUiName("K3", "K3-256k")).toBe(false);
    expect(exactUiName("K3-256k", "K3")).toBe(false);
    expect(exactUiName("ｋ３", "K3")).toBe(true);
    expect(exactUiName("K2.8  Preview", "K2.8 Preview")).toBe(true);
    expect(exactUiName("stepfun/step-3.7-flash:free", "stepfun/step-3.7-flash:free")).toBe(true);
  });

  it("model 必填", () => {
    expect(() => parseKimicodeModel(undefined, undefined)).toThrow(
      "Kimi Code 必须指定 model（如「K3」）",
    );
    expect(() => parseKimicodeModel("  ", undefined)).toThrow("Kimi Code 必须指定 model");
    expect(parseKimicodeModel(" K3 ", "Max")).toEqual({ model: "K3", level: "max" });
  });
});