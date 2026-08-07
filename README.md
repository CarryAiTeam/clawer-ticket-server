# Clawer Ticket MCP

一个通用工单采集 MCP。第一期实现 ONES Project provider：读取“自己负责且未完成”的树形待办，按 UUID 获取一条工单详情、动态/消息流和附件 metadata，并将规范化结果原子落盘到本机。

浏览器 profile 可选地使用本地配置中的邮箱和密码完成受控的直登；不会读取浏览器 Cookie、绕过验证码、MFA 或 SSO 确认，也不会自动下载附件二进制文件。

## 工具

- `ticket_connection_status`：检查 profile，并发起一次小型只读在线授权探针，不输出秘密。
- `ticket_browser_connect`：仅对 `source: "browser"` 的 profile 打开独立、可见的临时 Chrome；若配置 `browser.autoLogin`，会提交受控的邮箱和密码，并立即执行只读授权探测，在结果中明确报告会话是否可用；否则你在窗口中自行登录 ONES。
- `ticket_browser_disconnect`：关闭该临时窗口，并立即丢弃它的内存登录态。
- `ticket_my_open_tasks`：读取固定的“未完成 + 当前用户负责”视图；默认返回每张匹配工单的完整详情，父级仅作为上下文。
- `ticket_get`：读取一张工作项的详情、动态/消息流和附件 metadata。
- `ticket_export`：默认 `plan`；只有显式 `mode: "write"` 才会写入本机。写入时默认下载附件和富文本图片；传入 `media: "metadata"` 可只保存元数据。
- `ticket_export_my_open_tasks`：对全部匹配待办生成计划或落盘；仅在全部详情读取成功后才开始写入。写入时同样默认下载媒体。

当本机配置只有一个 `profile` 时，以上工具可以省略 `profile`，服务端会使用唯一配置项；显式传入 `profile` 时始终按该名称选择。配置多个 profile 时，省略 `profile` 会返回 `PROFILE_REQUIRED` 和可选名称，绝不会按配置顺序或随机选择。

导出目录结构：

```text
<storage.root>/<provider>/<project-or-team>/<ticket-id>/
  ticket.md
  attachments/
    README.md
    <downloaded standalone attachments>
  assets/
    description/README.md
    comments/README.md
  _machine/
    ticket.json
    comments.json
    relations.json
    attachments.json
    media.json
    manifest.json
```

`ticket.md` 是人读入口：它会链接到附件索引，以及描述和评论中已识别图片的本地索引。索引文件始终存在，明确区分“已识别”与“已下载”，避免生成指向不存在二进制文件的失效链接。写入导出默认下载：独立附件写入 `attachments/`，描述或评论内联图片优先写入对应 `assets/` 子目录，并在正文中以本地 Markdown 图片或文件链接呈现；传入 `media: "metadata"` 时只生成索引。

`_machine/` 只存放完整的机器数据与校验信息。附件 metadata 位于 `_machine/attachments.json`，已下载媒体的本地路径与逻辑用途位于 `_machine/media.json`；不会保存 ONES 的临时附件 URL。评论富文本只保留安全文本、HTTP(S) 链接（去掉 query/hash）和图片提示，不会执行 HTML 或加载远程图片。

ONES 富文本图片会以 `<img data-uuid>` 形式引用与附件列表相同的资源。导出时按 attachment UUID 优先、内容 hash 兜底去重：一个二进制文件只保存一次；若它在描述或评论中被引用，`ticket.md` 优先从对应正文位置链接，而不在“附件”区重复展示。

`ticket_export` 与 `ticket_export_my_open_tasks` 的写入结果为每个实际生成文件返回 SHA-256；`_machine/manifest.json` 记录其余产物的哈希、`layoutVersion` 与内容哈希，便于后续校验、布局迁移和幂等更新判断。

## 限流、筛选与断点续传

导出请求按 profile 串行执行，并受 `requestBudget.maxRequestsPerMinute` 的滑动窗口约束。达到本地预算时会等待下一个可用窗口；若 ONES 返回 `429`，会优先遵从 `Retry-After`，否则进行有限次数的退避重试。不要通过调高预算来规避 ONES 的服务端限制。

`ticket_export_my_open_tasks` 可传入 `statuses: ["新建"]`，只读取并导出当前用户处于该状态的工单详情。默认 `media: "download"` 会下载图片和附件；再次导出时会用 manifest SHA-256 校验已有文件，仅补下载缺失或损坏的媒体。只有显式传入 `media: "metadata"` 才会省略二进制下载。

## 配置与凭据

选择一种接入方式，复制对应模板到本机受控位置，再设置 `CLAWER_TICKET_CONFIG_PATH` 指向它：

- [浏览器直登模板](./config/clawer-ticket.config.browser.example.json)：适用于支持邮箱/密码直登的 ONES 租户；将邮箱、密码和其他 `REPLACE_WITH_*` 值替换为本机获批值后可直接运行。
- [GraphQL 最小模板](./config/clawer-ticket.config.graphql.example.json)：适用于有管理员批准的只读机器凭据的租户；必须在 MCP 启动环境中提供 `secretRef` 同名的密钥。
- [完整参考模板](./config/clawer-ticket.config.example.json)：同时列出两种 profile 的所有实际生效字段，包括限流、分类、负责人字段、浏览器路径、视图和直登配置；它是字段总览，不建议直接作为单一接入方式的起点。

