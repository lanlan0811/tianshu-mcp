import { z } from "zod";
import { VISUAL_DEFAULTS as D } from "./defaults.js";

const id = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)
  .max(100)
  .refine((v) => !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(v), "ID is a reserved Windows filename");
export const projectRelativePath = z
  .string()
  .min(1)
  .refine(
    (p) => !/^(?:[A-Za-z]:|[\\/])/.test(p) && !p.split(/[\\/]/).includes("..") && !p.includes("\0"),
    "Expected a project-relative path without traversal",
  );
export function isLocalUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return (
      ["http:", "https:"].includes(u.protocol) &&
      ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) &&
      !u.username &&
      !u.password
    );
  } catch {
    return false;
  }
}
const localUrl = z.string().url().refine(isLocalUrl, "Expected a local HTTP/HTTPS URL");
const origin = z
  .string()
  .url()
  .refine((v) => {
    const u = new URL(v);
    return ["http:", "https:", "ws:", "wss:"].includes(u.protocol) && u.origin === v;
  }, "Expected an exact origin without path or credentials");
const positive = z.number().finite().positive();
const integer = positive.int();
const ratio = z.number().finite().min(0).max(1);
const selector = z.string().min(1);
const range = z
  .object({ exact: positive.optional(), min: positive.optional(), max: positive.optional() })
  .strict()
  .superRefine((v, ctx) => {
    if (v.exact === undefined && v.min === undefined && v.max === undefined)
      ctx.addIssue({ code: "custom", message: "Empty range" });
    if (v.exact !== undefined && (v.min !== undefined || v.max !== undefined))
      ctx.addIssue({ code: "custom", message: "exact conflicts with min/max" });
    if (v.min !== undefined && v.max !== undefined && v.min > v.max)
      ctx.addIssue({ code: "custom", message: "min exceeds max" });
  });
export const ViewportSchema = z
  .object({
    id,
    width: integer,
    height: integer,
    deviceScaleFactor: positive.max(4).default(1),
  })
  .strict();
const capture = z.enum(["viewport", "fullPage", "element"]);
export const BrowserSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("managed") }).strict(),
  z.object({ mode: z.literal("chrome"), executablePath: z.string().min(1).optional() }).strict(),
  z.object({ mode: z.literal("edge"), executablePath: z.string().min(1).optional() }).strict(),
  z.object({ mode: z.literal("executable"), executablePath: z.string().min(1) }).strict(),
]);
export const SourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("existing"), url: localUrl }).strict(),
  z
    .object({
      type: z.literal("static"),
      root: projectRelativePath,
      port: integer.max(65535).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("command"),
      command: z.string().min(1),
      args: z.array(z.string()).default([]),
      cwd: projectRelativePath.default("."),
      env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).default({}),
      readyUrl: localUrl,
    })
    .strict(),
]);
export const StepSchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("click"), selector }).strict(),
    z.object({ type: z.literal("input"), selector, value: z.string() }).strict(),
    z.object({ type: z.literal("hover"), selector }).strict(),
    z
      .object({
        type: z.literal("scroll"),
        selector: selector.optional(),
        x: z.number().finite().optional(),
        y: z.number().finite().optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("wait"),
        selector: selector.optional(),
        state: z.enum(["visible", "hidden"]).optional(),
        url: localUrl.optional(),
        durationMs: integer.max(D.limits.itemTimeoutMs).optional(),
      })
      .strict(),
  ])
  .superRefine((v, ctx) => {
    if (
      v.type === "scroll" &&
      (v.selector ? v.x !== undefined || v.y !== undefined : v.x === undefined && v.y === undefined)
    )
      ctx.addIssue({ code: "custom", message: "scroll requires either selector or coordinates" });
    if (
      v.type === "wait" &&
      (Number(v.selector !== undefined) +
        Number(v.url !== undefined) +
        Number(v.durationMs !== undefined) !==
        1 ||
        (v.state && !v.selector))
    )
      ctx.addIssue({
        code: "custom",
        message: "wait requires exactly one condition; state requires selector",
      });
  });
