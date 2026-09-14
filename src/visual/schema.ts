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
  })
  .strict()
  .superRefine((v, ctx) => {
    const issue = (message: string): void => ctx.addIssue({ code: "custom", message });
    if (v.enabled && !v.pages.length && !v.images.length)
      issue("Enabled visual configuration requires pages or images");
    for (const list of [v.viewports, [...v.pages, ...v.images]]) {
      if (new Set(list.map((x) => x.id.toLowerCase())).size !== list.length)
        issue("Duplicate IDs (case insensitive)");
    }
    if (v.defaults.capture === "element" && !v.defaults.selector)
      issue("Default element capture requires selector");
    for (const p of v.pages) {
      if ((p.capture ?? v.defaults.capture) === "element" && !(p.selector ?? v.defaults.selector))
        issue(`${p.id}: element capture requires selector`);
      if (p.viewports?.some((x) => !v.viewports.some((vp) => vp.id === x)))
        issue(`${p.id}: unknown viewport`);
      if (p.viewports && new Set(p.viewports).size !== p.viewports.length)
        issue(`${p.id}: duplicate viewport`);
    }
  });
export type VisualConfig = z.infer<typeof VisualConfigSchema>;
export type VisualPage = z.infer<typeof PageSchema>;
export type VisualImage = z.infer<typeof ImageSchema>;
export type VisualViewport = z.infer<typeof ViewportSchema>;
