import { StaticTicketProfileResolver } from "../config/static-ticket-profile-resolver.js";
import { TicketApplication } from "../modules/tickets/application/ticket-application.js";
import { BrowserSessionProvider, TicketProvider } from "../modules/tickets/domain/ports.js";
import { LocalTicketBundleStore } from "../modules/tickets/infrastructure/export/local-ticket-bundle-store.js";
import { loadConfig } from "../providers/ones/ones-config.js";
import { OnesBrowserSource } from "../providers/ones/ones-browser-source.js";
import { createTicketMcpServer } from "../delivery/mcp/ticket-server.js";

export interface ServerOptions {
  application?: TicketApplication;
  configPath?: string;
}

/** 从 ONES 专属配置提取应用层可识别的通用 profile 信息。 */
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

/** 在组合根装配 Tickets 应用服务及其 ONES、本地存储依赖。 */
function createTicketApplication(config: Awaited<ReturnType<typeof loadConfig>>, provider: TicketProvider, browserSessions?: BrowserSessionProvider): TicketApplication {
  return new TicketApplication({
    profiles: ticketProfiles(config),
    provider,
    browserSessions,
    mediaProvider: provider as OnesBrowserSource,
    bundleStore: new LocalTicketBundleStore(config.storage.root),
    redaction: config.storage.redaction,
    exportLimits: config.storage.exportLimits,
  });
}

/** 创建 MCP 服务组合根；provider 只能由本地受控配置选择，不能由 MCP 输入指定。 */
export function createServer(options: ServerOptions = {}) {
  let application = options.application;
  return createTicketMcpServer({
    getApplication: async () => {
      if (!application) {
        const config = await loadConfig(options.configPath);
        const provider = new OnesBrowserSource(config);
        application = createTicketApplication(config, provider, provider);
      }
      return application;
    },
  });
}
