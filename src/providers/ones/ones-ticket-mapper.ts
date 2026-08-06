import { ClassificationRule, OnesProfile } from "./ones-config.js";
import { CanonicalTicket, Person, TicketAttachment, TicketClass, TicketComment, TicketInlineImage, TicketIteration, TicketRelation } from "../../modules/tickets/domain/ticket.js";
import { TicketError } from "../../modules/tickets/domain/ticket-error.js";
import { OnesRawTicketData } from "./ones-contracts.js";

type UnknownRecord = Record<string, unknown>;
const asRecord = (value: unknown): UnknownRecord => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as UnknownRecord) : {});
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);

/** 将 ONES 人员对象映射为领域层的最小人员信息。 */
function toPerson(value: unknown): Person | undefined {
  if (typeof value === "string" && value.trim()) return { id: value.trim() };
  const item = asRecord(value);
  const displayName = text(item.name) ?? text(item.displayName);
  const id = text(item.uuid) ?? text(item.id);
  return displayName || id ? { ...(id ? { id } : {}), ...(displayName ? { displayName } : {}) } : undefined;
}

/** 解码 ONES 富文本中常见的 HTML 实体。 */
function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

/** 从 HTML 属性字符串中安全读取指定属性值。 */
function htmlAttribute(attributes: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(attributes);
  return decodeHtml(match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim() || undefined;
}

/** 仅从 ONES 富文本中提取稳定且不含敏感信息的图片标识。 */
function imagesInHtml(value: string | undefined): TicketInlineImage[] {
  if (!value) return [];
  return [...value.matchAll(/<img\b([^>]*)>/gi)].flatMap((match) => {
    const attributes = match[1] ?? "";
    const attachmentId = htmlAttribute(attributes, "data-uuid")
      ?? htmlAttribute(attributes, "data-ref-id")
      ?? htmlAttribute(attributes, "data-resource-id")
      ?? htmlAttribute(attributes, "data-attachment-id");
    const source = htmlAttribute(attributes, "src");
    let hash: string | undefined;
    try {
      const path = new URL(source ?? "https://invalid.example.test").pathname;
      hash = /^\/api\/project\/file\/attachment\/([^/]+)$/i.exec(path)?.[1];
    } catch {
      // 来源 URL 不会离开此解析边界。
    }
    const image: TicketInlineImage = {
      ...(attachmentId ? { attachmentId } : {}),
      ...(hash ? { hash } : {}),
      ...(htmlAttribute(attributes, "alt") ? { alt: htmlAttribute(attributes, "alt") } : {}),
      ...(htmlAttribute(attributes, "data-mime") ? { mediaType: htmlAttribute(attributes, "data-mime") } : {}),
      ...(htmlAttribute(attributes, "data-size") ? { sizeHint: htmlAttribute(attributes, "data-size") } : {}),
    };
    return Object.keys(image).length > 0 ? [image] : [];
  });
}

/** 清理链接中的凭据、查询参数和不安全协议，只保留可展示的 HTTP(S) 链接。 */
function safeLink(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
    // 评论链接可保留上下文，但凭据和跟踪查询参数不能保留。
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return undefined;
  }
}

/** 从富文本保留可读链接和图片 alt 文本，同时移除可执行 HTML 与远程资源。 */
function stripHtml(value: string): string {
  const withLinks = value
    .replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_match, attributes: string, label: string) => {
      const display = decodeHtml(label.replace(/<[^>]*>/g, "")).trim() || "link";
      const href = htmlAttribute(attributes, "href");
      const target = href ? safeLink(href) : undefined;
      return target ? `${display} (${target})` : display;
    })
    .replace(/<img\b([^>]*)>/gi, (_match, attributes: string) => `[image: ${htmlAttribute(attributes, "alt") ?? "image"}]`)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|h[1-6])\s*>/gi, "\n");
  return decodeHtml(withLinks.replace(/<[^>]*>/g, "")).replace(/\n{3,}/g, "\n\n").trim();
}

