# 07 · 配置与密钥

> 源文件：[src/providers/ones/ones-config.ts](../src/providers/ones/ones-config.ts)、[src/infrastructure/security/env-secret-provider.ts](../src/infrastructure/security/env-secret-provider.ts)、`config/clawer-ticket.config.*.example.json`。

## 1. 配置文件定位

- 路径环境变量（按优先级）：
  1. `CLAWER_TICKET_CONFIG_PATH`（推荐）
  2. `ONES_MCP_CONFIG_PATH`（兼容现有 ONES 部署）
  3. 默认 `clawer-ticket.config.json`
- 由 `loadConfig(configPath?)` 读取，`resolve()` 成绝对路径后 `readFile` + `JSON.parse` + `parseConfig`。
- 配置文件应放在**本机受控位置**，被 Git 忽略；不要提交、不要复制到工具参数或日志。

## 2. 顶层 schema

```ts
const configSchema = z.object({
  schemaVersion: z.literal("1.0"),
  storage: z.object({
    root: z.string().min(1),
    retainRawSource: z.literal(false).default(false),
    redaction: z.object({
      omitPeople: z.boolean().default(false),
      removeFields: z.array(z.string()).default(["phone", "email"]),
    }).default({ omitPeople: false, removeFields: ["phone", "email"] }),
  }).strict(),
  profiles: z.record(z.string().min(1), profileSchema).refine((profiles) => Object.keys(profiles).length > 0, "At least one profile is required"),
}).strict();
```

- `schemaVersion` 恒为 `"1.0"`。
- `storage.root`：导出根目录，所有 bundle 写入此边界内。
- `storage.retainRawSource`：恒为 `false`（保留字段，目前不允许 true）。
- `storage.redaction`：脱敏策略，详见 [10-security-redaction.md](./10-security-redaction.md)。
- `profiles`：至少一个 profile；key 是 profile 名称。

## 3. Profile schema

```ts
const profileSchema = z.object({
  provider: z.literal("ones").default("ones"),
  source: z.enum(["graphql", "browser"]),
  product: z.literal("project"),
  baseUrl: z.url(),
  teamId: z.string().min(1),
  allowedHosts: z.array(z.string().min(1)).min(1),
  allowedProjects: z.array(z.string().min(1)).default([]),
  listAssigneeFieldId: z.string().min(1).optional(),
  secretRef: z.string().min(1).optional(),
  authentication: z.object({
    headerName: z.literal("Authorization").default("Authorization"),
    scheme: z.enum(["Bearer", "raw"]).default("Bearer"),
  }).default({ headerName: "Authorization", scheme: "Bearer" }),
  requestBudget: z.object({
    maxConcurrent: z.literal(1).default(1),
    maxRequestsPerMinute: z.number().int().min(1).max(120).default(20),
  }).default({ maxConcurrent: 1, maxRequestsPerMinute: 20 }),
  defaultView: z.literal("my_open_tree").default("my_open_tree"),
  inlineMaxChars: z.number().int().min(1_000).max(100_000).default(12_000),
  classificationRules: z.array(classificationRuleSchema).default([]),
  browser: z.object({
    executablePath: z.string().min(1).optional(),
    myOpenViewUrl: z.url().optional(),
    autoLogin: z.object({
      email: z.string().email(),
      password: z.string().min(1),
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
```

### 3.1 字段含义

