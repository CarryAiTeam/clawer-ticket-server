import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { CanonicalTicket, TicketAttachment, TicketInlineImage } from "../../domain/ticket.js";
import { TicketError } from "../../domain/ticket-error.js";
import { ExportFile, ExportPlan, ExportResult, TicketBundleStore, TicketExportWriteSession, TicketMediaPlan } from "../../domain/ports.js";

export type { ExportFile, ExportPlan, ExportResult } from "../../domain/ports.js";

const LAYOUT_VERSION = 3;
const MACHINE_DIRECTORY = "_machine";
const ATTACHMENTS_INDEX_PATH = "attachments/README.md";
const DESCRIPTION_ASSETS_INDEX_PATH = "assets/description/README.md";
const COMMENT_ASSETS_INDEX_PATH = "assets/comments/README.md";

/** 将对象递归序列化为键顺序稳定的 JSON，用于可重复计算内容哈希。 */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** 计算文本内容的 SHA-256 十六进制摘要。 */
function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/** 清理目录片段中的非法字符，防止路径穿越和平台非法文件名。 */
function sanitizedSegment(value: string): string {
  const normalized = value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/^\.+$/, "_").trim();
  return normalized.slice(0, 120) || "unnamed";
}

/** 转义 Markdown 中可解释的字符，确保导出内容按纯文本展示。 */
function markdownPlain(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/([`*_{}\[\]<>#+!|])/g, "\\$1")
    .replace(/\((?=javascript:|data:)/gi, "\\(");
}

/** 提取已规范化富文本中保留的图片 alt 文本；远程地址不会进入导出物。 */
/** 生成稳定、只依赖导出顺序的本地 Markdown 锚点。 */
function resourceAnchor(kind: "attachment" | "description-image" | "comment-image", index: number, imageIndex?: number): string {
  return imageIndex === undefined ? `${kind}-${index + 1}` : `${kind}-${index + 1}-${imageIndex + 1}`;
}

function imageMatchesAttachment(image: TicketInlineImage, attachment: TicketAttachment): boolean {
  return image.attachmentId === attachment.id || Boolean(image.hash && attachment.hash && image.hash === attachment.hash);
}

function isEmbeddedAttachment(ticket: CanonicalTicket, attachment: TicketAttachment): boolean {
  return [
    ...(ticket.descriptionImages ?? []),
    ...ticket.comments.flatMap((comment) => comment.images ?? []),
  ].some((image) => imageMatchesAttachment(image, attachment));
}

function mediaLink(from: string, reference: TicketAttachment | TicketInlineImage, media: TicketMediaPlan[]): string | undefined {
  const path = media.find((item) => "id" in reference
    ? item.attachment.id === reference.id || Boolean(reference.hash && item.attachment.hash && reference.hash === item.attachment.hash)
    : imageMatchesAttachment(reference, item.attachment))?.path;
  return path ? relative(dirname(from), path).replace(/\\/g, "/") : undefined;
}

/** 将正文中可识别的 ONES 附件 URL 替换为已下载文件的相对链接，其他外部链接保持原样。 */
function localizeAttachmentUrls(value: string, ticket: CanonicalTicket, media: TicketMediaPlan[]): string {
  return value.replace(/https?:\/\/[^\s)]+/gi, (url) => {
    try {
      const attachmentKey = /\/attachment\/([^/]+)/i.exec(new URL(url).pathname)?.[1];
      const attachment = attachmentKey ? ticket.attachments.find((item) => item.id === attachmentKey || item.hash === attachmentKey) : undefined;
      const localPath = attachment && mediaLink("ticket.md", attachment, media);
      return localPath ? `[${markdownPlain(attachment.name)}](${localPath})` : url;
    } catch {
      return url;
    }
  });
}

/** 在正文原位置渲染富文本图片，未下载时回退为稳定的本地索引链接。 */
function renderBodyWithInlineImages(
  value: string,
  images: TicketInlineImage[],
  ticket: CanonicalTicket,
  media: TicketMediaPlan[],
  indexPath: string,
  anchorFor: (index: number) => string,
): string {
  const replacements: string[] = [];
  let imageIndex = 0;
  const marked = value.replace(/\[image:\s*([^\]]+)\]/g, (placeholder, placeholderAlt: string) => {
    const image = images[imageIndex++];
    if (!image) return placeholder;
    const alt = image.alt?.trim() || placeholderAlt.trim() || "image";
    const path = mediaLink("ticket.md", image, media);
    replacements.push(path
      ? `![${markdownPlain(alt)}](${path})`
      : `[${markdownPlain(alt)}](${indexPath}#${anchorFor(imageIndex - 1)})`);
    return `\uE000ones-image-${replacements.length - 1}\uE001`;
  });
  return localizeAttachmentUrls(markdownPlain(marked), ticket, media)
    .replace(/\uE000ones-image-(\d+)\uE001/g, (marker, index: string) => replacements[Number(index)] ?? marker);
}

/** 输出附件的本地索引；未来下载的二进制文件仍应保存在同级 attachments 目录。 */
function attachmentsIndexMarkdown(ticket: CanonicalTicket, media: TicketMediaPlan[] = []): string {
  const attachments = ticket.attachments.filter((attachment) => !isEmbeddedAttachment(ticket, attachment));
  const downloaded = attachments.filter((attachment) => mediaLink(ATTACHMENTS_INDEX_PATH, attachment, media));
  const lines = [
    "# 附件索引",
    "",
    downloaded.length > 0
      ? `本次导出已下载 ${downloaded.length} 个独立附件。下面的“本地文件”链接均指向此目录中的二进制文件；不会保存远程附件 URL。`
      : "本次导出未下载独立附件，仅保存 metadata，不保存远程附件 URL。后续下载的原始附件将保存在此目录。",
    "",
  ];
  if (attachments.length === 0) lines.push("当前没有独立附件 metadata。", "");
  for (const [index, attachment] of attachments.entries()) {
    lines.push(
      `## ${resourceAnchor("attachment", index)}`,
      "",
      `- 名称：${markdownPlain(attachment.name)}`,
      `- 类型：${markdownPlain(attachment.mediaType ?? "未设置")}`,
      `- 大小：${attachment.sizeBytes === undefined ? "未设置" : `${attachment.sizeBytes} B`}`,
      `- Hash：${markdownPlain(attachment.hash ?? "未设置")}`,
      mediaLink(ATTACHMENTS_INDEX_PATH, attachment, media) ? `- 本地文件：[已下载](${mediaLink(ATTACHMENTS_INDEX_PATH, attachment, media)})` : "- 本地文件：尚未下载（未来将保存在此目录）",
      "",
    );
  }
  return `${lines.join("\n")}\n`;
}

/** 输出描述中的内联图片索引，作为 Markdown 中稳定且真实存在的导航目标。 */
function descriptionAssetsIndexMarkdown(ticket: CanonicalTicket, media: TicketMediaPlan[] = []): string {
  const images = ticket.descriptionImages ?? [];
  const downloaded = images.filter((image) => mediaLink(DESCRIPTION_ASSETS_INDEX_PATH, image, media));
  const downloadedFileCount = new Set(downloaded.map((image) => mediaLink(DESCRIPTION_ASSETS_INDEX_PATH, image, media))).size;
  const lines = [
    "# 描述中的内联图片",
    "",
    downloaded.length > 0
      ? `本次导出已下载 ${downloadedFileCount} 张描述图片。下面的“本地文件”链接均指向此目录中的二进制文件；不会保留远程图片地址。`
      : "本次导出未下载描述图片；这里只记录从描述中识别到的图片 alt 文本，且不保留远程图片地址。",
    "",
  ];
  if (images.length === 0) lines.push("当前没有识别到描述图片。", "");
  for (const [index, image] of images.entries()) lines.push(`## ${resourceAnchor("description-image", index)}`, "", `- 图片说明：${markdownPlain(image.alt ?? "image")}`, `- 资源 ID：${markdownPlain(image.attachmentId ?? image.hash ?? "未识别")}`, mediaLink(DESCRIPTION_ASSETS_INDEX_PATH, image, media) ? `- 本地文件：[已下载](${mediaLink(DESCRIPTION_ASSETS_INDEX_PATH, image, media)})` : "- 本地文件：尚未下载", "");
  return `${lines.join("\n")}\n`;
}

/** 输出评论中的内联图片索引，按评论及图片顺序提供稳定的相对链接目标。 */
function commentAssetsIndexMarkdown(ticket: CanonicalTicket, media: TicketMediaPlan[] = []): string {
  const entries = ticket.comments.flatMap((comment, commentIndex) => (comment.images ?? []).map((image, imageIndex) => ({ comment, commentIndex, image, imageIndex })));
  const downloaded = entries.filter((entry) => mediaLink(COMMENT_ASSETS_INDEX_PATH, entry.image, media));
  const downloadedFileCount = new Set(downloaded.map((entry) => mediaLink(COMMENT_ASSETS_INDEX_PATH, entry.image, media))).size;
  const lines = [
    "# 评论中的内联图片",
    "",
    downloaded.length > 0
      ? `本次导出已下载 ${downloadedFileCount} 张评论图片。下面的“本地文件”链接均指向此目录中的二进制文件；不会保留远程图片地址。`
      : "本次导出未下载评论图片；这里只记录从评论中识别到的图片 alt 文本，且不保留远程图片地址。",
    "",
  ];
  if (entries.length === 0) lines.push("当前没有识别到评论图片。", "");
  for (const entry of entries) {
    lines.push(
      `## ${resourceAnchor("comment-image", entry.commentIndex, entry.imageIndex)}`,
      "",
      `- 评论：${markdownPlain(entry.comment.id)}`,
      `- 图片说明：${markdownPlain(entry.image.alt ?? "image")}`,
      `- 资源 ID：${markdownPlain(entry.image.attachmentId ?? entry.image.hash ?? "未识别")}`,
      mediaLink(COMMENT_ASSETS_INDEX_PATH, entry.image, media) ? `- 本地文件：[已下载](${mediaLink(COMMENT_ASSETS_INDEX_PATH, entry.image, media)})` : "- 本地文件：尚未下载",
      "",
    );
  }
  return `${lines.join("\n")}\n`;
}

/** 将规范化工单生成可阅读的 Markdown 导出内容。 */
function markdown(ticket: CanonicalTicket, media: TicketMediaPlan[] = []): string {
  const descriptionImages = ticket.descriptionImages ?? [];
  const commentEntries = ticket.comments.map((comment, index) => ({ comment, index }));
  const renderMessage = ({ comment, index }: typeof commentEntries[number]) => `- ${markdownPlain(comment.createdAt ?? "")} ${markdownPlain(comment.author?.displayName ?? "")}: ${renderBodyWithInlineImages(comment.bodyMarkdown, comment.images ?? [], ticket, media, COMMENT_ASSETS_INDEX_PATH, (imageIndex) => resourceAnchor("comment-image", index, imageIndex))}`.trim();
  const comments = commentEntries.filter(({ comment }) => comment.kind === "comment");
  const lines = [
    `# ${markdownPlain(ticket.title)}`,
    "",
    `- 工单 ID：${ticket.source.ticketId}`,
    `- 工单号：${markdownPlain(ticket.source.ticketNumber ?? ticket.source.ticketKey ?? "未设置")}`,
    `- 类型：${ticket.classification.value}`,
    `- 状态：${markdownPlain(ticket.status ?? "未设置")}`,
    `- 优先级：${markdownPlain(ticket.priority ?? "未设置")}`,
    `- 严重程度：${markdownPlain(ticket.severity ?? "未设置")}`,
    `- 所属迭代：${markdownPlain(ticket.iteration?.name ?? "未设置")}`,
    `- 负责人：${markdownPlain(ticket.assignee?.displayName ?? "未设置")}`,
    `- 创建时间：${markdownPlain(ticket.createdAt ?? "未设置")}`,
    "",
    "## 描述",
    "",
    renderBodyWithInlineImages(ticket.descriptionMarkdown ?? "未设置", descriptionImages, ticket, media, DESCRIPTION_ASSETS_INDEX_PATH, (index) => resourceAnchor("description-image", index)),
    "",
    "## 关系",
    "",
    ...ticket.relations.map((relation) => `- ${relation.type}: ${markdownPlain(relation.title ?? relation.targetKey ?? relation.targetId)}`),
    "",
    "## 评论",
    "",
    ...(comments.length > 0 ? comments.map(renderMessage) : ["暂无评论。"]),
    "",
    "## 附件",
    "",
    ...ticket.attachments.filter((attachment) => !isEmbeddedAttachment(ticket, attachment)).map((attachment, index) => `- [${markdownPlain(attachment.name)}](${mediaLink("ticket.md", attachment, media) ?? `${ATTACHMENTS_INDEX_PATH}#${resourceAnchor("attachment", index)}`})${attachment.mediaType ? ` (${markdownPlain(attachment.mediaType)})` : ""}`),
  ];
  return `${lines.join("\n")}\n`;
}

/** 判断目标绝对路径是否仍位于配置的导出根目录内。 */
function isWithinRoot(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${sep}`);
}

export class LocalTicketBundleStore implements TicketBundleStore {
  /** 保存受控导出根目录，所有写入都会在此边界内校验。 */
  constructor(private readonly root: string) {}

  /** 计算导出目录、文件清单与内容哈希，但不写入磁盘。 */
  async plan(ticket: CanonicalTicket, media: TicketMediaPlan[] = []): Promise<ExportPlan> {
    const directory = this.directory(ticket);
    const files = [
      "ticket.md",
      ATTACHMENTS_INDEX_PATH,
      DESCRIPTION_ASSETS_INDEX_PATH,
      COMMENT_ASSETS_INDEX_PATH,
      `${MACHINE_DIRECTORY}/ticket.json`,
      `${MACHINE_DIRECTORY}/comments.json`,
      `${MACHINE_DIRECTORY}/relations.json`,
      `${MACHINE_DIRECTORY}/attachments.json`,
      `${MACHINE_DIRECTORY}/media.json`,
      `${MACHINE_DIRECTORY}/manifest.json`,
      ...media.map((item) => item.path),
    ].map((path) => ({ path }));
    const contentHash = sha256(stableJson({ ticket: this.hashableTicket(ticket), media: media.map(({ attachment, roles, path }) => ({ attachment, roles: [...roles].sort(), path })) }));
    let action: ExportPlan["action"] = "created";
    let currentManifest: { contentHash?: string; layoutVersion?: number } | undefined;
    for (const manifestPath of [resolve(directory, MACHINE_DIRECTORY, "manifest.json"), resolve(directory, "manifest.json")]) {
      try {
        currentManifest = JSON.parse(await readFile(manifestPath, "utf8")) as { contentHash?: string; layoutVersion?: number };
        break;
      } catch {
        // 继续尝试 v1 根目录 manifest；两个路径都不存在时保持 created。
      }
    }
    if (currentManifest) action = currentManifest.contentHash === contentHash && currentManifest.layoutVersion === LAYOUT_VERSION ? "unchanged" : "updated";
    return { directory, files, contentHash, action };
  }

  async beginExport(ticket: CanonicalTicket, media: TicketMediaPlan[] = []): Promise<TicketExportWriteSession> {
    if (new Set(media.map((item) => item.path)).size !== media.length) throw new TicketError("SOURCE_FAILED", "Media export contains duplicate target paths");
    const directory = this.directory(ticket);
    const exportId = randomUUID();
    const lockDirectory = `${directory}.lock`;
    const stagingDirectory = `${directory}.${exportId}.tmp`;
    this.assertPath(lockDirectory);
    this.assertPath(stagingDirectory);
    try {
      await mkdir(dirname(directory), { recursive: true });
      await mkdir(lockDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new TicketError("SOURCE_FAILED", "Another export for this ticket is already in progress");
      throw new TicketError("SOURCE_FAILED", `Failed to reserve ticket export: ${error instanceof Error ? error.message : "unknown error"}`);
    }
    try {
      const plan = await this.plan(ticket, media);
      await mkdir(stagingDirectory, { recursive: true });
      const existing = await this.readExistingMedia(plan.directory);
      const completed = new Map<string, { sha256: string; contentType?: string }>();
      const missingMedia: TicketMediaPlan[] = [];
      for (const item of media) {
        const expected = existing.manifest.get(item.path);
        const previous = existing.media.get(item.path);
        const hash = expected && this.matchesExistingMedia(item, previous)
          ? await this.copyVerifiedMedia(plan.directory, stagingDirectory, item, expected)
          : undefined;
        if (hash) completed.set(item.path, { sha256: hash, contentType: previous?.contentType });
        else missingMedia.push(item);
      }
      return this.createSession(ticket, media, plan, exportId, lockDirectory, stagingDirectory, missingMedia, completed);
    } catch (error) {
      await rm(stagingDirectory, { recursive: true, force: true });
      await rm(lockDirectory, { recursive: true, force: true });
      throw error instanceof TicketError ? error : new TicketError("SOURCE_FAILED", `Failed to stage ticket export: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  /** 以暂存目录和原子替换方式写入完整工单 bundle。 */
  /** 根据 provider、项目和工单标识计算受限的最终导出目录。 */
  private async readExistingMedia(directory: string): Promise<{ manifest: Map<string, string>; media: Map<string, { attachmentId?: string; hash?: string; contentType?: string }> }> {
    try {
      const [manifestContents, mediaContents] = await Promise.all([
        readFile(resolve(directory, MACHINE_DIRECTORY, "manifest.json"), "utf8"),
        readFile(resolve(directory, MACHINE_DIRECTORY, "media.json"), "utf8"),
      ]);
      const manifest = JSON.parse(manifestContents) as { files?: Array<{ path?: string; sha256?: string }> };
      const previousMedia = JSON.parse(mediaContents) as Array<{ path?: string; attachmentId?: string; hash?: string; contentType?: string }>;
      return {
        manifest: new Map((manifest.files ?? []).flatMap((file) => file.path && file.sha256 ? [[file.path, file.sha256] as const] : [])),
        media: new Map(previousMedia.flatMap((item) => item.path ? [[item.path, item] as const] : [])),
      };
    } catch {
      return { manifest: new Map(), media: new Map() };
    }
  }

  private matchesExistingMedia(item: TicketMediaPlan, previous: { attachmentId?: string; hash?: string } | undefined): boolean {
    return previous?.attachmentId === item.attachment.id && (!item.attachment.hash || previous.hash === item.attachment.hash);
  }

  private async copyVerifiedMedia(sourceDirectory: string, stagingDirectory: string, item: TicketMediaPlan, expected: string): Promise<string | undefined> {
    const source = resolve(sourceDirectory, item.path);
    const destination = resolve(stagingDirectory, item.path);
    this.assertPath(source);
    this.assertPath(destination);
    try {
      await mkdir(dirname(destination), { recursive: true });
      const hash = createHash("sha256");
      await pipeline(createReadStream(source), new Transform({ transform(chunk, _encoding, callback) { hash.update(chunk); callback(null, chunk); } }), createWriteStream(destination));
      const actual = hash.digest("hex");
      if (actual === expected) return actual;
    } catch {
      // 缺失、不可读或不完整的文件会重新下载。
    }
    await rm(destination, { force: true });
    return undefined;
  }

  private createSession(
    ticket: CanonicalTicket,
    media: TicketMediaPlan[],
    plan: ExportPlan,
    exportId: string,
    lockDirectory: string,
    stagingDirectory: string,
    missingMedia: TicketMediaPlan[],
    completed: Map<string, { sha256: string; contentType?: string }>,
  ): TicketExportWriteSession {
    let closed = false;
    const close = async () => {
      if (closed) return;
      await rm(lockDirectory, { recursive: true, force: true });
      closed = true;
    };
    const abort = async () => {
      if (closed) return;
      try {
        await rm(stagingDirectory, { recursive: true, force: true });
      } finally {
        await close();
      }
    };
    const pendingByPath = new Map(missingMedia.map((item) => [item.path, item]));
    return {
      missingMedia,
      writeMedia: async (item, download) => {
        const planned = pendingByPath.get(item.path);
        if (closed || !planned || completed.has(item.path)) throw new TicketError("SOURCE_FAILED", "Media is not pending for this ticket export session");
        if (planned.attachment.id !== item.attachment.id || planned.attachment.hash !== item.attachment.hash || download.attachment.id !== planned.attachment.id) throw new TicketError("SOURCE_FAILED", "Downloaded media does not match the requested attachment");
        const destination = resolve(stagingDirectory, item.path);
        this.assertPath(destination);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, download.bytes);
        completed.set(item.path, { sha256: sha256Bytes(download.bytes), contentType: download.contentType });
      },
      commit: async () => {
        if (closed) throw new TicketError("SOURCE_FAILED", "Ticket export session is closed");
        try {
          if (completed.size !== media.length) throw new TicketError("SOURCE_FAILED", "Media export is incomplete; missing attachments must be downloaded before committing");
          if (plan.action === "unchanged" && missingMedia.length === 0) {
            const known = new Map([...completed].map(([path, value]) => [path, value.sha256]));
            const files = await this.readArtifactHashes(plan.directory, plan.files, known);
            await rm(stagingDirectory, { recursive: true, force: true });
            await close();
            return { ...plan, files, exportId, status: "unchanged" as const };
          }
          const mediaRecords = media.map((item) => ({ attachmentId: item.attachment.id, hash: item.attachment.hash, name: item.attachment.name, declaredMediaType: item.attachment.mediaType, contentType: completed.get(item.path)?.contentType, path: item.path, roles: item.roles, downloaded: true }));
          const artifactsWithoutManifest: Record<string, string> = {
            "ticket.md": markdown(ticket, media),
            [ATTACHMENTS_INDEX_PATH]: attachmentsIndexMarkdown(ticket, media),
            [DESCRIPTION_ASSETS_INDEX_PATH]: descriptionAssetsIndexMarkdown(ticket, media),
            [COMMENT_ASSETS_INDEX_PATH]: commentAssetsIndexMarkdown(ticket, media),
            [`${MACHINE_DIRECTORY}/ticket.json`]: `${JSON.stringify(ticket, null, 2)}\n`,
            [`${MACHINE_DIRECTORY}/comments.json`]: `${JSON.stringify(ticket.comments, null, 2)}\n`,
            [`${MACHINE_DIRECTORY}/relations.json`]: `${JSON.stringify(ticket.relations, null, 2)}\n`,
            [`${MACHINE_DIRECTORY}/attachments.json`]: `${JSON.stringify(ticket.attachments, null, 2)}\n`,
            [`${MACHINE_DIRECTORY}/media.json`]: `${JSON.stringify(mediaRecords, null, 2)}\n`,
          };
          const manifestFiles = [...Object.entries(artifactsWithoutManifest).map(([path, content]) => ({ path, sha256: sha256(content) })), ...media.map((item) => ({ path: item.path, sha256: completed.get(item.path)!.sha256 }))];
          const manifest = { schemaVersion: ticket.schemaVersion, exportId, source: { ticketId: ticket.source.ticketId, teamId: ticket.source.teamId, connector: ticket.source.connector, fetchedAt: ticket.source.fetchedAt }, layoutVersion: LAYOUT_VERSION, contentHash: plan.contentHash, files: manifestFiles, attachmentCount: ticket.attachments.length, downloadedMediaCount: media.length };
          const artifacts = { ...artifactsWithoutManifest, [`${MACHINE_DIRECTORY}/manifest.json`]: `${JSON.stringify(manifest, null, 2)}\n` };
          for (const [relative, content] of Object.entries(artifacts)) {
            const destination = resolve(stagingDirectory, relative);
            this.assertPath(destination);
            await mkdir(dirname(destination), { recursive: true });
            await writeFile(destination, content, "utf8");
          }
          await this.commitDirectory(stagingDirectory, plan.directory, exportId);
          await close();
          const status = plan.action === "created" ? "created" as const : "updated" as const;
          return { ...plan, action: status, files: [...Object.entries(artifacts).map(([path, content]) => ({ path, sha256: sha256(content) })), ...media.map((item) => ({ path: item.path, sha256: completed.get(item.path)!.sha256 }))], exportId, status };
        } catch (error) {
          await abort();
          throw error instanceof TicketError ? error : new TicketError("SOURCE_FAILED", `Failed to write ticket export: ${error instanceof Error ? error.message : "unknown error"}`);
        }
      },
      abort,
    };
  }

  private directory(ticket: CanonicalTicket): string {
    const root = resolve(this.root);
    const project = ticket.source.projectId ?? ticket.source.teamId;
    const ticketDirectoryName = ticket.source.ticketNumber?.trim() || ticket.source.ticketId;
    const target = resolve(root, sanitizedSegment(ticket.source.provider), sanitizedSegment(project), sanitizedSegment(ticketDirectoryName));
    this.assertPath(target);
    return target;
  }

  /** 拒绝所有位于导出根目录之外的文件操作。 */
  private assertPath(target: string): void {
    const root = resolve(this.root);
    if (!isWithinRoot(root, target)) throw new TicketError("EXPORT_ROOT_DENIED", "Export path is outside storage.root");
  }

  /** 移除每次读取都会变化的时间戳，得到可用于幂等比较的工单内容。 */
  private hashableTicket(ticket: CanonicalTicket): unknown {
    const clone = JSON.parse(JSON.stringify(ticket)) as CanonicalTicket;
    clone.source.fetchedAt = "";
    return clone;
  }

  /** 读取既有导出文件的哈希，用于返回未变化导出的完整结果。 */
  private async readArtifactHashes(directory: string, files: ExportFile[], known = new Map<string, string>()): Promise<Array<ExportFile & { sha256: string }>> {
    return Promise.all(files.map(async ({ path }) => ({ path, sha256: known.get(path) ?? createHash("sha256").update(await readFile(resolve(directory, path))).digest("hex") })));
  }

  /** 仅在所有暂存文件写入成功后才整体替换目标 bundle。 */
  private async commitDirectory(stagingDirectory: string, destination: string, exportId: string): Promise<void> {
    const previousDirectory = `${destination}.${exportId}.previous`;
    this.assertPath(previousDirectory);
    await mkdir(dirname(destination), { recursive: true });
    let movedPrevious = false;
    try {
      await rename(destination, previousDirectory);
      movedPrevious = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await rename(stagingDirectory, destination);
    } catch (error) {
      if (movedPrevious) await rename(previousDirectory, destination);
      throw error;
    }
    if (movedPrevious) {
      // 新 bundle 已提交时保留旧备份比把成功写入误报为失败更安全。
      await rm(previousDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/** 删除测试专用的临时导出目录，生产代码不会调用该函数。 */
export async function removeTestDirectory(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}
