export type TicketErrorCode =
  | "PROFILE_NOT_FOUND"
  | "CONFIG_INVALID"
  | "SECRET_UNAVAILABLE"
  | "SOURCE_UNAUTHORIZED"
  | "SOURCE_RATE_LIMITED"
  | "HUMAN_ACTION_REQUIRED"
  | "SOURCE_SCHEMA_CHANGED"
  | "SOURCE_INCOMPLETE"
  | "SOURCE_NOT_ALLOWED"
  | "SOURCE_FAILED"
  | "EXPORT_ROOT_DENIED"
  | "PROVIDER_NOT_AVAILABLE";

/** 工单用例与 MCP 结果映射对外暴露的 provider 无关错误。 */
export class TicketError extends Error {
  /** 创建带稳定错误码且与 provider 无关的领域错误。 */
  constructor(public readonly code: TicketErrorCode, message: string) {
    super(message);
    this.name = "TicketError";
  }
}
