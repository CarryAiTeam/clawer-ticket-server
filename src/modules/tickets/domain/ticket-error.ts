export type TicketErrorCode =
  | "PROFILE_NOT_FOUND"
  | "PROFILE_REQUIRED"
  | "CONFIG_INVALID"
  | "SECRET_UNAVAILABLE"
  | "SOURCE_UNAUTHORIZED"
  | "AUTHORIZATION_PENDING"
  | "SOURCE_RATE_LIMITED"
  | "HUMAN_ACTION_REQUIRED"
  | "SOURCE_SCHEMA_CHANGED"
  | "SOURCE_INCOMPLETE"
  | "SOURCE_NOT_ALLOWED"
  | "SOURCE_FAILED"
  | "QUERY_INVALID"
  | "UNSUPPORTED_FILTER"
  | "QUERY_CURSOR_INVALID"
  | "SELECTION_CHANGED"
  | "EXPORT_LIMIT_EXCEEDED"
  | "EXPORT_ROOT_DENIED"
  | "PROVIDER_NOT_AVAILABLE"
  | "REQUEST_CANCELLED";

/** 仅允许把受控授权状态投影给 MCP；不得携带页面地址、Cookie 或原始来源响应。 */
export interface TicketErrorDetails {
  authorizationState?: "pending" | "manual-action-required";
  diagnostics?: string[];
}

/** 工单用例与 MCP 结果映射对外暴露的 provider 无关错误。 */
export class TicketError extends Error {
  /** 创建带稳定错误码且与 provider 无关的领域错误。 */
  constructor(public readonly code: TicketErrorCode, message: string, public readonly details?: TicketErrorDetails) {
    super(message);
    this.name = "TicketError";
  }
}
