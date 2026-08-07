# OnES 工单采集 MCP：实施规格

本文件是下一阶段代码实现的唯一设计输入。它不假定任何未验证的 OnES 私有接口；租户相关路径、字段和认证参数必须由管理员授权的 API/导出文档或脱敏样本补齐。

## 1. 决策与范围

### 1.1 首期范围

- 仅 stdio MCP、单工单、只读来源、按调用显式写入本地。
- 实现 `api`、`graphql`、`import` 三种来源端口；`graphql` 是租户显式启用的固定只读契约，不能由工具输入自定义端点、查询或请求头。
- 实现 `mode: "plan" | "write"`：默认 `plan`，写入必须显式选择 `write`。
- 实现规则分类、脱敏、原子落盘、内容哈希和测试 fixture。

### 1.2 明确延后

- 浏览器会话读取、抓包、模拟登录、批量查询、持续同步、附件二进制的默认下载、远程 HTTP 传输、LLM 摘要。
- 任何验证码/MFA/反自动化对抗、Cookie 提取、私有接口探测。

### 1.3 业界依据

| 实践 | 在本项目的落点 |
| --- | --- |
| Ports and adapters | 来源读取、标准化、存储、MCP 适配各自独立，避免 OnES 页面/API 变化扩散。 |
| Least privilege + secret references | 只读 scope；配置中只存 secret 引用，运行时解析实际值。 |
| Idempotent ingestion | canonical JSON 的 SHA-256 决定是否需要重写，manifest 记录来源与版本。 |
| Plan-before-write | 写盘工具先输出可审查计划，避免模型误触发本地副作用。 |
| Rate budget + stop conditions | 频率由管理员 profile 给定；429、挑战页、CAPTCHA 和权限错误停止。 |

MCP 官方授权规范指出 stdio 实现应从环境获取凭据；HTTP 授权令牌不得在 URL 中传递，且上游 API 令牌不能与 MCP 客户端令牌混用。参见 [MCP Authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)。

## 2. 目录与模块边界

```text
src/
  config/
    load-config.ts              # 读取、验证、解析不含秘密的配置
    config.schema.ts
  domain/
    ticket.ts                   # CanonicalTicket、分类、manifest 类型
    errors.ts                   # 可序列化错误码
  application/
    get-ticket.ts               # 读取→标准化→脱敏
    export-ticket.ts            # plan/write、哈希、幂等决策
    classify-ticket.ts          # 显式规则，不调用模型
  infrastructure/
    sources/source.ts           # TicketSource 端口
    sources/ones-api-source.ts  # 仅按验证后的 OnesApiContract 请求
    sources/ones-graphql-source.ts # 固定、只读、租户特定的 GraphQL 契约
    sources/import-source.ts    # JSON/CSV/Markdown 导入 fixture/人工导出
    secrets/secret-provider.ts
    secrets/env-secret-provider.ts
    storage/local-ticket-writer.ts
    storage/path-policy.ts
    http/rate-limited-client.ts
    observability/redacting-logger.ts
  mcp/
    tools/connection-status.ts
    tools/ticket-get.ts
    tools/ticket-export.ts
    schemas.ts
  server.ts
tests/
  fixtures/
  unit/
  integration/
```

依赖方向只能从 `mcp`、`infrastructure` 指向 `application`/`domain`；`domain` 不导入 SDK、文件系统、HTTP 或环境变量。

## 3. 核心 TypeScript 契约

```ts
export type TicketClass = "bugfix" | "feature" | "technical-change" | "unclassified";
export type SourceKind = "api" | "graphql" | "import";

export interface TicketReference {
  profile: string;
  key?: string;
  url?: string;
}

export interface CanonicalTicket {
  schemaVersion: "1.0";
  source: {
    provider: "ones";
    product: "project" | "desk" | "unknown";
    tenantBaseUrl: string;
    ticketId: string;
    ticketKey?: string;
    url: string;
    fetchedAt: string;
    connector: SourceKind;
  };
  classification: { value: TicketClass; matchedRule?: string; sourceValue?: string };
  title: string;
  descriptionMarkdown?: string;
  acceptanceCriteria?: string[];
  status?: string;
  priority?: string;
  labels: string[];
  assignee?: { displayName?: string; id?: string };
  reporter?: { displayName?: string; id?: string };
  createdAt?: string;
  updatedAt?: string;
  comments?: Array<{ id: string; author?: string; bodyMarkdown: string; createdAt?: string; sourceFormat?: "markdown" | "html" | "rich-text" }>;
  attachments?: Array<{ id: string; name: string; url?: string; mediaType?: string; sizeBytes?: number }>;
  relations?: Array<{ type: string; targetKey?: string; url?: string }>;
}

export interface SourceTicket {
  raw: unknown;
  source: CanonicalTicket["source"];
}

export interface TicketSource {
  readonly kind: SourceKind;
  getTicket(reference: TicketReference, options: { includeComments: boolean; includeAttachmentMetadata: boolean }): Promise<SourceTicket>;
  status(profile: string): Promise<{ authorized: boolean; scopes?: string[]; diagnostics: string[] }>;
}

export interface SecretProvider {
  resolve(reference: string): Promise<string>;
}
```

