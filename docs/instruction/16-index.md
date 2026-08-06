# 16 · 文档索引

> 本目录是 clawer-ticket-server 项目的完整说明文档集。按以下顺序阅读可建立百分百理解。

## 阅读顺序

| # | 文件 | 内容 | 适合谁 |
| --- | --- | --- | --- |
| 00 | [00-overview.md](./00-overview.md) | 项目总览、定位、能力清单、技术栈、目录结构、核心设计约束 | 所有人，先读这篇 |
| 01 | [01-architecture.md](./01-architecture.md) | 架构选型、分层依赖方向、各层职责、入口与传输、配置加载链 | 想理解整体设计的人 |
| 02 | [02-domain-model.md](./02-domain-model.md) | `CanonicalTicket` / `InlineTicket` / `TicketIndexTree` / `TicketComment` / `TicketAttachment` 等领域契约 | 想理解数据模型的人 |
| 03 | [03-ports-interfaces.md](./03-ports-interfaces.md) | `TicketProvider` / `TicketMediaProvider` / `TicketBundleStore` / `BrowserSessionProvider` 等端口定义 | 想理解可替换边界的人 |
| 04 | [04-application-service.md](./04-application-service.md) | `TicketApplication` 用例编排、媒体计划、事务会话调度、内联裁剪算法 | 想理解业务流的人 |
| 05 | [05-mcp-tools.md](./05-mcp-tools.md) | 7 个 MCP 工具的入参/出参/行为/annotations 矩阵 | 想调用工具的人 |
| 06 | [06-ones-provider.md](./06-ones-provider.md) | `OnesGraphqlSource` / `OnesBrowserSource` / `normalizeOnesTicket` 的实现细节 | 想理解 ONES 适配的人 |
| 07 | [07-config-secrets.md](./07-config-secrets.md) | 配置 schema、host allowlist、`SecretProvider`、示例配置 | 想部署/配置的人 |
| 08 | [08-export-storage.md](./08-export-storage.md) | `LocalTicketBundleStore`、目录布局、事务会话、manifest、路径安全 | 想理解落盘的人 |
| 09 | [09-rate-limit-resume.md](./09-rate-limit-resume.md) | 串行队列、滑动窗口、429 退避重试、断点续传机制 | 想理解限流的人 |
| 10 | [10-security-redaction.md](./10-security-redaction.md) | 脱敏策略、富文本清洗、host allowlist、浏览器会话安全、凭据安全 | 想理解安全边界的人 |
| 11 | [11-error-handling.md](./11-error-handling.md) | 12 个错误码语义、触发点、MCP 错误映射、恢复建议 | 想理解错误处理的人 |
| 12 | [12-infrastructure.md](./12-infrastructure.md) | `FetchHttpClient` / `EnvSecretProvider` / `StaticTicketProfileResolver` | 想理解可替换基础设施的人 |
| 13 | [13-runtime-flow.md](./13-runtime-flow.md) | 启动、5 个典型工具调用、reconciliation、限流、错误传播的端到端时序 | 想理解运行时行为的人 |
| 14 | [14-build-test.md](./14-build-test.md) | tsconfig、package.json、脚本、测试结构、部署形态 | 想构建/测试/部署的人 |
| 15 | [15-use-cases.md](./15-use-cases.md) | 适用场景、不适用场景、5 种典型使用模式、演进方向、关键决策 | 想判断项目是否适合自己需求的人 |

## 按主题快速定位

### 我想理解…

- **项目是干什么的** → [00-overview.md](./00-overview.md)
- **为什么这样分层** → [01-architecture.md](./01-architecture.md)
- **工单数据长什么样** → [02-domain-model.md](./02-domain-model.md) §9 `CanonicalTicket`
- **有哪些工具能调** → [05-mcp-tools.md](./05-mcp-tools.md)
- **某个工具的入参出参** → [05-mcp-tools.md](./05-mcp-tools.md) 对应小节
- **如何配置 profile** → [07-config-secrets.md](./07-config-secrets.md)
- **如何处理 ONES 限流** → [09-rate-limit-resume.md](./09-rate-limit-resume.md)
- **导出物目录结构** → [08-export-storage.md](./08-export-storage.md) §1
- **断点续传怎么工作** → [09-rate-limit-resume.md](./09-rate-limit-resume.md) §5
- **某个错误码什么意思** → [11-error-handling.md](./11-error-handling.md) §2
- **浏览器 profile 怎么用** → [06-ones-provider.md](./06-ones-provider.md) §3 + [15-use-cases.md](./15-use-cases.md) §4.3
- **脱敏做了什么** → [10-security-redaction.md](./10-security-redaction.md) §2
- **临时附件 URL 会不会泄露** → [10-security-redaction.md](./10-security-redaction.md) §7.3
- **如何扩展第二个 provider** → [01-architecture.md](./01-architecture.md) §3.4 + [15-use-cases.md](./15-use-cases.md) §6
- **如何本地构建测试** → [14-build-test.md](./14-build-test.md)

## 源码索引

