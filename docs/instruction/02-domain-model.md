# 02 · 领域模型

> 源码：[ticket.ts](../../src/modules/tickets/domain/ticket.ts) 与 [ticket-search.ts](../../src/modules/tickets/domain/ticket-search.ts)。

## 工单详情

\`CanonicalTicket\` 是 provider 边界之后的统一详情模型。它包含来源元信息、标题、描述、状态、负责人、评论、附件、关系和自定义字段。返回 MCP 或写入 bundle 前都会经过脱敏策略；临时附件 URL 不属于持久化模型。

\`InlineTicket\` 是 \`CanonicalTicket\` 的有界投影，供 \`ticket_get\` 返回。它附加内容预算、截断标记和省略计数。

## 受控搜索输入

\`\`\`ts
type TicketSearchInput = {
  profile?: string;
  preset?: "my_open" | "my_active" | "all";
  where?: { all: TicketFilter[] };
  page?: { size?: number; cursor?: string };
};
\`\`\`

\`TicketFilter\` 只允许：

- \`{ field: "title", op: "contains", value }\`
- \`{ field: "issueType", op: "in", values }\`
- \`{ field: "statusCategory", op: "in" | "notIn", values }\`
- \`{ field: "assignee", op: "in", values: ["me"] }\`

规范化后得到 \`TicketSearchQuery\`：它含固定排序、去重/合并后的条件和 provider 内部 \`after\`，后者永远不是公开输入。

## 搜索输出

\`\`\`ts
type TicketSearchResult = {
  query: {
    preset: TicketSearchPreset;
    normalizedFilter: { all: TicketFilter[] };
    fingerprint: string;
  };
  items: TicketSummary[];
  page: {
    size: number;
    returned: number;
    totalCount: number;
    totalCountExact: true;
    hasNextPage: boolean;
    nextCursor?: string;
  };
};
\`\`\`

\`TicketSummary\` 只表示低成本列表字段：稳定 ID、可选 key/编号、标题、状态、负责人和项目 ID。它不是详情，也不携带父级或子级树结构。

## 分页与冻结

\`TicketSearchCursorStore\` 把 ONES \`endCursor\` 保存在进程内，以 HMAC 签名 opaque token 返回。token 绑定 profile、查询 fingerprint、页大小和有效期。

查询导出使用 \`TicketSearchSelection\`：

\`\`\`ts
type TicketSearchSelection = {
  expectedCount: number;
  fingerprint: string;
};
\`\`\`

fingerprint 针对排序后的稳定 ID 集合计算，避免可变展示字段导致写入阶段的假阳性。