`normalizeOnesTicket(sourceTicket, profile)` 是唯一允许将供应商字段转入 `CanonicalTicket` 的位置。任何不在配置映射中的字段不进入标准结果；如需保存原始来源，必须经过 `RawCapturePolicy` 审批并写到受限的 `source.json`。

## 4. 配置与秘密

当前通用配置入口为项目根的 `clawer-ticket.config.json`，其路径可由 `CLAWER_TICKET_CONFIG_PATH` 覆盖；`ONES_MCP_CONFIG_PATH` 仅为既有 ONES 部署兼容保留。配置文件不得包含秘密值。

```json
{
  "schemaVersion": "1.0",
  "storage": {
    "root": "D:/ones-exports",
    "retainRawSource": false,
    "redaction": { "omitPeople": false, "removeFields": ["phone", "email"] }
  },
  "profiles": {
    "ones-readonly": {
      "source": "graphql",
      "product": "project",
      "baseUrl": "https://tenant.example.com",
      "allowedHosts": ["tenant.example.com"],
      "allowedProjects": ["PROJECT"],
      "secretRef": "ONES_READONLY_TOKEN",
      "requestBudget": { "maxConcurrent": 1, "maxRequestsPerMinute": 20 },
      "classificationRules": [
        { "name": "bug-type", "field": "type", "equals": "缺陷", "class": "bugfix" },
        { "name": "feature-type", "field": "type", "equals": "需求", "class": "feature" },
        { "name": "tech-label", "field": "labels", "includes": "技术改造", "class": "technical-change" }
      ],
      "apiContract": {
        "ticketUrlTemplate": "/REPLACE_WITH_AUTHORIZED_ENDPOINT/{ticketKey}",
        "authentication": "bearer",
        "responseMapping": "REPLACE_WITH_VALIDATED_MAPPING"
      }
    }
  }
}
```

`ticketUrlTemplate` 和 `responseMapping` 中的占位符是硬门禁：加载配置时不得发起 API 请求，直到管理员用经过验证的接口契约替换它们。`graphql` profile 另需设置内置的、版本化的 `contractId`、允许的 team/project 标识和允许认证方式；不得把 GraphQL 文本、Cookie、任意 Header 或端点 URL 暴露为 MCP 工具输入。

首期 `SecretProvider` 只实现：

- `EnvSecretProvider`：读取 `secretRef` 同名的环境变量；只在进程内短暂保存。
- `MissingSecretProvider`：返回 `SECRET_UNAVAILABLE`，用于测试及无凭据启动。

Windows Credential Manager 可作为后续适配器；不得为了它把密码改为 MCP 参数。stdio 部署依据 MCP 授权规范使用进程环境注入上游凭据。

## 5. MCP 工具契约

所有工具都接受 `profile`，不得接受 `password`、`token`、`cookie`、`otp`、`captcha` 或任意可自定义的 HTTP URL。

### `ticket_connection_status`

输入：`{ profile: string }`。

输出：`{ profile, source, authorized, diagnostics, allowedProjects }`。`diagnostics` 仅包含错误码与可操作说明，不含请求头、URL query 或秘密。

### `ticket_get`

输入：

```json
{
  "profile": "ones-readonly",
  "ticket": { "key": "PROJECT-123" },
  "include": { "comments": false, "attachmentMetadata": false }
}
```

输出为受 profile 脱敏策略处理后的 `CanonicalTicket` 摘要；正文超过 `maxInlineChars` 时给出截断标志而不是无界输出。

### `ticket_export`

输入：

```json
{
  "profile": "ones-readonly",
  "ticket": { "key": "PROJECT-123" },
  "mode": "plan",
  "include": { "comments": false, "attachments": "none" }
}
```

`mode=plan` 返回目标目录、将生成的文件、当前/新 hash 与风险提示。`mode=write` 只写入 profile 固定的 `storage.root`，并返回：

```json
{
  "status": "created | updated | unchanged",
  "exportId": "uuid",
  "ticketKey": "PROJECT-123",
  "directory": "D:/ones-exports/ones/PROJECT/PROJECT-123",
  "files": [{ "path": "ticket.md", "sha256": "..." }],
  "warnings": []
}
```

### `ones_export_status`

首期导出是同步操作，返回已完成结果；该工具预留给后续附件或批量任务，不在第一期注册，避免伪造异步能力。

## 6. 读取、限流与错误策略

1. 先校验 profile、ticket key 格式、allowed host/project，再解析 secret。
2. `OnesApiSource` 和 `OnesGraphqlSource` 仅发送已验证契约所定义的请求；URL、GraphQL operation、team/project 和字段集合均由 profile 固定，拒绝重定向至 allowlist 外 host。
3. 请求器使用 profile 指定的请求预算；本次调用最多一个在途读取。429 按 `Retry-After`，无该头时只在剩余预算内做有限退避。
4. 401/403、CAPTCHA、MFA、挑战页、未知响应模式、allowlist 失败均立即停止，不降级到抓页面或探测替代端点。

