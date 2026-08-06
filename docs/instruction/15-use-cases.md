# 15 · 作用场景与使用模式

> 本文档说明 clawer-ticket-server 的典型作用场景、适用范围、不适用范围，以及常见使用模式。

## 1. 项目定位

**clawer-ticket-server 是一个面向 AI Agent / 人类用户的“工单采集”MCP 服务**，把企业工单系统（第一期 ONES Project）中“当前用户负责且未完成”的树形待办读取出来，归一化为统一结构，并可选择原子落盘到本机。

它**不是**通用爬虫，也**不是**工单操作工具——它只读、只导出，不创建/修改/删除工单。

## 2. 适用场景

### 2.1 AI Agent 辅助工单处理

- AI Agent（如 Claude Desktop）通过 MCP 调用 `ticket_my_open_tasks` 读取“我负责的未完工单”。
- Agent 基于完整详情（描述、评论、附件元数据）理解上下文，给出处理建议。
- Agent 调用 `ticket_export` 把工单 bundle 落盘，供后续深度分析或归档。

**价值**：Agent 不需要直接接触 ONES API、不需要凭据、不需要处理 ONES 的怪癖；MCP 服务在受控边界内完成所有交互。

### 2.2 个人工单归档与离线分析

- 用户调用 `ticket_export_my_open_tasks` 批量导出所有未完工单到本地。
- 导出物是结构化的 `ticket.md` + `_machine/*.json`，可被脚本/工具链消费。
- 媒体（附件、富文本图片）默认下载，断点续传保证完整性。

**价值**：把 ONES 的临时数据变成可持久化、可审计、可迁移的本地资产。

### 2.3 工单状态分类与筛选

- 配置 `classificationRules` 把工单分为 `bugfix` / `feature` / `technical-change`。
- 调用 `ticket_export_my_open_tasks` 传 `statuses: ["新建"]` 只导出特定状态的工单。
- 导出物的 `ticket.md` 与 `manifest.json` 记录分类与状态，便于后续统计。

**价值**：在不修改 ONES 视图的前提下，按本地规则筛选与分类。

### 2.4 浏览器登录租户的工单采集

- 部分 ONES 租户只接受网页登录，没有服务账号 / API Token。
- 使用 `source: "browser"` profile，`ticket_browser_connect` 开可见 Chrome 窗口。
- 可选 `autoLogin` 自动提交邮箱密码直登；遇到 MFA/验证码/SSO 交由用户在可见窗口完成。
- 登录后所有读取/导出工具复用同源会话，不读取/持久化 Cookie。

**价值**：把“必须网页登录”的租户也纳入 MCP 工单采集能力。

### 2.5 GraphQL 待办数不准的租户

- 部分 ONES 租户在 GraphQL 中报告的待办数与实际枚举行不一致。
- Browser profile 配置 `browser.myOpenViewUrl`，连接器在发现差异时读取该视图中可见的工单路由，按当前用户负责人 ID/显示名排除父级上下文，并继续用同源 GraphQL/REST 获取完整详情。

**价值**：对“GraphQL 计数不准”的租户提供权威的当前用户工单行。

## 3. 不适用场景

### 3.1 需要 7×24 无人值守的场景

- Browser profile 依赖可见窗口，遇到 MFA/验证码/SSO 需要人工。
- 不适用于需要绕过 MFA、验证码、SSO 或其他人工挑战的无人值守任务。

### 3.2 需要修改工单的场景

- 本项目**只读**：不创建、不修改、不删除工单。
- 不支持工单状态变更、评论新增、附件上传等写操作。

### 3.3 需要抓取任意 URL 的场景

- 不接受任意 URL、Header 或 GraphQL 文本作为工具参数。
- 所有出站请求的 host 必须在 `allowedHosts`。
- 不是通用爬虫。

### 3.4 需要绕过 ONES 服务端限制的场景

- 限流受 `maxRequestsPerMinute` 滑动窗口约束。
- ONES 返回 429 时优先遵从 `Retry-After`。
- **不要通过调高预算来规避 ONES 的服务端限制**。

### 3.5 需要跨工单事务的场景

- 当前没有跨工单一致性事务。
- `ticket_export_my_open_tasks` 的批量导出是“每张原子，批不是”——某张失败会中断，已写入的保留。

## 4. 典型使用模式

### 4.1 模式 A：GraphQL 读取 + 单张导出

```text
1. 配置 source: "graphql" profile，环境变量设置 secretRef token
2. ticket_connection_status(profile) → 确认授权
3. ticket_my_open_tasks(profile, limit=1000) → 查看未完工单列表
4. ticket_get(profile, { id }) → 看某张详情（内联）
5. ticket_export(profile, { id }, mode="write", media="download") → 落盘
```

### 4.2 模式 B：GraphQL 批量导出

```text
1. 配置 source: "graphql" profile
2. ticket_connection_status(profile) → 确认授权
3. ticket_export_my_open_tasks(profile, limit=1000, mode="plan") → 先看计划
4. ticket_export_my_open_tasks(profile, limit=1000, mode="write", media="download") → 落盘
5. 重复 4 → 断点续传，只补下载缺失/损坏的媒体
```

