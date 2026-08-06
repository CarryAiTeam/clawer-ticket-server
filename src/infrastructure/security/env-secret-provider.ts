import { TicketError } from "../../modules/tickets/domain/ticket-error.js";

export interface SecretProvider {
  resolve(reference: string): Promise<string>;
}

export class EnvSecretProvider implements SecretProvider {
  /** 从启动进程环境读取已批准的密钥引用，不返回空值。 */
  async resolve(reference: string): Promise<string> {
    const value = process.env[reference];
    if (!value) throw new TicketError("SECRET_UNAVAILABLE", `Secret ${reference} is unavailable in this process environment`);
    return value;
  }
}
