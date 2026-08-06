# 01 · 架构设计

## 1. 架构选型结论

项目采用 **模块化单体（modular monolith）+ Ports and Adapters / 六边形架构**。

- 保留**一个** TypeScript 进程、**一个** MCP Server、**一套**部署方式。
- 进程内按“核心领域 → 应用用例 → 外部适配器 → MCP 交付层”分隔。
- 不引入微服务、不机械套用聚合/仓储/领域事件；当前没有跨工单一致性事务、复杂状态机或多服务边界。

选型依据（来自 `docs/mcp-architecture-evolution.md`）：
- 只有一个产品领域（工单）和一个部署单元，不满足拆微服务的条件。
- 但若继续按技术文件平铺，会产生命名泄漏、变化原因混合、媒体复杂度膨胀、测试替换面不清晰四类问题。

## 2. 分层依赖方向

```text
MCP Client (Claude / IDE Agent / ...)
  ↓ JSON-RPC over stdio
Delivery: MCP tool handlers (schema, response mapping)
  ↓ 调用 Application 用例
Application: use cases (orchestration, authorization intent, transactions)
  ↓ 依赖端口
Domain: ticket contracts, policies, domain errors, ports
  ↑ 端口由适配器实现
Adapters / Infrastructure: ONES, future providers, filesystem, secrets, HTTP, browser
```

**关键约束：依赖方向永远向内。** Domain 不依赖任何外层；Application 只依赖 Domain 端口；Provider / Infrastructure 实现 Domain 端口；Delivery 只调用 Application。

## 3. 各层职责

### 3.1 Delivery（交付层）— `src/delivery/mcp/`

- 文件：[ticket-server.ts](../src/delivery/mcp/ticket-server.ts)
- 职责：注册 7 个 `ticket_*` 工具，定义 zod 入参 schema，把 `TicketApplication` 的返回投影成 MCP 文本响应（`textResult`），把 `TicketError` 投影成稳定的 MCP 错误载荷（`errorResult`）。
- **不做**：不直接调用 ONES、不直接读写文件、不接受任意 URL/Header/GraphQL 文本。
- 工厂：`createTicketMcpServer({ getApplication })`。`getApplication` 是惰性回调，由 bootstrap 注入，使测试可用 in-memory transport + fake application。

### 3.2 Application（应用层）— `src/modules/tickets/application/`

- 文件：[ticket-application.ts](../src/modules/tickets/application/ticket-application.ts)
- 类：`TicketApplication`
- 职责：编排用例（连接状态、列表、详情、导出、媒体计划、脱敏、内联裁剪），保证跨工具的一致行为。
- 依赖（构造注入）：`TicketProfileResolver`、`TicketProvider`、`TicketBundleStore`、`TicketRedactionPolicy`，可选 `BrowserSessionProvider`、`TicketMediaProvider`。
- 关键不变量：
  - `listMyOpenDetails` / `exportMyOpenTickets` 必须**先全部读取详情成功**才开始写入，绝不以列表摘要代替详情。
  - `getTicket` 在返回前做项目 allowlist 校验 + `redactTicket` 脱敏。
  - `getTicketInline` 在 `getTicket` 之上按 `inlineMaxChars` 预算裁剪。
  - 导出 `write` 模式使用 `beginExport` 事务会话，下载缺失媒体后 `commit`，失败 `abort`。

### 3.3 Domain（领域层）— `src/modules/tickets/domain/`

| 文件 | 内容 |
| --- | --- |
| [ticket.ts](../src/modules/tickets/domain/ticket.ts) | `CanonicalTicket`、`InlineTicket`、`TicketIndexItem`、`TicketIndexTree`、`TicketReference`、`Person`、`TicketComment`、`TicketInlineImage`、`TicketAttachment`、`TicketIteration`、`TicketRelation`、`TicketClass` |
| [ports.ts](../src/modules/tickets/domain/ports.ts) | `TicketProfile`、`TicketProfileResolver`、`ConnectionStatus`、`TicketProvider`、`TicketMediaProvider`、`TicketBundleStore`、`TicketExportWriteSession`、`BrowserSessionProvider`、`ExportPlan`、`ExportResult` 等 |
| [ticket-error.ts](../src/modules/tickets/domain/ticket-error.ts) | `TicketErrorCode`（12 个稳定错误码）+ `TicketError` |
| [ticket-policy.ts](../src/modules/tickets/domain/ticket-policy.ts) | `TicketRedactionPolicy` + `redactTicket`（纯函数） |

**领域层不依赖任何 ONES 概念。** `CanonicalTicket.source.provider` 只是字符串 `"ones"`，不引入 ONES 类型。

### 3.4 Providers（适配器层）— `src/providers/ones/`

| 文件 | 角色 |
| --- | --- |
| [ones-config.ts](../src/providers/ones/ones-config.ts) | ONES 配置 zod schema、`loadConfig`、`getProfile`、host allowlist 校验 |
| [ones-contracts.ts](../src/providers/ones/ones-contracts.ts) | `OnesRawTicketData`（detail + messages + attachments），原始响应在归一化前的载体 |
| [ones-graphql-source.ts](../src/providers/ones/ones-graphql-source.ts) | `OnesGraphqlSource` 实现 `TicketProvider` + `TicketMediaProvider`；含 GraphQL/REST 请求、限流、重试、请求预算 |
| [ones-browser-source.ts](../src/providers/ones/ones-browser-source.ts) | `OnesBrowserSource extends OnesGraphqlSource` 同时实现 `BrowserSessionProvider`；可见窗口、内存 context、同源 fetch、reconciliation |
| [ones-ticket-mapper.ts](../src/providers/ones/ones-ticket-mapper.ts) | `normalizeOnesTicket`：raw ONES → `CanonicalTicket`；含 HTML 实体解码、图片提取、链接清洗、关系归一化、分类规则 |