| 字段 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `provider` | 是 | `"ones"` | 受控选择，目前只能 `ones` |
| `source` | 是 | — | `graphql` 或 `browser` |
| `product` | 是 | — | 目前只能 `project` |
| `baseUrl` | 是 | — | ONES 租户基址，host 必须在 `allowedHosts` |
| `teamId` | 是 | — | ONES 团队 ID |
| `allowedHosts` | 是 | — | 出站请求 host 白名单，至少 1 个 |
| `allowedProjects` | 否 | `[]` | 项目 UUID 白名单；空数组表示该 team 内不限制 |
| `listAssigneeFieldId` | 否 | — | 租户字段 UUID，未配置时列表不猜测负责人字段 |
| `secretRef` | graphql 必填 | — | 环境变量名（或密钥存储条目），如 `ONES_READ_TOKEN` |
| `authentication` | 否 | `{ headerName: "Authorization", scheme: "Bearer" }` | 认证头名与 scheme |
| `requestBudget` | 否 | `{ maxConcurrent: 1, maxRequestsPerMinute: 20 }` | 限流预算 |
| `defaultView` | 否 | `"my_open_tree"` | 唯一支持的视图 |
| `inlineMaxChars` | 否 | `12_000` | `ticket_get` 内联响应字符预算，[1000, 100000] |
| `classificationRules` | 否 | `[]` | 工单分类规则 |
| `browser` | browser 可选 | — | 浏览器配置 |

### 3.2 `browser` 子字段

| 字段 | 说明 |
| --- | --- |
| `executablePath` | Chrome 路径；未配置时按 `ONES_BROWSER_EXECUTABLE_PATH` 环境变量 → 默认路径查找 |
| `myOpenViewUrl` | 受控 ONES 筛选视图 URL，仅用于校准浏览器可见工单行；host 必须在 `allowedHosts` |
| `autoLogin.email` | 直登邮箱 |
| `autoLogin.password` | 直登密码 |
| `autoLogin.loginUrl` | 可选直登页 URL；未填写时由 `baseUrl` 推导为 `/login`，显式填写时 host 必须在 `allowedHosts` |

### 3.3 `classificationRules` 子 schema

```ts
const classificationRuleSchema = z.object({
  name: z.string().min(1),
  field: z.enum(["issueType", "subIssueType", "importantField"]),
  equals: z.string().min(1),
  class: z.enum(["bugfix", "feature", "technical-change"]),
  fieldId: z.string().min(1).optional(),
}).strict();
```

- `field`：
  - `issueType`：用 `detail.issueType.name` 比较。
  - `subIssueType`：用 `detail.subIssueType.name` 比较。
  - `importantField`：用 `customFields` 中 `id === rule.fieldId` 的 `value` 比较（`fieldId` 必填）。
- `equals`：相等匹配（精确字符串）。
- `class`：匹配后赋的类。
- 规则按数组顺序匹配，首个命中即停止；未命中 → `unclassified`。

## 4. host allowlist 校验

`parseConfig` 在 zod 校验后额外检查：
```ts
for (const profile of Object.values(result.data.profiles)) {
  const host = new URL(profile.baseUrl).host;
  if (!profile.allowedHosts.includes(host)) throw new TicketError("CONFIG_INVALID", `baseUrl host ${host} is not in allowedHosts`);
  if (profile.browser?.myOpenViewUrl && !profile.allowedHosts.includes(new URL(profile.browser.myOpenViewUrl).host)) throw new TicketError("CONFIG_INVALID", "browser.myOpenViewUrl host is not in allowedHosts");
  if (profile.browser?.autoLogin?.loginUrl && !profile.allowedHosts.includes(new URL(profile.browser.autoLogin.loginUrl).host)) throw new TicketError("CONFIG_INVALID", "browser.autoLogin.loginUrl host is not in allowedHosts");
}
```

- `baseUrl` host、`myOpenViewUrl` host、`autoLogin.loginUrl` host 都必须在 `allowedHosts`。
- 运行时每个出站请求（含附件解析出的临时 URL）都会再次校验 host。

## 5. 密钥管理

### 5.1 `SecretProvider` 接口

```ts
export interface SecretProvider {
  resolve(reference: string): Promise<string>;
}
```

### 5.2 `EnvSecretProvider`