/**
 * AI 内容校验（issue #13 / #3 可选扩展）：
 * 判定完全委托用户自备命令（凭证零管理红线），MCP 只做契约层校验。
 */
/** 命令 stdout 末行必须输出的判定 JSON 契约 */
export const ContentVerdictSchema = z
  .object({
    passed: z.boolean(),
    confidence: ratio.optional(),
    reason: z.string().min(1),
  })
  .strict();
const envReference = z.record(
  z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  z.string().min(1),
);
/** 占位符白名单：argsTemplate 中形如 <...> 的 token 只允许这三个 */
export const CONTENT_PLACEHOLDERS = ["<image:path>", "<expect:file>", "<image:base64:file>"] as const;
/** 页面/规则共用的内容检查声明（pages[].content 与 contents[] 条目） */
export const ContentCheckSchema = z
  .object({
    expect: z.string().min(1).max(4000),
    /** blocking=false（默认）映射为 VisualResult.optional=true：仅告警，不构成门禁 */
    blocking: z.boolean().default(false),
    samples: z.number().int().min(1).max(9).optional(),
    allowRemote: z.boolean().optional(),
    command: z.string().min(1).optional(),
    argsTemplate: z.array(z.string().min(1)).min(1).optional(),
    cwd: projectRelativePath.optional(),
    env: envReference.optional(),
  })
  .strict();
export const PageSchema = z
  .object({
    id,
    optional: z.boolean().default(false),
    source: SourceSchema,
    route: z
      .string()
      .default("/")
      .refine(
        (v) => v.startsWith("/") && !v.startsWith("//") && !v.includes("\\"),
        "Expected a local route",
      ),
    viewports: z.array(id).min(1).optional(),
    capture: capture.optional(),
    selector: selector.optional(),
    readySelector: selector.optional(),
    maskSelectors: z.array(selector).default([]),
    steps: z.array(StepSchema).default([]),
    storageState: projectRelativePath.optional(),
    baseline: projectRelativePath.refine((p) => /\.png$/i.test(p), "Baseline must use .png").optional(),
    pixelThreshold: ratio.optional(),
    maxDiffRatio: ratio.optional(),
    /** pixel=false 表示语义-only 页面：跳过像素对比与基准要求（必须有 content，否则 schema 拒绝） */
    pixel: z.boolean().default(true),
    /** 页面级内容校验：与像素维度平行，复用同一次截图 */
    content: ContentCheckSchema.optional(),
  })
  .strict();
export const ImageSchema = z
  .object({
    id,
    optional: z.boolean().default(false),
    files: z.array(projectRelativePath).min(1).refine((files) => new Set(files.map((f) => f.replaceAll("\\", "/").toLowerCase())).size === files.length, "Duplicate image files"),
    formats: z
      .array(z.enum(["png", "jpeg", "webp"]))
      .min(1)
      .optional(),
    width: range.optional(),
    height: range.optional(),
    aspectRatio: range.optional(),
    fileSizeBytes: range.optional(),
    dpi: range.optional(),
    transparency: z.enum(["transparent", "opaque"]).optional(),
  })
  .strict();
