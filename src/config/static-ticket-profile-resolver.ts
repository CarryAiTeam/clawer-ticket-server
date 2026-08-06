import { TicketError } from "../modules/tickets/domain/ticket-error.js";
import { TicketProfile, TicketProfileResolver } from "../modules/tickets/domain/ports.js";

/** 将受控本地配置中的 provider 无关字段投影为内存对象。 */
export class StaticTicketProfileResolver implements TicketProfileResolver {
  private readonly profiles: Map<string, TicketProfile>;

  /** 建立不可重复的受控 profile 索引，供应用层按名称解析。 */
  constructor(profiles: TicketProfile[]) {
    this.profiles = new Map(profiles.map((profile) => [profile.name, Object.freeze({ ...profile, allowedProjects: [...profile.allowedProjects] })]));
    if (this.profiles.size !== profiles.length) throw new TicketError("CONFIG_INVALID", "Ticket profile names must be unique");
  }

  /** 获取指定 profile；名称不存在时返回统一的领域错误。 */
  get(name: string): TicketProfile {
    const profile = this.profiles.get(name);
    if (!profile) throw new TicketError("PROFILE_NOT_FOUND", `Profile ${name} was not found`);
    return profile;
  }
}
