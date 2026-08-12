# 12 · 基础设施层

> 源文件：[src/infrastructure/http/fetch-http-client.ts](../src/infrastructure/http/fetch-http-client.ts)、[src/infrastructure/security/env-secret-provider.ts](../src/infrastructure/security/env-secret-provider.ts)、[src/config/static-ticket-profile-resolver.ts](../src/config/static-ticket-profile-resolver.ts)。

## 1. HTTP 客户端

### 1.1 接口与实现

```ts
export interface HttpRequest {
  url: URL;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  headers: Headers;
  text: string;
}

export interface HttpClient {
  request(request: HttpRequest): Promise<HttpResponse>;
}

export class FetchHttpClient implements HttpClient {
  async request(request: HttpRequest): Promise<HttpResponse> {
    const response = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body, redirect: "manual" });
    return { status: response.status, headers: response.headers, text: await response.text() };
  }
}
```

- **`redirect: "manual"`**：不跟随服务端控制的跳转，以免访问 profile allowlist 之外的主机。
- 只支持 `GET` / `POST`（ONES 当前只需要这两种）。
- 返回原始 `status` / `headers` / `text`，由上层 `parseJsonResponse` 解析。

### 1.2 `parseJsonResponse(response)`

```ts
export function parseJsonResponse(response: HttpResponse): unknown {
  if (response.status === 401 || response.status === 403) throw new TicketError("SOURCE_UNAUTHORIZED", `Source returned ${response.status}`);
  if (response.status === 429) throw new TicketError("SOURCE_RATE_LIMITED", "Source rate limit reached");
  if (response.status < 200 || response.status >= 300) throw new TicketError("SOURCE_FAILED", `Source returned ${response.status}`);
  if (/captcha|challenge|mfa/i.test(response.text)) throw new TicketError("HUMAN_ACTION_REQUIRED", "Source requires human authentication action");
  if (!response.headers.get("content-type")?.toLocaleLowerCase().includes("application/json")) {
    throw new TicketError("SOURCE_SCHEMA_CHANGED", "Source response is not JSON");
  }
  try {
    return JSON.parse(response.text) as unknown;
  } catch {
    throw new TicketError("SOURCE_SCHEMA_CHANGED", "Source did not return JSON matching the configured contract");
  }
}
```

详见 [10-security-redaction.md §4](./10-security-redaction.md) 与 [11-error-handling.md §2](./11-error-handling.md)。

### 1.3 使用点

- `OnesGraphqlSource` 构造时注入 `HttpClient`（默认 `FetchHttpClient`）。
- `requestJson` 调 `this.http.request(...)` → `parseJsonResponse`。
- Browser provider **不使用** `HttpClient`（用 `page.evaluate` 同源 fetch），但仍用 `parseJsonResponse` 解析响应。

## 2. 密钥 Provider

### 2.1 接口与实现

```ts
export interface SecretProvider {
  resolve(reference: string): Promise<string>;
}

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
- **未来可扩展**：实现 `SecretProvider` 接入 Vault / AWS Secrets Manager / k8s secrets 等，只需在 `bootstrap` 替换注入。

### 2.2 使用点

- `OnesGraphqlSource` 构造时注入 `SecretProvider`（默认 `EnvSecretProvider`）。
- `resolveToken(profile)` 调 `this.secrets.resolve(profile.secretRef!)`。
- Browser provider **不使用** `SecretProvider`（基于会话认证，构造时 `super(config)` 不传 secrets）。

## 3. Profile Resolver

### 3.1 `StaticTicketProfileResolver`

```ts
export class StaticTicketProfileResolver implements TicketProfileResolver {
  private readonly profiles: Map<string, TicketProfile>;

  constructor(profiles: TicketProfile[]) {
    this.profiles = new Map(profiles.map((profile) => [profile.name, Object.freeze({ ...profile, allowedProjects: [...profile.allowedProjects] })]));
    if (this.profiles.size !== profiles.length) throw new TicketError("CONFIG_INVALID", "Ticket profile names must be unique");
  }

  get(name: string): TicketProfile {
    const profile = this.profiles.get(name);
    if (!profile) throw new TicketError("PROFILE_NOT_FOUND", `Profile ${name} was not found`);
    return profile;
  }

  resolve(name?: string): TicketProfile {
    if (name) return this.get(name);
    if (this.profiles.size === 1) return this.profiles.values().next().value!;
    if (this.profiles.size === 0) throw new TicketError("CONFIG_INVALID", "At least one ticket profile is required");
    throw new TicketError("PROFILE_REQUIRED", `Multiple ticket profiles are configured; specify profile (${[...this.profiles.keys()].join(", ")})`);
  }
}
```

- 把受控本地配置中的 provider 无关字段投影为内存对象。
- 构造时校验名称唯一性，重复抛 `CONFIG_INVALID`。
- 每个 profile `Object.freeze`，`allowedProjects` 复制为新数组，防止外部修改。
- `get(name)` 不存在抛 `PROFILE_NOT_FOUND`。
- `resolve()` 仅在配置唯一 profile 时允许省略名称；多 profile 时抛 `PROFILE_REQUIRED`，不依赖配置顺序。

### 3.2 装配

`bootstrap/create-server.ts` 的 `ticketProfiles(config)`：

```ts
function ticketProfiles(config: Awaited<ReturnType<typeof loadConfig>>) {
  return new StaticTicketProfileResolver(
    Object.entries(config.profiles).map(([name, profile]) => ({
      name,
      providerId: profile.provider,
      connector: profile.source,
      allowedProjects: profile.allowedProjects,
      inlineMaxChars: profile.inlineMaxChars,
    })),
  );
}
```

- 从 ONES 专属配置提取应用层可识别的通用 profile 信息。
- **只投影与 provider 无关的字段**：`name` / `providerId` / `connector` / `allowedProjects` / `inlineMaxChars`。
- ONES 特有字段（`baseUrl` / `teamId` / `secretRef` / `browser` 等）留在 `OnesConfig` 内，由 provider 自己通过 `profileFor(ticketProfile)` 反查。

## 4. 与端口的对应

| 端口 | 实现 | 备注 |
| --- | --- | --- |
| `HttpClient` | `FetchHttpClient` | 可替换为 mock 测试 |
| `SecretProvider` | `EnvSecretProvider` | 可替换为 Vault 等 |
| `TicketProfileResolver` | `StaticTicketProfileResolver` | 可替换为动态配置中心 |
| `TicketBundleStore` | `LocalTicketBundleStore` | 可替换为对象存储适配器 |
| `TicketProvider` | `OnesGraphqlSource` / `OnesBrowserSource` | ONES 专属 |
| `TicketMediaProvider` | 同上 | ONES 专属 |
| `BrowserSessionProvider` | `OnesBrowserSource` | ONES 专属 |

## 5. 测试可替换性

- `HttpClient` / `SecretProvider` / `TicketApplicationDependencies` 都通过构造注入，测试可传 fake：
  - `test/mcp/ticket-tools.test.ts` 用 in-memory `TicketProvider` / `TicketBundleStore`。
  - `test/integration/providers/ones/ones-provider.test.ts` 用 fake HTTP（具体见该文件）。
- 这是 Ports & Adapters 架构的核心收益：单测一个用例时替换端口实现，不需要模拟 MCP Server 或 ONES HTTP。

## 6. 不变量

- `FetchHttpClient` 永远 `redirect: "manual"`。
- `EnvSecretProvider` 永远从 `process.env` 读，不接受空值。
- `StaticTicketProfileResolver` 构造后 profile 不可变（`Object.freeze`）。
- 所有基础设施实现都抛 `TicketError`，不抛厂商异常。
