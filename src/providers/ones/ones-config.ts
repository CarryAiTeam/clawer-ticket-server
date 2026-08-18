import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import * as z from "zod/v4";
import { TicketClass } from "../../modules/tickets/domain/ticket.js";
import { TicketError } from "../../modules/tickets/domain/ticket-error.js";
import { DEFAULT_TICKET_EXPORT_LIMITS, MAX_TICKET_EXPORT_ITEMS } from "../../modules/tickets/domain/ticket-export.js";

const classificationRuleSchema = z.object({
  name: z.string().min(1),
  field: z.enum(["issueType", "subIssueType", "importantField"]),
  equals: z.string().min(1),
  class: z.enum(["bugfix", "feature", "technical-change"]),
  fieldId: z.string().min(1).optional(),
}).strict();

const profileSchema = z.object({
  /** provider 只能由受控 profile 选择，不能由工具参数指定。 */
  provider: z.literal("ones").default("ones"),
  source: z.enum(["graphql", "browser"]),
  product: z.literal("project"),
  baseUrl: z.url(),
  teamId: z.string().min(1),
  allowedHosts: z.array(z.string().min(1)).min(1),
  allowedProjects: z.array(z.string().min(1)).default([]),
  /** 保存已批准只读机器凭据的环境变量或密钥存储条目名称。 */
  secretRef: z.string().min(1).optional(),
  authentication: z
    .object({
      headerName: z.literal("Authorization").default("Authorization"),
      scheme: z.enum(["Bearer", "raw"]).default("Bearer"),
    })
    .default({ headerName: "Authorization", scheme: "Bearer" }),
  requestBudget: z
    .object({ maxConcurrent: z.number().int().min(1).max(3).default(3), maxRequestsPerMinute: z.number().int().min(1).max(120).default(20) })
    .default({ maxConcurrent: 3, maxRequestsPerMinute: 20 }),
  inlineMaxChars: z.number().int().min(1_000).max(100_000).default(12_000),
  classificationRules: z.array(classificationRuleSchema).default([]),
  browser: z.object({
    executablePath: z.string().min(1).optional(),
    /** 可选直登凭据，只能存放于本地且被 Git 忽略的配置文件。 */
    autoLogin: z.object({
      email: z.string().email(),
      password: z.string().min(1),
      /** 可选直登页；未设置时由 profile.baseUrl 推导为 /login。 */
      loginUrl: z.url().optional(),
    }).strict().optional(),
  }).strict().optional(),
}).strict().superRefine((profile, context) => {
  if (profile.source === "graphql" && !profile.secretRef) {
    context.addIssue({ code: "custom", path: ["secretRef"], message: "secretRef is required for graphql profiles" });
  }
  if (profile.source !== "browser" && profile.browser?.autoLogin) {
    context.addIssue({ code: "custom", path: ["browser", "autoLogin"], message: "browser.autoLogin is only valid for browser profiles" });
  }
});

const exportLimitsSchema = z.object({
  /** 无需再次确认即可直接写入的查询选择数量。 */
  autoDownloadThreshold: z.number().int().min(1).max(MAX_TICKET_EXPORT_ITEMS).default(DEFAULT_TICKET_EXPORT_LIMITS.autoDownloadThreshold),
  /** 同步查询导出的硬上限；配置不得提高到 2,000 以上。 */
  maxItems: z.number().int().min(1).max(MAX_TICKET_EXPORT_ITEMS).default(DEFAULT_TICKET_EXPORT_LIMITS.maxItems),
  maxAttachments: z.number().int().min(1).max(100_000).default(DEFAULT_TICKET_EXPORT_LIMITS.maxAttachments),
  maxAttachmentBytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_TICKET_EXPORT_LIMITS.maxAttachmentBytes),
  maxTotalBytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_TICKET_EXPORT_LIMITS.maxTotalBytes),
}).strict().superRefine((limits, context) => {
  if (limits.autoDownloadThreshold > limits.maxItems) {
    context.addIssue({ code: "custom", path: ["autoDownloadThreshold"], message: "autoDownloadThreshold cannot exceed maxItems" });
  }
  if (limits.maxAttachmentBytes > limits.maxTotalBytes) {
    context.addIssue({ code: "custom", path: ["maxAttachmentBytes"], message: "maxAttachmentBytes cannot exceed maxTotalBytes" });
  }
});

const configSchema = z.object({
  schemaVersion: z.literal("1.0"),
  storage: z.object({
    root: z.string().min(1),
    retainRawSource: z.literal(false).default(false),
    redaction: z
      .object({ omitPeople: z.boolean().default(false), removeFields: z.array(z.string()).default(["phone", "email"]) })
      .default({ omitPeople: false, removeFields: ["phone", "email"] }),
    exportLimits: exportLimitsSchema.default({ ...DEFAULT_TICKET_EXPORT_LIMITS }),
  }).strict(),
  profiles: z.record(z.string().min(1), profileSchema).refine((profiles) => Object.keys(profiles).length > 0, "At least one profile is required"),
}).strict();

export type OnesProfile = z.infer<typeof profileSchema>;
export type OnesConfig = z.infer<typeof configSchema>;
export type ClassificationRule = { name: string; field: "issueType" | "subIssueType" | "importantField"; equals: string; class: TicketClass; fieldId?: string };

/** 校验并补全受控 ONES 配置，同时检查所有 URL host allowlist。 */
export function parseConfig(parsed: unknown): OnesConfig {
  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    throw new TicketError("CONFIG_INVALID", `Invalid configuration: ${result.error.issues.map((issue) => issue.path.join(".")).join(", ")}`);
  }
  for (const profile of Object.values(result.data.profiles)) {
    const host = new URL(profile.baseUrl).host;
    if (!profile.allowedHosts.includes(host)) {
      throw new TicketError("CONFIG_INVALID", `baseUrl host ${host} is not in allowedHosts`);
    }
    if (profile.browser?.autoLogin?.loginUrl && !profile.allowedHosts.includes(new URL(profile.browser.autoLogin.loginUrl).host)) {
      throw new TicketError("CONFIG_INVALID", "browser.autoLogin.loginUrl host is not in allowedHosts");
    }
  }
  return result.data;
}

/** 从配置文件读取 JSON，并统一转换配置读取或校验错误。 */
export async function loadConfig(
  configPath = process.env.CLAWER_TICKET_CONFIG_PATH ?? process.env.ONES_MCP_CONFIG_PATH ?? "clawer-ticket.config.json",
): Promise<OnesConfig> {
  const absolutePath = resolve(configPath);
  try {
    return parseConfig(JSON.parse(await readFile(absolutePath, "utf8")) as unknown);
  } catch (error) {
    if (error instanceof TicketError) throw error;
    throw new TicketError("CONFIG_INVALID", `Unable to read configuration at ${absolutePath}: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

/** 按 profile 名称读取已通过校验的 ONES 配置。 */
export function getProfile(config: OnesConfig, name: string): OnesProfile {
  const profile = config.profiles[name];
  if (!profile) throw new TicketError("PROFILE_NOT_FOUND", `Profile ${name} was not found`);
  return profile;
}
