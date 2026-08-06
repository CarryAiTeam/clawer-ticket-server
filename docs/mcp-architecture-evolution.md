# MCP 工单服务架构演进方案

**结论：** 当前项目最适合演进为 **模块化单体（modular monolith）+ Ports and Adapters / 六边形架构**。保留一个 TypeScript 进程、一个 MCP Server 和一套部署方式；在进程内按“核心领域、应用用例、外部适配器、MCP 交付层”分隔。它比继续平铺 `src` 更能承受多工单系统和文件下载的复杂度，也比微服务、过度 DDD 分层更符合当前规模。

本文是架构目标与迁移设计，**不改变**现有 7 个 MCP 工具的名称、输入输出或对外副作用约束。

**本次已实施：** 第一阶段的无行为变化迁移已经完成。运行时代码已从 `src/` 根目录迁入 bootstrap、delivery、modules、providers 和 infrastructure；三类现有测试已迁入 `test/`，并由原有 `npm run test` 脚本继续执行。第二 provider 和二进制附件下载仍是后续阶段，未以空接口或未经验证的实现提前加入。

## 1. 现状与判断依据

当前项目已经具备值得保留的基础：

- `src/server.ts` 是唯一的 MCP SDK 入口，工具统一使用 `ticket_*` 命名；这应继续是外部稳定边界。
- `src/domain.ts` 已有 `CanonicalTicket`、`TicketSource`、`TicketAttachment` 等跨能力契约的雏形。
- `src/application.ts` 已集中“列表—详情—归一化—脱敏—导出”的流程；它天然适合作为应用层的起点。
- `src/ones-graphql-source.ts` 和 `src/ones-browser-source.ts` 已经将 ONES 的两种访问方式局部化。
- `src/storage.ts` 已具有目录级原子替换和哈希清单；这是未来资产（图片、附件）持久化的可靠基础。

但继续按技术文件平铺会逐渐产生四类问题：

1. **命名泄漏。** `OnesApplication`、`OnesConfig` 和 `OnesError` 被通用工具层使用；接入 Jira、Tapd 等 provider 时，通用流程会带着 ONES 名称与条件分支增长。
2. **变化原因混合。** MCP schema、工单业务规则、ONES 响应解析、文件系统写入与浏览器会话的变化发生在同一层级，无法从目录判断影响范围。
3. **媒体复杂度不同于元数据。** 下载文件需要访问授权 URL、限流、大小/类型限制、完整性校验、断点与失败恢复；不能塞进现有 `normalize.ts` 或 `storage.ts` 的一个函数。
4. **测试替换面不清晰。** 未来希望单测一个用例时，应替换 provider、对象存储或时钟等端口，而不是模拟 MCP Server 或 ONES HTTP。

这些信号已经满足“按变化原因拆分”的条件；但项目仍只有一个产品领域（工单）和一个部署单元，不满足拆微服务的条件。

## 2. MCP 服务通常采用什么内部模型

MCP 是**协议与交付边界**，并不规定业务架构。主流服务端实践是将 `tools/resources/prompts` 的注册和协议处理放在最外层，把业务用例和外部系统 SDK 隔离在内部。对本项目，可用下面的依赖方向理解：

```text
MCP Client
  ↓ JSON-RPC / stdio
Delivery: MCP tool handlers (schema, response mapping)
  ↓
Application: use cases (orchestration, authorization intent, transactions)
  ↓
Domain: ticket contracts, policies, domain errors, ports
  ↑
Adapters / Infrastructure: ONES, future providers, filesystem, secrets, HTTP, browser
```

这不是要求完整的传统 DDD：

- **应使用轻量领域模型。** `Ticket`、`TicketReference`、`AttachmentDescriptor`、分类、导出清单是跨 provider 的稳定业务概念，值得进入 `domain`。
- **不应机械套用聚合、仓储、领域事件。** 当前没有跨工单一致性事务、复杂状态机或多服务边界；仅在它们解决真实规则时再引入。
- **应用层以用例而非实体为中心。** MCP 工具对应用户意图，例如“读取详情”“导出工单”“下载已授权资产”，由 use case 编排端口；工具 handler 不直接调用 ONES 或文件系统。
- **provider 层只做翻译。** ONES 的 GraphQL、REST、浏览器会话和字段 UUID 属于 adapter；不得漏入通用 Ticket 类型、MCP 参数或目录命名规则。

