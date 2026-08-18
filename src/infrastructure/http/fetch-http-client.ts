import { TicketError } from "../../modules/tickets/domain/ticket-error.js";

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
  /** 以禁止自动重定向的方式执行受控 HTTP 请求。 */
  async request(request: HttpRequest): Promise<HttpResponse> {
    // 不跟随服务端控制的跳转，以免访问 profile allowlist 之外的主机。
    const response = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body, redirect: "manual" });
    return { status: response.status, headers: response.headers, text: await response.text() };
  }
}

/** 校验通用 JSON 响应，并映射为可由上层处理的领域错误。 */
export function parseJsonResponse(response: HttpResponse): unknown {
  const isJson = response.headers.get("content-type")?.toLocaleLowerCase().includes("application/json") ?? false;
  // HTTP status alone cannot establish that an interactive authentication step exists.
  // A non-JSON challenge page is the controlled evidence needed for that classification.
  if (!isJson && /captcha|challenge|mfa|sso/i.test(response.text)) {
    throw new TicketError("HUMAN_ACTION_REQUIRED", "Source requires human authentication action");
  }
  if (response.status === 401 || response.status === 403) throw new TicketError("SOURCE_UNAUTHORIZED", `Source returned ${response.status}`);
  if (response.status === 429) throw new TicketError("SOURCE_RATE_LIMITED", "Source rate limit reached");
  if (response.status < 200 || response.status >= 300) throw new TicketError("SOURCE_FAILED", `Source returned ${response.status}`);
  if (!isJson) {
    throw new TicketError("SOURCE_SCHEMA_CHANGED", "Source response is not JSON");
  }
  try {
    return JSON.parse(response.text) as unknown;
  } catch {
    throw new TicketError("SOURCE_SCHEMA_CHANGED", "Source did not return JSON matching the configured contract");
  }
}