| 源文件 | 文档定位 |
| --- | --- |
| [src/index.ts](../src/index.ts) | [13-runtime-flow.md §1](./13-runtime-flow.md) |
| [src/server.ts](../src/server.ts) | [01-architecture.md §4](./01-architecture.md) |
| [src/bootstrap/create-server.ts](../src/bootstrap/create-server.ts) | [01-architecture.md §3.7](./01-architecture.md) |
| [src/config/static-ticket-profile-resolver.ts](../src/config/static-ticket-profile-resolver.ts) | [12-infrastructure.md §3](./12-infrastructure.md) |
| [src/delivery/mcp/ticket-server.ts](../src/delivery/mcp/ticket-server.ts) | [05-mcp-tools.md](./05-mcp-tools.md) |
| [src/infrastructure/http/fetch-http-client.ts](../src/infrastructure/http/fetch-http-client.ts) | [12-infrastructure.md §1](./12-infrastructure.md) |
| [src/infrastructure/security/env-secret-provider.ts](../src/infrastructure/security/env-secret-provider.ts) | [12-infrastructure.md §2](./12-infrastructure.md) |
| [src/modules/tickets/application/ticket-application.ts](../src/modules/tickets/application/ticket-application.ts) | [04-application-service.md](./04-application-service.md) |
| [src/modules/tickets/domain/ticket.ts](../src/modules/tickets/domain/ticket.ts) | [02-domain-model.md](./02-domain-model.md) |
| [src/modules/tickets/domain/ticket-error.ts](../src/modules/tickets/domain/ticket-error.ts) | [11-error-handling.md](./11-error-handling.md) |
| [src/modules/tickets/domain/ticket-policy.ts](../src/modules/tickets/domain/ticket-policy.ts) | [10-security-redaction.md §2](./10-security-redaction.md) |
| [src/modules/tickets/domain/ports.ts](../src/modules/tickets/domain/ports.ts) | [03-ports-interfaces.md](./03-ports-interfaces.md) |
| [src/modules/tickets/infrastructure/export/local-ticket-bundle-store.ts](../src/modules/tickets/infrastructure/export/local-ticket-bundle-store.ts) | [08-export-storage.md](./08-export-storage.md) |
| [src/providers/ones/ones-config.ts](../src/providers/ones/ones-config.ts) | [07-config-secrets.md](./07-config-secrets.md) |
| [src/providers/ones/ones-contracts.ts](../src/providers/ones/ones-contracts.ts) | [06-ones-provider.md §1](./06-ones-provider.md) |
| [src/providers/ones/ones-graphql-source.ts](../src/providers/ones/ones-graphql-source.ts) | [06-ones-provider.md §2](./06-ones-provider.md) |
| [src/providers/ones/ones-browser-source.ts](../src/providers/ones/ones-browser-source.ts) | [06-ones-provider.md §3](./06-ones-provider.md) |
| [src/providers/ones/ones-ticket-mapper.ts](../src/providers/ones/ones-ticket-mapper.ts) | [06-ones-provider.md §4](./06-ones-provider.md) + [02-domain-model.md §9](./02-domain-model.md) |
| [config/clawer-ticket.config.example.json](../config/clawer-ticket.config.example.json) | [07-config-secrets.md §6](./07-config-secrets.md) |
| [test/mcp/ticket-tools.test.ts](../test/mcp/ticket-tools.test.ts) | [14-build-test.md §3.1](./14-build-test.md) |
| [test/mcp/stdio.test.ts](../test/mcp/stdio.test.ts) | [14-build-test.md §3.2](./14-build-test.md) |
| [test/integration/providers/ones/ones-provider.test.ts](../test/integration/providers/ones/ones-provider.test.ts) | [14-build-test.md §3.3](./14-build-test.md) |

## 项目内现有文档

| 文件 | 说明 |
| --- | --- |
| [README.md](../README.md) | 项目说明、工具列表、导出目录结构、限流/筛选/续传、配置与凭据、开发 |
| [AGENTS.md](../AGENTS.md) | 工作流轻量协作指引 |
| [docs/mcp-architecture-evolution.md](../docs/mcp-architecture-evolution.md) | MCP 工单服务架构演进方案（模块化单体 + 六边形） |
| [docs/ones-ticket-ingestion-design.md](../docs/ones-ticket-ingestion-design.md) | ONES 工单采集设计 |
| [docs/ones-ticket-ingestion-implementation-spec.md](../docs/ones-ticket-ingestion-implementation-spec.md) | ONES 工单采集实现规范 |

> 本 `dics/` 目录是对源码的完整逆向说明，与上述项目内现有文档互补。项目内现有文档侧重设计与演进，本目录侧重实现细节与可查阅性。

## 完整目录树（项目根）

```text
clawer-ticket-server/
  config/
    clawer-ticket.config.example.json
  dics/                            # 本文档集
    00-overview.md
    01-architecture.md
    02-domain-model.md
    03-ports-interfaces.md
    04-application-service.md
    05-mcp-tools.md
    06-ones-provider.md
    07-config-secrets.md
    08-export-storage.md
    09-rate-limit-resume.md
    10-security-redaction.md
    11-error-handling.md
    12-infrastructure.md
    13-runtime-flow.md
    14-build-test.md
    15-use-cases.md
    16-index.md                    # 本文
  docs/
    mcp-architecture-evolution.md
    ones-ticket-ingestion-design.md
    ones-ticket-ingestion-implementation-spec.md
  src/
    bootstrap/
      create-server.ts
    config/
      static-ticket-profile-resolver.ts
    delivery/
      mcp/
        ticket-server.ts
    infrastructure/
      http/
        fetch-http-client.ts
      security/
        env-secret-provider.ts
    modules/
      tickets/
        application/
          ticket-application.ts
        domain/
          ports.ts
          ticket-error.ts
          ticket-policy.ts
          ticket.ts
        infrastructure/
          export/
            local-ticket-bundle-store.ts
    providers/
      ones/
        ones-browser-source.ts
        ones-config.ts
        ones-contracts.ts
        ones-graphql-source.ts
        ones-ticket-mapper.ts
    index.ts
    server.ts
  test/
    integration/
      providers/
        ones/
          ones-provider.test.ts
    mcp/
      stdio.test.ts
      ticket-tools.test.ts
  .gitignore
  AGENTS.md
  README.md
  package.json
  tsconfig.json
```