## 3. 推荐的目标目录

```text
src/
  bootstrap/
    create-server.ts                 # 组合根：配置、依赖实例、注册路由
    provider-registry.ts             # profile -> provider adapter 工厂
  delivery/
    mcp/
      register-ticket-tools.ts       # 7 个工具的注册；仅 schema/DTO 映射
      schemas.ts
      result-mapper.ts
  modules/
    tickets/
      domain/
        ticket.ts                    # CanonicalTicket、索引、引用、分类
        attachment.ts                # 描述符、下载策略、媒体状态
        ports.ts                     # TicketProvider、TicketMediaProvider、TicketBundleStore
        errors.ts
        policies.ts                  # allowlist、脱敏、输出预算等纯规则
      application/
        get-ticket.ts
        list-my-open-tickets.ts
        get-connection-status.ts
        export-ticket.ts
        export-my-open-tickets.ts
        download-attachments.ts
        dto.ts                       # 用例输入/输出，不暴露 provider 原始对象
      infrastructure/
        export/
          local-ticket-bundle-store.ts
          manifest.ts
        security/
          env-secret-provider.ts
        http/
          fetch-http-client.ts
        media/
          local-media-store.ts
          download-policy.ts
  providers/
    ones/
      ones-profile.ts                # ONES 专属配置 schema 与校验
      ones-ticket-provider.ts        # GraphQL / REST -> provider port
      ones-browser-session.ts        # 可监督浏览器能力
      ones-ticket-mapper.ts          # raw ONES -> CanonicalTicket
      ones-media-provider.ts         # 授权的附件/图片字节流获取
      contracts/                     # 固定请求与响应解码器
      fixtures/
  config/
    config-loader.ts                 # 顶层通用 profile 识别与组合
    profile.ts
  index.ts                           # 只启动 transport
test/
  unit/                              # 纯领域规则与单个用例（未来按 tickets/providers 镜像）
  integration/
    providers/ones/
      ones-provider.test.ts          # ONES 配置、映射、HTTP、浏览器和本地 bundle 协作
  contract/
    providers/ones/fixtures/         # 脱敏 provider 响应样本（后续新增）
  mcp/
    ticket-tools.test.ts             # 内存传输下的工具发现与调用
    stdio.test.ts                    # 编译后进程的 stdio 黑盒发现
  helpers/                           # fake provider、临时存储等可复用测试替身（按需新增）
```

目录含义与准入规则：

| 层 | 可以依赖 | 不可以依赖 | 典型变化 |
| --- | --- | --- | --- |
| `domain` | TypeScript 标准库、领域值对象 | MCP SDK、Zod、HTTP、文件系统、ONES | 归一化工单语义、脱敏/媒体策略 |
| `application` | `domain` 中定义的端口 | ONES 类、MCP Server、Node 文件 API | 用例顺序、显式副作用、批量策略 |
| `providers/*` | `domain` 端口、受控基础设施 | MCP handler、其他 provider 的内部实现 | 第三方 API/页面/认证契约 |
| `infrastructure` | `domain` 端口、Node API | MCP handler、ONES 业务字段 | 本地存储、HTTP、secret 实现 |
| `delivery/mcp` | application DTO | ONES、文件路径、浏览器对象 | 工具 schema、MCP 返回投影 |
| `bootstrap` | 全部模块的公开构造器 | 业务规则 | 依赖装配、transport 生命周期 |

**不要**建立 `controllers/services/repositories/utils` 的泛用平铺目录：它们按技术名词而非业务变化组织，最后又会变成更深的一层 `src`。

### 3.1 当前落地映射

