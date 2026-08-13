import { TicketError } from "../modules/tickets/domain/ticket-error.js";
import { TicketProfile, TicketProfileResolver } from "../modules/tickets/domain/ports.js";

/** 将受控本地配置中的 provider 无关字段投影为内存对象。 */
export class StaticTicketProfileResolver implements TicketProfileResolver {
  private readonly profiles: Map<string, TicketProfile>;

  /** 建立不可重复的受控 profile 索引，供应用层按名称解析。 */
  constructor(profiles: TicketProfile[]) {
    this.profiles = new Map(profiles.map((profile) => [profile.name, Object.freeze({ ...profile, maxConcurrent: profile.maxConcurrent ?? 1, allowedProjects: [...profile.allowedProjects] })]));
    if (this.profiles.size !== profiles.length) throw new TicketError("CONFIG_INVALID", "Ticket profile names must be unique");
  }

  /** 获取指定 profile；名称不存在时返回统一的领域错误。 */
  get(name: string): TicketProfile {
    const profile = this.profiles.get(name);
    if (!profile) throw new TicketError("PROFILE_NOT_FOUND", `Profile ${name} was not found`);
    return profile;
  }

  /**
   * 调用方显式选择时保持既有行为；只有一个受控 profile 时才允许省略名称。
   * 多 profile 场景绝不依赖声明顺序，也不猜测当前应使用的租户。
   */
  resolve(name?: string): TicketProfile {
    if (name) return this.get(name);
    if (this.profiles.size === 1) return this.profiles.values().next().value!;
    if (this.profiles.size === 0) throw new TicketError("CONFIG_INVALID", "At least one ticket profile is required");
    throw new TicketError("PROFILE_REQUIRED", `Multiple ticket profiles are configured; specify profile (${[...this.profiles.keys()].join(", ")})`);
  }
}