export const ContentRuleSchema = ContentCheckSchema.extend({
  id,
  files: z
    .array(projectRelativePath)
    .min(1)
    .refine(
      (files) =>
        new Set(files.map((f) => f.replaceAll("\\", "/").toLowerCase())).size === files.length,
      "Duplicate content files",
    ),
});
/** visual.content 全局块：命令与预算等声明，逐规则可覆盖 command/argsTemplate/cwd/env/samples/allowRemote */
const ContentConfigSchema = z
  .object({
    enabled: z.boolean().default(D.content.enabled),
    command: z.string().min(1).optional(),
    argsTemplate: z.array(z.string().min(1)).min(1).optional(),
    cwd: projectRelativePath.optional(),
    env: envReference.optional(),
    /** 默认禁止外发：未放行的规则禁止使用字节外传占位符（schema 层拒绝） */
    allowRemote: z.boolean().default(D.content.allowRemote),
    samples: z.number().int().min(1).max(9).default(D.content.samples),
    /** 单项命令超时（仅全局配置）。约束：samples × timeoutMs ≤ limits.roundTimeoutMs */
    timeoutMs: integer.default(D.content.timeoutMs),
    /** 省略即关闭置信度闸门（对不输出置信度的命令设默认值会一律误判不确定） */
    minConfidence: ratio.optional(),
    cache: z.boolean().default(D.content.cache),
  })
  .strict()
  .default({});