| 旧职责 | 当前模块位置 | 说明 |
| --- | --- | --- |
| 进程启动和依赖组合 | `src/bootstrap/create-server.ts` | 从受控配置创建 ONES provider 与 `TicketApplication`。 |
| MCP 工具交付 | `src/delivery/mcp/ticket-server.ts` | 工具 schema、结果映射与 handler；不再直接读取配置。 |
| 工单用例 | `src/modules/tickets/application/ticket-application.ts` | 列表、详情、导出、inline 投影与浏览器会话编排。 |
| 领域类型和错误 | `src/modules/tickets/domain/` | `CanonicalTicket` 等通用工单类型与 provider-neutral `TicketError`。 |
| 本地 bundle 存储 | `src/modules/tickets/infrastructure/export/local-ticket-bundle-store.ts` | 原子目录替换、manifest 和 hash。 |
| ONES 特性 | `src/providers/ones/` | ONES 配置、字段映射、GraphQL 与浏览器 adapter。 |
| 通用技术实现 | `src/infrastructure/http/`、`src/infrastructure/security/` | HTTP 与环境 secret 实现。 |
| 兼容入口 | `src/server.ts` | 仅 re-export `createServer`，供既有本地调用过渡；新代码从 bootstrap 导入。 |

## 4. 核心契约：让多个工单系统可插拔

profile 选择仍由配置控制，不能由 MCP 调用方传任意 provider URL 或凭据。通用端口建议如下：

```ts
// modules/tickets/domain/ports.ts
export interface TicketProvider {
  readonly providerId: string;
  status(profile: TicketProfile): Promise<ConnectionStatus>;
  listMyOpen(profile: TicketProfile, query: MyOpenQuery): Promise<TicketIndexTree>;
  getTicket(profile: TicketProfile, reference: TicketReference): Promise<CanonicalTicket>;
}

export interface BrowserSessionProvider {
  open(profile: TicketProfile): Promise<BrowserSessionStatus>;
  close(profile: TicketProfile): Promise<void>;
}

export interface TicketMediaProvider {
  getMedia(profile: TicketProfile, attachment: AttachmentDescriptor): Promise<MediaStream>;
}

export interface TicketRepository {
  plan(ticket: CanonicalTicket): Promise<ExportPlan>;
  save(ticket: CanonicalTicket): Promise<ExportResult>;
  saveMedia(input: SaveMediaInput): Promise<SavedMedia>;
}
```

关键点：

- `CanonicalTicket` 是 provider 间的共同语言，但只承载稳定的工单语义。保留 `source.provider`、`source.ticketId` 与可选的原始字段映射；不要把 Jira issue、ONES `importantField` 等 provider 专属 JSON 塞进它。
- 无法归一化但需要保留的信息使用有命名空间的扩展，例如 `extensions: { "ones": { ... } }`，由配置决定是否导出；核心用例不可依赖该对象。
- `TicketProvider` 返回的应是已验证的领域数据，而不是 `unknown` 原始响应。原始 JSON 解码与字段错误检测属于 `providers/ones/contracts`。
- 浏览器会话是可选能力，不能用类型断言探测。provider registry 应显式暴露 `browserSessionProvider?: BrowserSessionProvider`。
- 附件下载端口与工单详情端口分开：读取元数据不代表获得字节流下载权限。

新增 Jira/Tapd/provider 的最小实施清单：实现其 profile schema、`TicketProvider`、可选 `TicketMediaProvider`、映射器、固定契约 fixture 与 contract test；**不修改** `delivery/mcp` 和通用用例。只有发现共同领域契约不足时才扩展 `domain`，并用至少两个 provider 的真实需求证明。

## 5. MCP 工具与用例的边界

现有 7 个工具保留为稳定 API：

- `ticket_browser_connect` / `ticket_browser_disconnect` → `OpenBrowserSession` / `CloseBrowserSession`
- `ticket_connection_status` → `GetConnectionStatus`
- `ticket_my_open_tasks` → `ListMyOpenTickets`
- `ticket_get` → `GetTicket`
- `ticket_export` → `ExportTicket`
- `ticket_export_my_open_tasks` → `ExportMyOpenTickets`

MCP handler 只负责：Zod 输入校验、把 `profile/ticket/mode` 转为用例 DTO、调用用例、将领域错误映射为 MCP 错误结果、裁剪 inline 输出。它不应知道 ONES URL、HTTP header、文件写入路径或浏览器实现。

未来的下载能力应单独增加显式意图的工具，例如 `ticket_download_attachments`，而不是给 `ticket_get` 或 `ticket_export` 偷偷增加下载：