`ONES_MCP_CONFIG_PATH` 仅作为现有 ONES 部署的兼容入口保留。最小配置必须保留 `schemaVersion`、`storage.root` 和至少一个 profile；每个 profile 必须填写 `source`、`product`、`baseUrl`、`teamId` 与 `allowedHosts`。将 `REPLACE_WITH_*` 替换为获批值，并将 `allowedProjects` 设为非空的项目白名单。

`profile.provider` 是受控选择；第一期只接受 `ones`。`source: "graphql"` 必须配置 `secretRef`，它会从启动 MCP 的进程环境（或后续密钥库适配器）读取只读机器凭据，例如 `ONES_READ_TOKEN`。JSON 配置不支持直接填写 `token`，凭据也不得放入 MCP 工具参数或日志。

`requestBudget` 默认串行、每分钟 20 次；`inlineMaxChars` 默认 12000；`listAssigneeFieldId` 仅用于租户专属负责人字段，未配置时不会猜测；`browser.executablePath`、`browser.myOpenViewUrl` 仅在需要覆盖默认 Chrome 路径或校准“我负责”视图时填写。它们都是可选项，完整参考模板提供了可替换占位值。`allowedProjects` 在运行时可为空，但生产使用应保持为非空白名单。

浏览器 profile 不需要 `secretRef`。默认先调用 `ticket_browser_connect`，在新开的可见 Chrome 中完成登录，再调用 `ticket_connection_status` 和工单工具。`browser.autoLogin` 完全可选；直登模板和完整参考模板仅提供可通过 schema 的假值占位符，必须在复制出的 Git 忽略本机配置中替换为实际邮箱、密码和可选 `loginUrl`。`loginUrl` 必须位于 `allowedHosts`，未填写时由 `baseUrl` 推导为 `/login`。若不能使用直登，删除 `browser.autoLogin` 后改为在可见窗口手动登录。遇到 MFA、验证码、SSO 或二次确认时必须在可见窗口中完成操作。浏览器会话仅保留在当前 MCP 进程内，重启或 `ticket_browser_disconnect` 后即丢弃。

对于 ONES 在 GraphQL 中报告的待办数与实际枚举行不一致的租户，浏览器 profile 可配置 `browser.myOpenViewUrl` 为受控的“我负责的工作项”筛选视图 URL。连接器只在发现差异时读取该视图中可见的工单路由，按当前用户负责人 ID/显示名排除父级上下文，并继续用同源 GraphQL/REST 获取完整详情、评论和附件 metadata。该视图 URL 的 host 必须在 `allowedHosts` 中。

示例 MCP 客户端配置：

```json
{
  "mcpServers": {
    "clawer-ticket": {
      "command": "npx",
      "args": ["-y", "@carry-dream/clawer-ticket-server@1.0.0"],
      "env": {
        "CLAWER_TICKET_CONFIG_PATH": "D:/secure/clawer-ticket.config.json",
        "ONES_READ_TOKEN": "REPLACE_WITH_APPROVED_READ_TOKEN"
      }
    }
  }
}
```

GraphQL 模式需要将 `ONES_READ_TOKEN` 替换为管理员批准的只读机器凭据；browser 模式删除该环境变量即可。浏览器会话认证通过 Cookie 与 CSRF 协商，不能转换为可部署的 Bearer API Token。若租户没有可用的服务账号／API Token，可使用上述浏览器侧连接器；它支持可选的直登自动化，但不适用于需要绕过 MFA、验证码、SSO 或其他人工挑战的无人值守任务。

## 从 npm 使用

发布后，MCP 客户端会通过 `npx` 下载并在本机启动固定版本的 `@carry-dream/clawer-ticket-server`，无需克隆或构建本仓库。配置文件和凭据不包含在 npm 包内：先从 `config/` 复制合适的 `*.example.json` 到受 Git 忽略的本地安全位置，再将 `CLAWER_TICKET_CONFIG_PATH` 指向它。GraphQL 模式还需在启动环境中提供 `secretRef` 所引用的只读令牌；browser 模式不需要该令牌。

请固定使用已验证的版本号，例如 `@carry-dream/clawer-ticket-server@1.0.0`，而不要省略版本号跟随 `latest`。

## 开发

```bash
npm run build
npm test
npm run dev
```

`npm run start` 运行编译后的 `dist/index.js`。该入口仅使用标准输入/输出传输协议；不要向标准输出添加普通日志。启动错误会写入标准错误。

GraphQL/REST 请求与 ONES 原始响应契约位于 `src/providers/ones/`；该 adapter 在边界内将响应归一化为通用工单。`src/modules/tickets/domain/ports.ts` 定义 provider、浏览器会话和导出存储端口，`TicketApplication` 只依赖这些端口；本地 bundle 实现位于 `src/modules/tickets/infrastructure/export/`。输入不接受任意 URL、Header 或 GraphQL 文本。每次新增能力后，扩展本地 fake-HTTP 测试并运行 `npm run build` 与 `npm test`。