```ts
export class EnvSecretProvider implements SecretProvider {
  async resolve(reference: string): Promise<string> {
    const value = process.env[reference];
    if (!value) throw new TicketError("SECRET_UNAVAILABLE", `Secret ${reference} is unavailable in this process environment`);
    return value;
  }
}
```

- 从启动 MCP 的进程环境读取受控密钥引用。
- 空值抛 `SECRET_UNAVAILABLE`。
- **不支持在 JSON 配置中直接填写 `token`**——这是设计取舍，避免凭据落盘到配置文件。
- 未来可扩展密钥库适配器（如 Vault），只需实现 `SecretProvider`。

### 5.3 凭据使用

- `OnesGraphqlSource.resolveToken(profile)` 调 `this.secrets.resolve(profile.secretRef!)`。
- `requestJson` / `downloadResolvedAttachment` 把 token 放入 `Authorization` 头：
  - `scheme: "Bearer"` → `Bearer <token>`
  - `scheme: "raw"` → `<token>`（少数 ONES 部署可能需要）
- **绝不**把凭据写入 MCP 工具参数、日志或导出物。

## 6. 示例配置

- `config/clawer-ticket.config.browser.example.json`：可独立复制的 browser 直登模板；替换本机邮箱、密码和其他占位值后可直接运行。
- `config/clawer-ticket.config.graphql.example.json`：可独立复制的 GraphQL 最小模板；`secretRef` 指向启动进程环境中的只读机器凭据。
- `config/clawer-ticket.config.example.json`：同时包含两种 profile 的完整参考模板，展示每种接入方式全部实际生效的字段与可替换占位值。

三份模板都会在测试中使用运行时 `parseConfig` 校验。公开模板中的登录字段是可通过 schema 的假值占位符，不是可用凭据；复制后的本机配置必须替换它们。完整参考模板展示可选的 `listAssigneeFieldId`、限流、分类和 browser 扩展项；不需要时可以删除这些字段并使用运行时默认值。

## 7. MCP 客户端配置示例

```json
{
  "mcpServers": {
    "clawer-ticket": {
      "command": "npx",
      "args": ["-y", "@carry-dream/clawer-ticket-server@1.0.0"],
      "env": {
        "CLAWER_TICKET_CONFIG_PATH": "D:/secure/clawer-ticket.config.json",
        "ONES_READ_TOKEN": "<管理员批准的只读机器 token>"
      }
    }
  }
}
```

- GraphQL profile：`env` 里同时放配置路径与 `secretRef` 指向的 token。
- Browser profile：不需要 token；`autoLogin` 凭据放在被 Git 忽略的配置文件中。

## 8. 配置错误处理

- zod 校验失败 → `CONFIG_INVALID`，错误信息列出所有 issue 的 path。
- host allowlist 校验失败 → `CONFIG_INVALID`。
- 文件读取失败 → `CONFIG_INVALID`（`Unable to read configuration at <path>: <reason>`）。
- profile 不存在 → `PROFILE_NOT_FOUND`（由 `getProfile` 抛）。

## 9. 重要约束

- **provider 只能由受控 profile 选择，不能由 MCP 工具参数指定**。
- **不支持在 JSON 配置中直接填写 `token`**，只能通过 `secretRef` 引用环境变量。
- **凭据绝不能写入 MCP 工具参数或日志**。
- `allowedProjects` 应填入获批项目 UUID；只有空数组才表示该 team 内不限制项目。
- `listAssigneeFieldId` 是可选的租户字段 UUID，未配置时列表不会猜测负责人字段。
- `inlineMaxChars` 限制 `ticket_get` 的描述与评论正文输出；完整内容应使用导出工具保存到本地。
- `browser.autoLogin` 只能存放于本地且被 Git 忽略的配置文件。
- 配置 `browser.autoLogin` 时必须设置 `email` 和 `password`；`loginUrl` 可选，未设置时由 `baseUrl` 推导为 `/login`。该配置只允许保存在本地且受 Git 忽略的文件中。