export const VisualConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    browser: BrowserSchema.default({ mode: "managed" }),
    baselineRoot: projectRelativePath.default(D.baselineRoot),
    viewports: z.array(ViewportSchema).min(1).default(D.viewports),
    defaults: z
      .object({
        capture: capture.default(D.capture),
        selector: selector.optional(),
        pixelThreshold: ratio.default(D.pixelThreshold),
        maxDiffRatio: ratio.default(D.maxDiffRatio),
        locale: z.string().min(1).refine((value) => { try { new Intl.Locale(value); return true; } catch { return false; } }, "Invalid locale").default(D.locale),
        timezone: z.string().min(1).refine((value) => { try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; } }, "Invalid timezone").default(D.timezone),
        colorScheme: z.enum(["light", "dark", "no-preference"]).default(D.colorScheme),
      })
      .strict()
      .default({}),
    limits: z
      .object({
        concurrency: integer.max(4).default(D.limits.concurrency),
        serviceTimeoutMs: integer.default(D.limits.serviceTimeoutMs),
        navigationTimeoutMs: integer.default(D.limits.navigationTimeoutMs),
        itemTimeoutMs: integer.default(D.limits.itemTimeoutMs),
        roundTimeoutMs: integer.default(D.limits.roundTimeoutMs),
        stabilitySamples: integer.min(2).max(3).default(D.limits.stabilitySamples),
        inputBytes: integer.default(D.limits.inputBytes),
        decodedPixels: integer.default(D.limits.decodedPixels),
        artifactBytes: integer.default(D.limits.artifactBytes),
      })
      .strict()
      .default({}),
    allowedOrigins: z.array(origin).default([]),
    pages: z.array(PageSchema).default([]),
    images: z.array(ImageSchema).default([]),
    content: ContentConfigSchema,
    contents: z.array(ContentRuleSchema).default([]),
  })
  .strict()
  .superRefine((v, ctx) => {
    const issue = (message: string): void => ctx.addIssue({ code: "custom", message });
    if (v.enabled && !v.pages.length && !v.images.length && !v.contents.length)
      issue("Enabled visual configuration requires pages, images or contents");
    const contentChecks: { label: string; check: z.infer<typeof ContentCheckSchema> }[] = [
      ...v.contents.map((rule) => ({ label: rule.id, check: rule as z.infer<typeof ContentCheckSchema> })),
      ...v.pages
        .filter((page) => page.content)
        .map((page) => ({ label: `${page.id} (page content)`, check: page.content! })),
    ];
    // 声明了内容规则却未启用 → 拒绝（禁止「声明了规则却静默不跑」）
    if (contentChecks.length && v.content.enabled !== true)
      issue("Content rules require visual.content.enabled = true");
    // 占位符白名单（全局与逐规则模板都校验）
    const templates: [string, string[]][] = [
      ...(v.content.argsTemplate ? [["content", v.content.argsTemplate] as [string, string[]]] : []),
      ...contentChecks
        .filter(({ check }) => check.argsTemplate)
        .map(({ label, check }) => [label, check.argsTemplate!] as [string, string[]]),
    ];
    for (const [label, template] of templates)
      for (const token of template)
        for (const match of token.matchAll(/<[^<>\s]*>/g))
          if (!(CONTENT_PLACEHOLDERS as readonly string[]).includes(match[0]))
            issue(`${label}: unknown placeholder ${match[0]}`);
    if (v.content.enabled && contentChecks.length)
      for (const { label, check } of contentChecks) {
        const command = check.command ?? v.content.command;
        const argsTemplate = check.argsTemplate ?? v.content.argsTemplate;
        if (!command || !argsTemplate)
          issue(`${label}: content checks require command and argsTemplate`);
        // 外发闸门：字节外传占位符必须逐规则显式放行
        const allowRemote = check.allowRemote ?? v.content.allowRemote;
        if (argsTemplate?.some((token) => token.includes("<image:base64:file>")) && allowRemote !== true)
          issue(`${label}: <image:base64:file> requires allowRemote = true`);
        // 预算自洽：roundTimeoutMs 是硬总闸，超预算配置必然整轮 ROUND_TIMEOUT，必须在配置期拦截
        const samples = check.samples ?? v.content.samples;
        if (samples * v.content.timeoutMs > v.limits.roundTimeoutMs)
          issue(
            `${label}: samples (${samples}) x timeoutMs (${v.content.timeoutMs}ms) exceeds limits.roundTimeoutMs (${v.limits.roundTimeoutMs}ms)`,
          );
      }
    for (const list of [v.viewports, [...v.pages, ...v.images, ...v.contents]]) {
      if (new Set(list.map((x) => x.id.toLowerCase())).size !== list.length)
        issue("Duplicate IDs (case insensitive)");
    }
    // 派生 id（页面内容项 `${page.id}-content`）与全部已声明 id 的大小写不敏感冲突
    const declaredIds = [
      ...v.viewports.map((x) => x.id.toLowerCase()),
      ...v.pages.map((page) => page.id.toLowerCase()),
      ...v.images.map((image) => image.id.toLowerCase()),
      ...v.contents.map((rule) => rule.id.toLowerCase()),
    ];
    const derivedIds = v.pages
      .filter((page) => page.content)
      .map((page) => `${page.id}-content`.toLowerCase());
    if (
      derivedIds.some(
        (derived) => declaredIds.includes(derived) || derivedIds.indexOf(derived) !== derivedIds.lastIndexOf(derived),
      )
    )
      issue("Derived content ID collides with a declared ID (case insensitive)");
    if (v.defaults.capture === "element" && !v.defaults.selector)
      issue("Default element capture requires selector");
    for (const p of v.pages) {
      if ((p.capture ?? v.defaults.capture) === "element" && !(p.selector ?? v.defaults.selector))
        issue(`${p.id}: element capture requires selector`);
      if (p.viewports?.some((x) => !v.viewports.some((vp) => vp.id === x)))
        issue(`${p.id}: unknown viewport`);
      if (p.viewports && new Set(p.viewports).size !== p.viewports.length)
        issue(`${p.id}: duplicate viewport`);
      if (!p.pixel && !p.content) issue(`${p.id}: pixel=false requires content`);
      if (
        !p.pixel &&
        (p.baseline !== undefined || p.pixelThreshold !== undefined || p.maxDiffRatio !== undefined)
      )
        issue(`${p.id}: pixel=false conflicts with baseline/pixelThreshold/maxDiffRatio`);
    }
  });
export type VisualConfig = z.infer<typeof VisualConfigSchema>;
export type VisualPage = z.infer<typeof PageSchema>;
export type VisualImage = z.infer<typeof ImageSchema>;
export type VisualViewport = z.infer<typeof ViewportSchema>;
export type VisualContentCheck = z.infer<typeof ContentCheckSchema>;
export type VisualContentRule = z.infer<typeof ContentRuleSchema>;
export type VisualContentVerdict = z.infer<typeof ContentVerdictSchema>;
