# 00 · 项目总览

> 本文档是 clawer-ticket-server 项目的入口说明。如果你只想看一份文档建立全局认知，请从这里开始，再按需阅读其余分册。

## 1. 项目定位

**clawer-ticket-server** 是一个**通用工单采集 MCP（Model Context Protocol）服务**。

- 它把企业工单系统（第一期实现 ONES Project）中“当前用户负责且未完成”的树形待办读取出来，归一化为统一的 `CanonicalTicket` 结构，并可选择把工单详情、动态/消息流、附件元数据、附件与富文本图片原子地落盘到本机。
- 它面向 MCP 客户端（例如 Claude Desktop、IDE 内嵌 Agent 等）以 **stdio 传输**对外暴露 7 个 `ticket_*` 工具。
- 它**不是**通用爬虫，也**不**做：绕过验证码 / MFA / SSO、读取浏览器 Cookie、抓取任意 URL、接受任意 GraphQL 文本、把凭据写入工具参数或日志、向标准输出打印普通日志。

一句话定位：**在受控的本地配置与授权边界内，把“我负责的工单”从 ONES 拉成规范化、可审计、可断点续传的本地 bundle，供下游 AI / 人类消费。**

## 2. 关键能力一句话清单

| 能力 | 说明 |
| --- | --- |
| 连接探测 | `ticket_connection_status`：检查 profile，并发起一次小型只读在线授权探针，不输出秘密。 |
| 受监督浏览器会话 | `ticket_browser_connect` / `ticket_browser_disconnect`：对 `source: "browser"` profile 开一个独立、可见、内存态的临时 Chrome；可选自动邮箱密码直登，遇到 MFA/验证码/SSO 立即停止交由人工。 |
| 列表 + 详情 | `ticket_my_open_tasks`：读取“未完成 + 当前用户负责”的树形视图；默认返回每张匹配工单的完整详情，父级仅作上下文。 |
| 单张详情 | `ticket_get`：读取一张工作项的详情、动态/消息流和附件 metadata，按字符预算内联返回。 |
| 单张导出 | `ticket_export`：默认 `plan`；显式 `mode: "write"` 才写入本机；写入时默认下载附件与富文本图片，`media: "metadata"` 只保存元数据。 |
| 批量导出 | `ticket_export_my_open_tasks`：对全部匹配待办生成计划或落盘；仅在全部详情读取成功后才开始写入；支持按 `statuses` 过滤。 |

## 3. 技术栈

| 维度 | 选型 |
| --- | --- |
| 语言 / 运行时 | TypeScript（`target: ES2022`，`module: NodeNext`，`strict: true`），Node.js |
| MCP SDK | `@modelcontextprotocol/sdk` ^1.30.0 |
| 浏览器自动化 | `playwright-core` ^1.62.0（仅用 chromium，可见窗口、内存 context） |
| 校验 | `zod` v4（配置文件 schema 与 MCP 工具入参 schema） |
| 传输 | stdio（`StdioServerTransport`），不输出普通日志到 stdout |
| 测试 | 自带 `tsx` 直跑的集成测试（fake HTTP / in-memory MCP transport） |
| 构建 | `tsc` 输出到 `dist/`，入口 `dist/index.js` |

## 4. 目录结构（源码层）

```text
src/
  index.ts                              # 进程入口：创建 server + StdioServerTransport
  server.ts                             # @deprecated 重导出 bootstrap/create-server
  bootstrap/
    create-server.ts                    # 组合根：加载配置、装配 TicketApplication + ONES provider
  config/
    static-ticket-profile-resolver.ts   # 把受控配置中的 profile 投影为内存 resolver
  delivery/
    mcp/
      ticket-server.ts                  # 注册 7 个 MCP 工具，仅做 schema + 结果映射
  infrastructure/
    http/
      fetch-http-client.ts              # HttpClient 实现 + JSON 响应统一校验
    security/
      env-secret-provider.ts            # 从进程环境读取受控密钥引用
  modules/
    tickets/
      application/
        ticket-application.ts           # 用例编排：列表/详情/导出/媒体计划/脱敏/内联裁剪
      domain/
        ports.ts                        # TicketProvider / BundleStore / BrowserSession 等端口
        ticket.ts                       # CanonicalTicket、索引树、引用、附件、评论等契约
        ticket-error.ts                 # 稳定错误码 + TicketError
        ticket-policy.ts                # 脱敏策略 redactTicket
      infrastructure/
        export/
          local-ticket-bundle-store.ts  # 原子落盘、manifest、媒体去重与断点续传
  providers/
    ones/
      ones-config.ts                    # ONES 配置 schema、loadConfig、host allowlist 校验
      ones-contracts.ts                 # ONES 原始响应在归一化前的载体类型
      ones-graphql-source.ts            # GraphQL + REST provider（含限流/重试/请求预算）
      ones-browser-source.ts            # 浏览器 provider（受监督会话、reconciliation、同源 fetch）
      ones-ticket-mapper.ts             # ONES raw -> CanonicalTicket 归一化
```

