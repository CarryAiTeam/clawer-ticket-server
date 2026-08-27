import { TicketMediaMode, TicketMediaPlan } from "./ports.js";
import { TicketAttachment } from "./ticket.js";
import { TicketError } from "./ticket-error.js";

/** 同步查询导出允许的最大工单数；不得用配置静默提高。 */
export const MAX_TICKET_EXPORT_ITEMS = 2_000;

/** 默认导出预算：小范围直接写入，较大范围必须先确认。 */
export const DEFAULT_TICKET_EXPORT_LIMITS = Object.freeze({
  autoDownloadThreshold: 50,
  maxItems: MAX_TICKET_EXPORT_ITEMS,
  maxAttachments: 500,
  maxAttachmentBytes: 50 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
});

export interface TicketExportLimits {
  autoDownloadThreshold: number;
  maxItems: number;
  maxAttachments: number;
  maxAttachmentBytes: number;
  maxTotalBytes: number;
}

export interface TicketExportMediaSummary {
  plannedCount: number;
  knownBytes: number;
  unknownSizeCount: number;
}

export interface TicketExportBudgetReport {
  mediaMode: TicketMediaMode;
  attachmentCount: number;
  plannedMedia: TicketExportMediaSummary;
  downloadedBytes: number;
  limits: TicketExportLimits;
}

/** 查询型导出的汇总预算；每张工单仍会保留自己的预算明细。 */
export interface TicketSearchExportBudgetReport extends TicketExportBudgetReport {}

function positiveSafeInteger(value: unknown, label: string, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new TicketError("CONFIG_INVALID", `${label} must be a positive safe integer`);
  }
  return value;
}

/** 合并配置并验证预算，避免 NaN、负数或不安全整数穿过应用边界。 */
export function normalizeTicketExportLimits(value?: Partial<TicketExportLimits>): TicketExportLimits {
  const limits = {
    ...DEFAULT_TICKET_EXPORT_LIMITS,
    ...(value ?? {}),
  };
  const normalized = {
    autoDownloadThreshold: positiveSafeInteger(limits.autoDownloadThreshold, "exportLimits.autoDownloadThreshold"),
    maxItems: positiveSafeInteger(limits.maxItems, "exportLimits.maxItems", MAX_TICKET_EXPORT_ITEMS),
    maxAttachments: positiveSafeInteger(limits.maxAttachments, "exportLimits.maxAttachments"),
    maxAttachmentBytes: positiveSafeInteger(limits.maxAttachmentBytes, "exportLimits.maxAttachmentBytes"),
    maxTotalBytes: positiveSafeInteger(limits.maxTotalBytes, "exportLimits.maxTotalBytes"),
  };
  if (normalized.autoDownloadThreshold > normalized.maxItems) {
    throw new TicketError("CONFIG_INVALID", "exportLimits.autoDownloadThreshold cannot exceed exportLimits.maxItems");
  }
  if (normalized.maxAttachmentBytes > normalized.maxTotalBytes) {
    throw new TicketError("CONFIG_INVALID", "exportLimits.maxAttachmentBytes cannot exceed exportLimits.maxTotalBytes");
  }
  return normalized;
}

/** 统计去重后的媒体计划；未知大小单独计数，不能假装为零字节。 */
export function summarizeMedia(media: readonly TicketMediaPlan[]): TicketExportMediaSummary {
  let knownBytes = 0;
  let unknownSizeCount = 0;
  for (const item of media) {
    const size = item.attachment.sizeBytes;
    if (typeof size === "number" && Number.isSafeInteger(size) && size >= 0) knownBytes += size;
    else unknownSizeCount += 1;
  }
  return { plannedCount: media.length, knownBytes, unknownSizeCount };
}

export function mergeMediaSummaries(left: TicketExportMediaSummary, right: TicketExportMediaSummary): TicketExportMediaSummary {
  return {
    plannedCount: left.plannedCount + right.plannedCount,
    knownBytes: left.knownBytes + right.knownBytes,
    unknownSizeCount: left.unknownSizeCount + right.unknownSizeCount,
  };
}

export function assertMediaSummaryWithinLimits(summary: TicketExportMediaSummary, limits: TicketExportLimits): void {
  if (summary.plannedCount > limits.maxAttachments) {
    throw new TicketError("EXPORT_LIMIT_EXCEEDED", `Export contains ${summary.plannedCount} media files; the configured limit is ${limits.maxAttachments}`);
  }
  if (summary.knownBytes > limits.maxTotalBytes) {
    throw new TicketError("EXPORT_LIMIT_EXCEEDED", `Known media size ${summary.knownBytes} exceeds the configured total limit of ${limits.maxTotalBytes} bytes`);
  }
}

/** 在真正访问媒体前检查数量、单文件大小和已知总大小。 */
export function assertMediaWithinLimits(media: readonly TicketMediaPlan[], limits: TicketExportLimits): TicketExportMediaSummary {
  const summary = summarizeMedia(media);
  for (const item of media) {
    const size = item.attachment.sizeBytes;
    if (typeof size === "number" && Number.isSafeInteger(size) && size > limits.maxAttachmentBytes) {
      throw new TicketError("EXPORT_LIMIT_EXCEEDED", `Attachment ${item.attachment.id} exceeds the configured per-file limit of ${limits.maxAttachmentBytes} bytes`);
    }
  }
  assertMediaSummaryWithinLimits(summary, limits);
  return summary;
}

/** 校验 provider 实际返回的字节，覆盖附件元数据缺失或过期的情况。 */
export function assertDownloadedBytes(bytes: Uint8Array, attachment: TicketAttachment, downloadedBytes: number, limits: TicketExportLimits): number {
  if (bytes.byteLength > limits.maxAttachmentBytes) {
    throw new TicketError("EXPORT_LIMIT_EXCEEDED", `Attachment ${attachment.id} exceeded the configured per-file limit of ${limits.maxAttachmentBytes} bytes`);
  }
  const total = downloadedBytes + bytes.byteLength;
  if (!Number.isSafeInteger(total) || total > limits.maxTotalBytes) {
    throw new TicketError("EXPORT_LIMIT_EXCEEDED", `Downloaded media exceeds the configured total limit of ${limits.maxTotalBytes} bytes`);
  }
  return total;
}
