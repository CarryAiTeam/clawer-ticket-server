# 04 · 应用服务

> 源码：[ticket-application.ts](../../src/modules/tickets/application/ticket-application.ts)。

`TicketApplication` 负责把 MCP 的受控业务请求编排成 provider、浏览器和本地导出操作。它不接收原始 ONES GraphQL，不信任 provider 的分页元数据，也不允许调用方扩大 profile 范围。

## 公开用例

| 方法 | 用途 |
| --- | --- |
| `connectionStatus(profile?)` | 返回受控 profile 信息与只读授权探测。 |
| `openBrowserSession(profile?)` / `closeBrowserSession(profile?)` | 管理临时浏览器会话。 |
| `searchTickets(input)` | 规范化查询、解封装 cursor、校验结果、脱敏摘要。 |
| `getTicket(profile, reference)` | 读取、项目校验和脱敏完整工单。 |
| `getTicketInline(profile, reference)` | 以 profile 内容预算裁剪详情。 |
| `exportTicket(...)` | 计划或写入单张工单。 |
| `exportTicketSearch(...)` | 对完整冻结查询选择进行计划或写入。 |

没有旧待办列表、树形详情或按展示名称状态导出的应用服务方法。

## 搜索

`searchTickets` 先用 `normalizeTicketSearchInput` 展开 preset、规范化 AND 条件并固定排序，再解析 profile 和查询 fingerprint。带公共 cursor 时，它验证 HMAC、有效期、profile、fingerprint 与页大小后才取得内部 `after`。

provider 返回后，应用层校验 `returned === items.length`、有效的 `totalCount`、布尔 `hasNextPage` 和有续页时的 `endCursor`；随后对每项再次执行 `allowedProjects` 白名单检查，并按 `omitPeople` 脱敏摘要。只有有下一页时才签发新的公共 cursor。

## 查询导出

`exportTicketSearch` 不接受 `page` 或 `page.cursor`，因为它始终完整枚举：

1. 用固定每页 50 条请求，直到 `hasNextPage:false`。
2. 拒绝总数变化、重复 ID、总数不符、过大选择或项目越界。
3. 对排序后的 ID 集合生成 selection fingerprint。
4. 直接 `write` 使用本次枚举的冻结选择；只有携带此前 plan 的 `selection` 时，才验证相同的 `expectedCount` 和 fingerprint，并在变化时抛 `SELECTION_CHANGED`。
5. 先读取所有选中详情；任一详情失败时不启动写入。
6. 只有所有详情成功后，才按每张工单的原子会话执行 plan 或 write。

这保证查询选择和详情读取均不会被静默降级成部分导出。单张本地写入的文件系统错误仍按单张原子会话回滚；已经成功提交的其他工单不会被删除。

## 安全闸门

- `profile()` 要求 profile 与注入 provider 匹配。
- 搜索和全页枚举都重复检查 `allowedProjects`。
- `getTicket()` 也检查详情来源项目，并在返回或导出前脱敏。
- 媒体下载只发生在显式 `write` 且 `media:"download"` 时。
- 未配置浏览器或媒体端口时，返回明确的 `CONFIG_INVALID`。