### 4.3 模式 C：Browser 直登 + 读取

```text
1. 配置 source: "browser" profile + autoLogin（可选）
2. ticket_browser_connect(profile) → 开 Chrome，自动/手动登录
3. ticket_connection_status(profile) → 确认会话可用
4. ticket_my_open_tasks(profile) → 读取（含 reconciliation）
5. ticket_export_my_open_tasks(profile, mode="write") → 落盘
6. ticket_browser_disconnect(profile) → 关浏览器，丢登录态
```

### 4.4 模式 D：按状态筛选导出

```text
1. 配置 profile
2. ticket_export_my_open_tasks(profile, mode="write", statuses=["新建"]) → 只导出“新建”状态
3. ticket_export_my_open_tasks(profile, mode="write", statuses=["进行中"]) → 再导出“进行中”
```

### 4.5 模式 E：只导出元数据，不下载二进制

```text
1. 配置 profile
2. ticket_export_my_open_tasks(profile, mode="write", media="metadata") → 只生成索引，不下载附件/图片
3. 后续如需二进制，再调 ticket_export_my_open_tasks(media="download")，断点续传补下载
```

## 5. 与其他系统的关系

### 5.1 与 ONES 的关系

- 第一期 provider 是 ONES Project。
- 通过 ONES GraphQL（`/project/api/project/team/{teamId}/items/graphql`）读取详情/附件/列表。
- 通过 ONES REST（`/project/api/project/team/{teamId}/task/{id}/messages`）读取消息流。
- 通过 ONES REST（`/project/api/project/team/{teamId}/res/attachment/{id}?op=download&action=download`）解析附件临时 URL。
- **不修改** ONES 任何数据。

### 5.2 与 MCP 客户端的关系

- 以 stdio 传输对外暴露 7 个工具。
- MCP 客户端（Claude Desktop / IDE Agent / 自定义客户端）通过 JSON-RPC 调用。
- 客户端不需要知道 ONES、不需要凭据、不需要处理限流。

### 5.3 与本地文件系统的关系

- 导出物写入 `storage.root` 边界内。
- 路径计算受 `sanitizedSegment` 清理 + `assertPath` 校验。
- 原子写入：暂存目录 + 锁目录 + 整体 rename。

### 5.4 与浏览器的关系（仅 Browser profile）

- 用 `playwright-core` 启动系统 Chrome（可见窗口、内存 context）。
- 不下载浏览器，不持久化个人资料目录。
- 不读取/复制/打印/持久化 Cookie、密码、localStorage。
- MCP 重启或 `ticket_browser_disconnect` 后登录态即被丢弃。

## 6. 演进方向（来自 `docs/mcp-architecture-evolution.md`）

- **第二 provider**：Jira / Tapd 等，通过实现 `TicketProvider` + `TicketMediaProvider` + 可选 `BrowserSessionProvider` 接入。
- **配置适配**：`TicketProfileResolver` 可替换为动态配置中心。
- **密钥适配**：`SecretProvider` 可替换为 Vault / AWS Secrets Manager。
- **存储适配**：`TicketBundleStore` 可替换为对象存储适配器（S3 / OSS）。
- **更多视图**：当前 `defaultView: "my_open_tree"` 是唯一视图，未来可扩展。
- **媒体策略**：当前 `download` / `metadata` 两种，未来可加大小限制、类型限制等。

## 7. 关键决策记录

| 决策 | 理由 |
| --- | --- |
| 模块化单体 + 六边形 | 一个产品领域、一个部署单元；但需要按变化原因分隔 |
| provider 由配置选择 | 安全边界：不接受工具参数指定 provider |
| 原始响应不跨越 provider 边界 | 保护领域层不被厂商污染 |
| 二进制不进入 MCP 响应 | 协议层不传输大文件，二进制只流向本地 |
| 临时 URL 不持久化 | 避免短期凭据泄露 |
| 脱敏前置 | 单一漏斗，保证导出物与响应一致 |
| Browser 不持久化 | 会话即用即弃，降低凭据泄露风险 |
| 不绕过人工挑战 | 合规与安全 |
| 限流串行 + 滑动窗口 | 保护 ONES 服务端，保护本地进度 |
| 断点续传 | 大批量导出可恢复 |
| 事务原子写入 | 避免部分写入导致的不一致 bundle |
| 错误码稳定 | MCP 客户端可程序化判断 |

## 8. 用户该知道的“不”

- **不会**绕过 MFA / 验证码 / SSO。
- **不会**读取 / 复制 / 持久化浏览器 Cookie / 密码 / localStorage / 个人资料。
- **不会**自动下载附件二进制（除非 `mode: "write"` + `media: "download"`）。
- **不会**保存 ONES 的临时附件 URL。
- **不会**执行工单富文本中的 HTML 或加载远程图片。
- **不会**接受任意 URL / Header / GraphQL 文本作为工具参数。
- **不会**向标准输出写普通日志（破坏 MCP 协议）。
- **不会**在 JSON 配置中直接填写 token（必须用 `secretRef`）。
- **不会**创建 / 修改 / 删除工单（只读）。
- **不会**通过调高预算规避 ONES 服务端限制。