/** 从 ONES 消息对象提取正文及其来源格式。 */
function findBody(message: UnknownRecord): { body: string; sourceFormat: TicketComment["sourceFormat"]; images: TicketInlineImage[] } {
  // ONES 的详情页讨论消息使用顶层 rich_text/text；旧版消息才使用 content/body 或 ext.content。
  const direct = text(message.rich_text) ?? text(message.content) ?? text(message.body) ?? text(message.message) ?? text(message.text);
  if (direct) return { body: stripHtml(direct), sourceFormat: /<[^>]+>/.test(direct) ? "rich-text" : "plain", images: imagesInHtml(direct) };
  const ext = asRecord(message.ext);
  const fromExt = text(ext.rich_text) ?? text(ext.content) ?? text(ext.body) ?? text(ext.message) ?? text(ext.text);
  if (fromExt) return { body: stripHtml(fromExt), sourceFormat: /<[^>]+>/.test(fromExt) ? "rich-text" : "plain", images: imagesInHtml(fromExt) };
  const resource = asRecord(message.resource ?? message.file ?? message.attachment);
  const resourceId = text(resource.uuid) ?? text(resource.id);
  if (resourceId) {
    const name = text(resource.name) ?? text(resource.filename) ?? resourceId;
    const mediaType = text(resource.mime) ?? text(resource.mimeType) ?? text(resource.contentType);
    if (mediaType?.toLowerCase().startsWith("image/")) {
      return {
        body: `[image: ${name}]`,
        sourceFormat: "rich-text",
        images: [{ attachmentId: resourceId, alt: name, mediaType, ...(typeof resource.size === "number" ? { sizeHint: String(resource.size) } : {}) }],
      };
    }
    return { body: `attachment: ${name}`, sourceFormat: "plain", images: [] };
  }
  return { body: text(message.action) ?? "comment", sourceFormat: "activity", images: [] };
}

/** 将 ONES 消息流转换为真实评论；创建、更新等系统动态不导出。 */
function normalizeMessages(raw: unknown): TicketComment[] {
  const root = asRecord(raw);
  const data = asRecord(root.data);
  const source = Array.isArray(raw) ? raw : root.messages ?? data.messages ?? root.items ?? data.items;
  const messages = Array.isArray(source) ? source : asArray(asRecord(source).messages ?? asRecord(source).items);
  return messages.flatMap((entry, index) => {
    const message = asRecord(entry);
    const type = (text(message.type) ?? text(message.action))?.toLowerCase();
    if (!(type?.includes("comment") || type === "discussion" || type === "resource")) return [];
    const body = findBody(message);
    const from = toPerson(message.from) ?? toPerson(message.from_user);
    const displayName = text(message.from_name) ?? text(message.fromName);
    const author = from || displayName ? { ...(from ?? {}), ...(displayName ? { displayName } : {}) } : undefined;
    return [{
      id: text(message.uuid) ?? `message-${index}`,
      ...(author ? { author } : {}),
      bodyMarkdown: body.body,
      createdAt: text(message.send_time) ?? text(message.sendTime) ?? text(message.createdAt) ?? text(message.create_time),
      sourceFormat: body.sourceFormat,
      kind: "comment",
      ...(body.images.length > 0 ? { images: body.images } : {}),
    }];
  });
}

/** 将附件元数据去重并转换为通用附件描述符。 */
function normalizeAttachments(detail: UnknownRecord, raw: unknown): TicketAttachment[] {
  const entries = [...asArray(asRecord(raw).attachments), ...asArray(detail.attachments)];
  const seen = new Set<string>();
  return entries.flatMap((entry, index) => {
    const item = asRecord(entry);
    const id = text(item.uuid) ?? `attachment-${index}`;
    if (seen.has(id)) return [];
    seen.add(id);
    return [{
      id,
      name: text(item.name) ?? id,
      mediaType: text(item.mime),
      sizeBytes: typeof item.size === "number" ? item.size : undefined,
      hash: text(item.hash),
    }];
  });
}

/** 将父子任务、关联任务和链接转换为通用关系。 */
function normalizeRelations(detail: UnknownRecord): TicketRelation[] {
  const relations: TicketRelation[] = [];
  const parent = asRecord(detail.parent);
  const parentId = text(parent.uuid);
  if (parentId) relations.push({ type: "parent", targetId: parentId, targetKey: text(parent.key), title: text(parent.name) });
  for (const childRaw of asArray(detail.subTasks)) {
    const child = asRecord(childRaw);
    const id = text(child.uuid);
    if (id) relations.push({ type: "child", targetId: id, targetKey: text(child.key), title: text(child.name) });
  }
  for (const relatedRaw of [...asArray(detail.relatedTasks), ...asArray(detail.links)]) {
    const related = asRecord(relatedRaw);
    const id = text(related.uuid) ?? text(related.taskUUID) ?? text(related.id);
    if (id) relations.push({ type: "related", targetId: id, targetKey: text(related.key), title: text(related.name) });
  }
  return relations;
}