> 完整目录（含 `config/`、`docs/`、`test/`）见 [16-index.md](./16-index.md)。

## 5. 分层一句话

- **Delivery（交付层）**：`delivery/mcp/ticket-server.ts` 只负责 MCP 工具注册、zod schema、把业务结果投影成 MCP 文本响应。
- **Application（应用层）**：`TicketApplication` 编排用例，依赖端口，不直接接触 ONES 或文件系统。
- **Domain（领域层）**：`ticket.ts` / `ports.ts` / `ticket-error.ts` / `ticket-policy.ts` 定义与 provider 无关的契约、端口、错误、脱敏策略。
- **Providers（适配器层）**：`providers/ones/*` 把 ONES GraphQL/REST/浏览器响应翻译成领域契约。
- **Infrastructure（基础设施层）**：HTTP 客户端、密钥 provider、本地 bundle store。
- **Bootstrap（组合根）**：`create-server.ts` 把以上各层按受控配置组装成一个 `McpServer`。

## 6. 部署形态

```json
{
  "mcpServers": {
    "clawer-ticket": {
      "command": "npx",
      "args": ["-y", "clawer-ticket-server@1.0.0"],
      "env": {
        "CLAWER_TICKET_CONFIG_PATH": "D:/secure/clawer-ticket.config.json"
      }
    }
  }
}
```

- 配置文件路径由 `CLAWER_TICKET_CONFIG_PATH` 指向（兼容旧变量 `ONES_MCP_CONFIG_PATH`）。
- GraphQL profile 通过 `secretRef`（如 `ONES_READ_TOKEN`）从进程环境读取只读机器凭据。
- Browser profile 不需要 `secretRef`，可选在本地受 Git 忽略的配置里设置 `browser.autoLogin.email/password`。

## 7. 核心设计约束（贯穿全项目）

1. **provider 由受控配置选择，不能由 MCP 工具参数指定。**
2. **原始厂商响应不跨越 provider 边界**，只有 `CanonicalTicket` 进入应用层。
3. **二进制内容不进入 MCP 响应**，只流向本地导出存储。
4. **临时 ONES 附件 URL 永不持久化**，只存在于内存中用于一次性下载。
5. **导出原子化**：暂存目录 + 锁目录 + 整体 rename，失败回滚。
6. **媒体去重**：按附件 UUID 优先、内容 hash 兜底，一个二进制只保存一次。
7. **限流串行**：每个 profile 独立串行队列 + 滑动窗口预算 + 429 退避重试。
8. **脱敏前置**：工单进入 MCP 返回或持久化前应用 `redactTicket`。
9. **host allowlist**：所有出站请求（含浏览器、附件解析）都必须落在 `allowedHosts`。
10. **不绕过人工挑战**：MFA/验证码/SSO 立即停止，交由用户在可见窗口完成。

## 8. 阅读顺序建议

1. [00-overview.md](./00-overview.md)（本文）—— 建立全局认知
2. [01-architecture.md](./01-architecture.md) —— 分层与依赖方向
3. [02-domain-model.md](./02-domain-model.md) —— 领域契约
4. [03-ports-interfaces.md](./03-ports-interfaces.md) —— 端口定义
5. [04-application-service.md](./04-application-service.md) —— 用例编排
6. [05-mcp-tools.md](./05-mcp-tools.md) —— 7 个工具的入参/出参/行为
7. [06-ones-provider.md](./06-ones-provider.md) —— ONES 适配器
8. [07-config-secrets.md](./07-config-secrets.md) —— 配置与密钥
9. [08-export-storage.md](./08-export-storage.md) —— 本地 bundle 结构
10. [09-rate-limit-resume.md](./09-rate-limit-resume.md) —— 限流与断点续传
11. [10-security-redaction.md](./10-security-redaction.md) —— 安全与脱敏
12. [11-error-handling.md](./11-error-handling.md) —— 错误码
13. [12-infrastructure.md](./12-infrastructure.md) —— HTTP / Secret / Resolver
14. [13-runtime-flow.md](./13-runtime-flow.md) —— 端到端时序
15. [14-build-test.md](./14-build-test.md) —— 构建与测试
16. [15-use-cases.md](./15-use-cases.md) —— 作用场景
17. [16-index.md](./16-index.md) —— 文档索引