错误码：

| 代码 | 含义 | 调用方动作 |
| --- | --- | --- |
| `PROFILE_NOT_FOUND` | profile 不存在 | 修正配置 |
| `PROFILE_REQUIRED` | 配置多个 profile 但调用未指定 | 明确指定一个 profile |
| `CONTRACT_UNCONFIGURED` | OnES 接口契约仍是占位符 | 由管理员提供已验证文档/样本 |
| `SECRET_UNAVAILABLE` | 本机未注入凭据 | 本机安全设置环境变量/密钥库 |
| `SOURCE_UNAUTHORIZED` | 401/403 | 让管理员检查只读权限 |
| `SOURCE_RATE_LIMITED` | 429/预算耗尽 | 等待后重试，不提高频率 |
| `HUMAN_ACTION_REQUIRED` | MFA/CAPTCHA/挑战 | 用户在来源系统中处理；MCP 不绕过 |
| `SOURCE_SCHEMA_CHANGED` | 映射无法匹配 | 更新经过验证的 contract |
| `EXPORT_ROOT_DENIED` | 路径逃逸/不在根目录 | 修正配置 |

## 7. 标准化、落盘和隐私

路径规则：

```text
<storage.root>/ones/<sanitized-project>/<sanitized-ticket-key>/
  ticket.md
  ticket.json
  comments.json            # 富文本原样结构经脱敏后保存；Markdown 只渲染安全子集
  relations.json           # 父/子/关联工作项
  attachments/manifest.json # 默认只保存名称、类型、大小、来源标识
  manifest.json
  source.json             # 仅 retainRawSource=true 且通过脱敏策略
  attachments/            # 仅 include.attachments="download"，第二期实现
```

- 使用稳定序列化后的 `CanonicalTicket` 计算 SHA-256；`fetchedAt` 不参与内容 hash。
- 写入在同一目录创建临时文件、fsync 后 rename；任一步失败应删除临时文件，保留上个完整版本。
- `manifest.json` 至少包含 schema version、来源标识、fetch time、content hash、connector、脱敏策略版本、文件 hash 和 export id。
- Markdown 仅由 canonical 字段渲染，不执行 HTML/脚本；评论中的链接以普通链接文本保存，贴图保留受控引用而不执行或内联远程内容；附件名称须清理路径分隔符。
- profile 的 `redaction` 在生成 JSON、Markdown、source capture 和 MCP 工具结果之前生效。

## 8. 成本、速度和观测

| 路径 | 上游请求 | LLM token | 速度/稳定性 | 首期结论 |
| --- | --- | --- | --- | --- |
| 已授权 API/导出 | 单工单按需 | 0 | 最优 | 实现 |
| 已授权固定 GraphQL | 分页索引 + 单工单详情 | 0 | 快，但受私有契约变化影响 | 条件实现 |
| 人工导出文件导入 | 0 | 0 | 自动化低、合规性高 | 实现 |
| 浏览器本地桥接 | 页面读取 | 0 | 较慢且脆弱 | 延后 |
| 可选 LLM 摘要 | 读取后额外调用 | 可配置 | 不影响采集 | 延后 |

日志仅记录 `exportId`、profile、ticket key 的 hash、来源类型、耗时、结果码、字节数和重试次数。不得记录正文、请求头、Cookie、token 或 `source.json`。

## 9. 测试与验收

- 单元：配置占位符拒绝、secret 不泄露、分类规则、路径清理、hash 稳定性、脱敏、Markdown 渲染。
- 集成：用 `ImportTicketSource` fixture 运行 `get → plan → write → unchanged`；断言文件清单及 manifest。
- HTTP fake：401、403、429 + Retry-After、5xx、未知 schema、外部重定向均产生预期错误且没有绕过请求。
- MCP：内存传输发现四个首期工具（其中状态/获取/导出三项实际注册），验证 Zod 输入拒绝秘密字段和任意 URL。
- 真实 OnES：仅在管理员授权的 sandbox/测试工单上运行一次 contract test；GraphQL 适配器需分别验证索引、详情、评论和附件元数据契约；不得将真实响应、请求头或凭据提交到仓库。

## 10. 实施前输入清单

开始 `OnesApiSource` 或 `OnesGraphqlSource` 之前，必须取得：目标产品、可解析的脱敏工单样本、已授权接口/导出文档或被批准的 GraphQL 契约、只读机器凭据、租户 base URL 与 host/team/project allowlist、字段/项目分类规则、数据保留和附件政策。对于 GraphQL，另需验证当前列表筛选不会漏掉需要的状态/负责人范围，以及详情、评论、附件元数据的独立请求契约。缺任一项时仍可实现其余框架与导入连接器，但不得宣称已支持真实 OnES 在线读取。