**继承关系**：`OnesBrowserSource` 继承 `OnesGraphqlSource`，对 `status`/`listMyOpen`/`downloadAttachment`/`getRawTicket`/`requestJson` 做 browser 特化 override，其余复用 GraphQL 实现。这是一种“同一 provider 的两种连接器”的局部化策略，不向领域层泄漏。

### 3.5 Infrastructure（基础设施层）— `src/infrastructure/`

| 文件 | 内容 |
| --- | --- |
| [http/fetch-http-client.ts](../src/infrastructure/http/fetch-http-client.ts) | `HttpClient` 接口、`FetchHttpClient`（`redirect: "manual"`）、`parseJsonResponse`（401/403/429/captcha/非 JSON 统一映射为 `TicketError`） |
| [security/env-secret-provider.ts](../src/infrastructure/security/env-secret-provider.ts) | `SecretProvider` 接口、`EnvSecretProvider`（从 `process.env[reference]` 读取，空值抛 `SECRET_UNAVAILABLE`） |
| [modules/tickets/infrastructure/export/local-ticket-bundle-store.ts](../src/modules/tickets/infrastructure/export/local-ticket-bundle-store.ts) | `LocalTicketBundleStore` 实现 `TicketBundleStore`；原子暂存 + 锁目录 + manifest + 媒体去重 + 断点续传 |

### 3.6 Config — `src/config/`

- 文件：[static-ticket-profile-resolver.ts](../src/config/static-ticket-profile-resolver.ts)
- 类：`StaticTicketProfileResolver`：把受控配置中的 profile 投影为与 provider 无关的 `TicketProfile` 内存对象；名称唯一性校验；`get(name)` 不存在抛 `PROFILE_NOT_FOUND`。

### 3.7 Bootstrap（组合根）— `src/bootstrap/`

- 文件：[create-server.ts](../src/bootstrap/create-server.ts)
- `createServer(options?)`：
  1. 惰性 `getApplication`：首次调用时 `loadConfig(options.configPath)` → `new OnesBrowserSource(config)`（同时作为 `TicketProvider` 和 `BrowserSessionProvider`）→ `createTicketApplication(...)`。
  2. `createTicketMcpServer({ getApplication })`。
- **provider 只能由本地受控配置选择，不能由 MCP 输入指定**——这是安全边界。
- `ticketProfiles(config)` 把 ONES profile 的 `provider/source/allowedProjects/inlineMaxChars` 投影为通用 `TicketProfile`。

## 4. 入口与传输

- 入口：[src/index.ts](../src/index.ts)
  ```ts
  async function main(): Promise<void> {
    const server = createServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
  main().catch((error) => { console.error("Failed to start MCP server:", error); process.exitCode = 1; });
  ```
- 启动错误写 **stderr**；正常运行**绝不向 stdout 写普通日志**（stdout 是 MCP JSON-RPC 通道）。
- [src/server.ts](../src/server.ts) 仅 `@deprecated` 重导出 `createServer`，保留向后兼容。

## 5. 配置加载链

```text
CLAWER_TICKET_CONFIG_PATH (或 ONES_MCP_CONFIG_PATH，或默认 clawer-ticket.config.json)
  → loadConfig() 读 JSON
  → parseConfig() zod 校验 + host allowlist 校验
  → OnesConfig
  → ticketProfiles() 投影为 StaticTicketProfileResolver
  → TicketApplication({ profiles, provider, bundleStore, redaction, browserSessions, mediaProvider })
```

## 6. 与原架构演进方案的对应关系

`docs/mcp-architecture-evolution.md` 给出的目标目录与当前实现的对应：

| 目标 | 当前实现 |
| --- | --- |
| `bootstrap/create-server.ts` | ✅ |
| `delivery/mcp/register-ticket-tools.ts` | 合并为 `ticket-server.ts`（含 schema + result mapper） |
| `modules/tickets/domain/*` | ✅（`ticket.ts`/`ports.ts`/`ticket-error.ts`/`ticket-policy.ts`） |
| `modules/tickets/application/*` | 合并为单文件 `ticket-application.ts`（多个用例方法） |
| `modules/tickets/infrastructure/export/*` | ✅ `local-ticket-bundle-store.ts` |
| `infrastructure/security/env-secret-provider.ts` | ✅ |
| `infrastructure/http/fetch-http-client.ts` | ✅ |
| `providers/ones/*` | ✅（文件名略有差异，职责一致） |
| `config/config-loader.ts` | 由 `bootstrap/create-server.ts` 内联 + `ones-config.ts` 的 `loadConfig` |

> 演进方案提到的“第二 provider”与“二进制附件下载”已在当前实现中作为 `TicketMediaProvider` 端口 + `OnesBrowserSource.downloadAttachment` 落地，未以空接口提前加入。

## 7. 为什么这样切分（一句话总结）

- **Delivery** 只管协议与 DTO，业务变化不污染协议层。
- **Application** 只管用例编排，provider 变化不污染业务流。
- **Domain** 只管契约与规则，外层变化不污染稳定概念。
- **Provider** 只管翻译，ONES 的怪癖不污染通用类型。
- **Infrastructure** 只管外部世界，文件/HTTP/密钥各自可替换。
- **Bootstrap** 只管装配，唯一知道“谁实现谁”的地方。