- 输入须限定 `profile`、`ticket`、可选的受控 attachment id 列表与 `mode: plan | write`。
- `plan` 返回预计文件、字节数、拒绝项与安全策略；仅 `write` 触发下载与落盘。
- 保持工具返回小型 manifest，不内联二进制或 base64 图片；客户端按本地文件路径/资源句柄取得结果。
- 图片预览/文本提取应是后续独立用例，下载完成也不自动送入模型上下文。

## 6. 附件与图片下载的专门设计

### 6.1 两阶段模型

```text
工单详情（附件元数据）
  → DownloadAttachments.plan
  → 策略检查（权限、数量、总大小、MIME、文件名）
  → provider 获取短生命周期受控流
  → 流式写入隔离暂存目录并计算 SHA-256
  → 校验大小 / MIME / 哈希
  → 原子提交 assets/ + 更新 manifest
```

`TicketAttachment` 应拆为：

- `AttachmentDescriptor`：id、展示名、声明类型、声明长度、内容哈希（若来源提供）、下载能力标识。它可随工单导出。
- `MediaStream`：一次性字节流、可信的响应 content-type/length、来源版本信息。它只在 adapter 与媒体用例之间流动，绝不写入 MCP 返回。
- `SavedMedia`：相对路径、计算后的 SHA-256、实际 size/type、状态（`downloaded`、`skipped`、`rejected`、`failed`）与非敏感错误码。

### 6.2 必须固化的安全和可靠性策略

1. **显式授权与 source allowlist。** provider 根据工单附件 ID 取得下载流；不接收调用方传入的 URL、Cookie、header 或 redirect 目标。HTTP client 禁止跨 host 重定向。
2. **预算优先。** 配置每工单数量、单文件大小、总大小、并发和超时上限；先检查声明长度，流式读取期间仍强制实际字节上限。
3. **内容不能只信扩展名。** 记录声明 MIME、响应 MIME 和（可行时）魔数识别结果；允许列表先从图片与常见文档开始，未知类型默认 `rejected` 或仅留 metadata。
4. **隔离、可恢复写入。** 写入 `ticket/.<exportId>.tmp/assets/`，每个文件完成并校验后才更新 manifest；整个批次通过目录原子替换提交。失败不得覆盖旧 bundle。
5. **去重与可追溯。** 使用 SHA-256；路径采用安全的附件 ID + 清理后的文件名，不能信任原文件名。manifest 记录来源附件 ID、hash、字节数、策略版本和下载时间，不保存预签名 URL。
6. **幂等和重试。** 相同 ticket version + 同 hash 的文件跳过；只重试可安全重试的网络错误，限制次数并记录 `failed` 状态。401/403/MFA/CAPTCHA/契约变化立即停止，不做绕过。
7. **访问与保留。** 输出目录可能包含业务附件，默认本地受限路径；实现前明确保留期、清理责任、杀毒/内容扫描要求和是否允许二次分发。

建议导出结构：

```text
<storage.root>/<provider>/<project>/<ticket-id>/
  ticket.json
  ticket.md
  comments.json
  relations.json
  attachments/
    manifest.json                   # 所有描述符和下载状态
    assets/
      <attachment-id>-<safe-name>   # 仅已成功且允许下载的二进制
  manifest.json                     # bundle 文件哈希及版本
```

## 7. 渐进迁移路线

不要一次性移动所有文件。每一阶段均应保持工具行为兼容、可独立合入和可回退。

| 阶段 | 改动 | 完成标准 | 验证 |
| --- | --- | --- | --- |
| 0：冻结契约 | 为 7 个工具建立工具发现与输入/输出快照；补充当前导出目录 fixture | 外部 API 基线可比较 | `npm run test` + stdio discovery snapshot |
| 1：无行为移动 | 抽离 `delivery/mcp`、`domain`、`infrastructure`，保留临时 re-export；不改逻辑 | 编译产物和工具返回等价 | 类型检查、现有全量测试、导出 hash 对比 |
| 2：通用命名 | `OnesApplication` → `TicketApplication`；`OnesError` → `TicketError`；配置拆成顶层 profile + ONES schema | 通用模块不再 import `providers/ones` | 架构依赖检查、现有测试 |
| 3：provider registry | 通过配置创建 ONES adapter；浏览器能力改为显式可选端口 | 新增空 provider 不会影响 ONES 路径 | fake provider 集成测试、ONES 回归 |
| 4：媒体 plan | 引入媒体领域对象、下载策略和 `plan` 用例，仍不下载 | 预算、拒绝和 manifest 语义固定 | 策略单测、快照测试 |
| 5：媒体 write | 实现受控流、暂存、哈希、原子提交和恢复 | 网络/磁盘失败不污染旧 bundle | fake stream、超限、重试、原子性集成测试 |
| 6：第二 provider | 以一个真实需求接入第二个 provider | MCP handler 与核心 use case 无 provider 条件分支 | 双 provider contract suite |