/** 将 ONES sprint 映射为领域迭代对象。 */
function normalizeIteration(detail: UnknownRecord): TicketIteration | undefined {
  const sprint = asRecord(detail.sprint);
  const id = text(sprint.uuid);
  const name = text(sprint.name);
  if (!id || !name) return undefined;
  return {
    id,
    name,
    ...(text(sprint.planStartTime) ? { plannedStartAt: text(sprint.planStartTime) } : {}),
    ...(text(sprint.planEndTime) ? { plannedEndAt: text(sprint.planEndTime) } : {}),
  };
}

/** 按分类规则从 ONES 字段中提取待比较的源值。 */
function sourceValueFor(rule: ClassificationRule, detail: UnknownRecord, fields: Array<{ id: string; name?: string; value?: string }>): string | undefined {
  if (rule.field === "issueType") return text(asRecord(detail.issueType).name);
  if (rule.field === "subIssueType") return text(asRecord(detail.subIssueType).name);
  return fields.find((field) => field.id === rule.fieldId)?.value;
}

/** 按 profile 规则对工单进行 bug、feature 或技术变更分类。 */
function classify(rules: ClassificationRule[], detail: UnknownRecord, fields: Array<{ id: string; name?: string; value?: string }>): CanonicalTicket["classification"] {
  for (const rule of rules) {
    const sourceValue = sourceValueFor(rule, detail, fields);
    if (sourceValue === rule.equals) return { value: rule.class as TicketClass, matchedRule: rule.name, sourceValue };
  }
  return { value: "unclassified" };
}

/** 将一组原始 ONES 详情、消息和附件归一化为 CanonicalTicket。 */
export function normalizeOnesTicket(profile: OnesProfile, raw: OnesRawTicketData, fetchedAt = new Date().toISOString()): CanonicalTicket {
  const detail = asRecord(raw.detail);
  const id = text(detail.uuid);
  if (!id) throw new TicketError("SOURCE_SCHEMA_CHANGED", "Detail contract is missing task.uuid");
  const importantFields = asArray(detail.importantField).flatMap((entry) => {
    const field = asRecord(entry);
    const fieldId = text(field.fieldUUID);
    return fieldId ? [{ id: fieldId, name: text(field.name), value: text(field.value) }] : [];
  });
  const description = text(detail.description) ?? text(detail.desc_rich) ?? text(detail.descriptionText);
  const status = text(asRecord(detail.status).name);
  const priority = text(asRecord(detail.priority).name) ?? text(asRecord(detail.priority).value) ?? text(detail.priority);
  const project = asRecord(detail.project);
  const projectId = text(project.uuid) ?? text(project.id);
  const projectName = text(project.name);
  const key = text(detail.key);
  const explicitId = importantFields.find((field) => field.name === "ID" && field.value?.trim())?.value?.trim();
  const number = explicitId ?? text(detail.number) ?? (typeof detail.number === "number" ? String(detail.number) : undefined);
  const severity = importantFields.find((field) => field.name === "严重程度")?.value;
  const iteration = normalizeIteration(detail);
  return {
    schemaVersion: "1.0",
    source: {
      provider: "ones",
      product: "project",
      tenantBaseUrl: profile.baseUrl,
      teamId: profile.teamId,
      ...(projectId ? { projectId } : {}),
      ...(projectName ? { projectName } : {}),
      ticketId: id,
      ...(key ? { ticketKey: key } : {}),
      ...(number ? { ticketNumber: number } : {}),
      fetchedAt,
      connector: profile.source,
    },
    classification: classify(profile.classificationRules as ClassificationRule[], detail, importantFields),
    title: text(detail.name) ?? id,
    ...(description ? { descriptionMarkdown: stripHtml(description) } : {}),
    ...(description ? { descriptionImages: imagesInHtml(description) } : {}),
    ...(status ? { status } : {}),
    ...(priority ? { priority } : {}),
    ...(severity ? { severity } : {}),
    ...(iteration ? { iteration } : {}),
    ...(toPerson(detail.assign) ? { assignee: toPerson(detail.assign) } : {}),
    ...(toPerson(detail.owner) ? { reporter: toPerson(detail.owner) } : {}),
    ...(text(detail.createTime) ? { createdAt: text(detail.createTime) } : {}),
    ...(text(detail.serverUpdateStamp) ? { updatedAt: text(detail.serverUpdateStamp) } : {}),
    comments: normalizeMessages(raw.messages),
    attachments: normalizeAttachments(detail, raw.attachments),
    relations: normalizeRelations(detail),
    customFields: importantFields,
  };
}
