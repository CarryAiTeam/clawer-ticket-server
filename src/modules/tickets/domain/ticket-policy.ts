import { CanonicalTicket, TicketSummary } from "./ticket.js";

export interface TicketRedactionPolicy {
  omitPeople: boolean;
  removeFields: string[];
}

/** 在工单进入 MCP 返回或持久化前应用脱敏规则。 */
export function redactTicket(ticket: CanonicalTicket, policy: TicketRedactionPolicy): CanonicalTicket {
  const clone = JSON.parse(JSON.stringify(ticket)) as CanonicalTicket;
  const blockedFields = new Set(policy.removeFields.map((field) => field.trim().toLocaleLowerCase()));
  clone.customFields = clone.customFields.filter((field) => {
    const name = field.name?.trim().toLocaleLowerCase();
    const id = field.id.trim().toLocaleLowerCase();
    return !blockedFields.has(name ?? "") && !blockedFields.has(id);
  });
  if (policy.omitPeople) {
    delete clone.assignee;
    delete clone.reporter;
    clone.comments = clone.comments.map(({ author: _author, ...comment }) => comment);
  }
  // 附件 URL 可能携带短期凭据，不能作为可导出的元数据保留。
  clone.attachments = clone.attachments.map(({ sourceUrl: _sourceUrl, ...attachment }) => attachment);
  return clone;
}

/** 搜索摘要也属于 MCP 输出；按同一 people 策略投影，避免摘要绕过脱敏漏出负责人。 */
export function redactTicketSummary(summary: TicketSummary, policy: TicketRedactionPolicy): TicketSummary {
  const clone: TicketSummary = {
    ...summary,
    ...(summary.status ? { status: { ...summary.status } } : {}),
    ...(summary.assignee ? { assignee: { ...summary.assignee } } : {}),
  };
  if (policy.omitPeople) delete clone.assignee;
  return clone;
}