迁移期间可短暂保留兼容入口，例如旧文件只 `export` 新模块；阶段 2 完成后删除。不要长期维持双份逻辑或在 `server.ts` 加 `if (provider === "ones")` 分支。

## 8. 测试与架构护栏

- **`test/unit/`：** 领域规则与单个用例；不启动 MCP、不访问网络、不写真实目录。分类、脱敏、输出预算、附件策略、文件名和路径安全应逐步迁入这里。
- **`test/integration/`：** 允许 fake HTTP、临时目录和流式附件，验证多个模块的协作。当前 ONES 覆盖在 `test/integration/providers/ones/ones-provider.test.ts`，包含配置、映射、浏览器路径、导出和 HTTP 失败处理。
- **`test/contract/`：** 每 provider 维护脱敏 fixture，覆盖列表、详情、评论、附件元数据、下载响应及 401/403/429/HTML 挑战页。当前尚未接入真实租户 fixture，因此此目录留待 provider contract test 单独立项时建立。
- **`test/mcp/`：** 只验证对外 MCP 边界：工具名、schema、标准错误投影和 stdio transport；不耦合 ONES 实现细节。当前包含内存传输和编译后 stdio 两个黑盒检查。
- **`test/helpers/`：** 仅在两个以上测试需要时才加入 fake provider、临时存储等共享替身，避免过早形成测试框架。
- **依赖规则：** 用 `dependency-cruiser`、ESLint import 限制或轻量脚本禁止 `domain` import `providers`/`delivery`，禁止 `delivery/mcp` import `providers/ones`。在依赖规则确有两层以上稳定模块后再引入；早期用 code review 也可。

## 9. 明确不推荐的方案

| 方案 | 不采用的原因 |
| --- | --- |
| 继续平铺 `src` | 新 provider 与媒体下载会扩大跨文件耦合，不能表达稳定边界。 |
| 按 MCP 工具建立 7 个业务模块 | `get`、`export`、批量导出会复制同一工单逻辑，工具是交付接口，不是领域边界。 |
| 每个 provider 一个完整应用层 | 会复制脱敏、导出、预算与媒体策略，长期分叉。 |
| 微服务 / 每 provider 独立进程 | 当前没有独立伸缩、独立权限域或独立发布需求，只会增加部署和版本协调成本。 |
| 完整战术 DDD（聚合/事件总线/CQRS） | 目前没有足够复杂的一致性或读写模型问题来抵消抽象成本。 |
| 在 `ticket_get` 中自动下载 | 把读操作变成不可预期的网络和磁盘副作用，放大权限、成本与失败面。 |

## 10. 首次实施建议

建议先实施**阶段 0 和阶段 1**：它们不改变业务语义，能以低风险验证目录与依赖边界是否适用。本次架构升级执行这两个阶段，并把现有测试迁入 `test/`；完成后再开始 provider registry。媒体下载须在明确附件授权方式、大小/MIME/保留策略、目标目录访问权限后单独立项并通过设计评审。

## 11. 当前任务验证与剩余风险

本任务仅创建架构设计文档与 WorkspaceTask，未修改运行时代码，因此未运行 `npm run test`；文档依据已检查的当前 `src/server.ts`、`src/application.ts`、`src/domain.ts`、`src/storage.ts`、`src/config.ts`、`src/normalize.ts` 形成。

仍需在实施前确认的外部事实：各新增 provider 的正式 API/附件下载授权契约、附件最大规模与可接受 MIME、文件保留/安全扫描要求、以及是否需要把二进制文件交给 MCP 客户端之外的下游系统。
