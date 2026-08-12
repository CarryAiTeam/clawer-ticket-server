# 03 · 端口与接口

> 源码：[ports.ts](../../src/modules/tickets/domain/ports.ts)。

## Profile 与 provider

\`\`\`ts
interface TicketProfile {
  name: string;
  providerId: string;
  connector: string;
  allowedProjects: string[];
  inlineMaxChars: number;
}

interface TicketProvider {
  readonly providerId: string;
  status(profile: TicketProfile): Promise<ConnectionStatus>;
  search(profile: TicketProfile, query: TicketSearchQuery): Promise<TicketSearchProviderResult>;
  getTicket(profile: TicketProfile, reference: TicketReference): Promise<CanonicalTicket>;
}
\`\`\`

\`TicketProvider.search\` 只接受应用层已规范化的 \`TicketSearchQuery\`。它没有 \`listMyOpen\`、树形索引或 provider 原始筛选端口。

\`TicketSearchProviderResult\` 的分页字段为 \`returned\`、\`totalCount\`、\`hasNextPage\` 和可选 \`endCursor\`。应用层会再次校验形状、计数和项目范围。

## 可选能力

- \`BrowserSessionProvider\`：打开和关闭临时可见浏览器会话。
- \`TicketMediaProvider\`：在本地导出流程中下载已验证附件字节。
- \`TicketBundleStore\`：为单张规范工单生成计划或启动原子写入会话。

这些能力彼此独立：读取详情不等于下载媒体，搜索不等于读取详情，浏览器会话不等于持久化登录态。

## 导出端口

\`TicketBundleStore.plan\` 没有写入副作用；\`beginExport\` 返回事务会话。会话仅允许写入 \`missingMedia\`，并通过 \`commit\` 或 \`abort\` 关闭。应用层只在所有选中详情已成功读取后才调用第一个 \`beginExport\`。
