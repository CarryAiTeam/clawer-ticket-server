# 13 · 运行时调用流程

> 本文档用端到端时序图描述典型调用路径，帮助理解从 MCP 客户端请求到落盘的完整链路。

## 1. 进程启动

```text
node dist/index.js
  ↓
main()
  ↓
createServer()                                   [bootstrap/create-server.ts]
  ↓ 返回 McpServer（尚未加载配置）
new StdioServerTransport()
  ↓
server.connect(transport)
  ↓
MCP Server 监听 stdin，等待客户端工具调用
```

- **配置惰性加载**：`createServer` 内的 `getApplication` 是惰性回调，**首次工具调用时**才 `loadConfig` + `new OnesBrowserSource` + `createTicketApplication`。
- 启动错误写 stderr；正常运行不向 stdout 写普通日志。

## 2. 首次工具调用：`ticket_connection_status`

```text
MCP Client → stdin → MCP Server
  ↓
ticket_connection_status handler
  ↓
getApplication()                                  [首次调用，惰性初始化]
  ├─ loadConfig(configPath)                       [ones-config.ts]
  │    ├─ readFile(CLAWER_TICKET_CONFIG_PATH)
  │    ├─ JSON.parse
  │    └─ parseConfig(zod + host allowlist 校验)
  ├─ new OnesBrowserSource(config)                [同时是 provider + browserSessions]
  ├─ new LocalTicketBundleStore(config.storage.root)
  └─ new TicketApplication({ profiles, provider, bundleStore, redaction, browserSessions: provider, mediaProvider: provider })
  ↓
application.connectionStatus(profileName)
  ├─ profile(name)                                [profile resolver + provider 匹配校验]
  └─ provider.status(selectedProfile)
       ├─ [GraphQL] resolveToken(profile) → EnvSecretProvider.resolve(secretRef)
       ├─ [GraphQL] graphql(profile, MY_OPEN_MATCHED_QUERY, limit=1)
       │    └─ requestJson(POST, items/graphql)
       │         └─ withRequestSlot → retryRateLimited → acquireBudget → http.request → parseJsonResponse
       └─ [Browser] super.listMyOpen(profile, 1) 探针
  ↓
textResult({ ok: true, profile, provider, connector, allowedProjects, ...status })
  ↓
stdout → MCP Client
```

## 3. `ticket_my_open_tasks`（默认 includeDetails: true）

```text
MCP Client → ticket_my_open_tasks handler
  ↓
getApplication()
  ↓
application.listMyOpenDetails(profile, limit)
  ├─ listMyOpen(profile, limit)
  │    └─ provider.listMyOpen(profile, limit)
  │         ├─ [GraphQL] graphql(MY_OPEN_TREE_QUERY) + graphql(MY_OPEN_MATCHED_QUERY)
  │         ├─ 解析 buckets[0].tasks → TicketIndexItem[]
  │         ├─ 按 allowedProjects 过滤
  │         ├─ 用 matchedIds 校准 matchedFilter / includedAsAncestor
  │         ├─ 计算 roots / externalParentIds / page
  │         └─ [Browser] 若配置 myOpenViewUrl，reconciliation：visibleTaskRows → 逐条 getRawTicket → 校准 matched → rebuildTree
  ├─ [安全闸 1] hasNextPage → SOURCE_INCOMPLETE
  ├─ [安全闸 2] matches.length !== page.matchedCount → SOURCE_INCOMPLETE
  └─ for each matched item:
       getTicket(profile, { id })
         ├─ provider.getTicket(profile, reference)
         │    └─ getRawTicket → normalizeOnesTicket (mapper)
         ├─ [项目 allowlist 二次校验]
         └─ redactTicket(ticket, redaction)
  ↓
textResult({ ok: true, ...index, tickets, detailCount, complete: true })
  ↓
stdout → MCP Client
```

## 4. `ticket_get`

```text
MCP Client → ticket_get handler
  ↓
application.getTicketInline(profile, { id })
  ├─ profile(name)
  ├─ getTicket(profile, reference)
  │    ├─ provider.getTicket
  │    │    ├─ [GraphQL] getRawTicket: graphql(DETAIL_QUERY) + graphql(ATTACHMENTS_QUERY) + rest(messages)
  │    │    └─ normalizeOnesTicket(profile, raw)
  │    ├─ [项目 allowlist 二次校验]
  │    └─ redactTicket
  └─ projectTicketForInline(ticket, inlineMaxChars)
       ├─ 描述预算 = floor(inlineMaxChars * 0.6)，clip
       ├─ 评论按剩余预算逐条 clip，单条上限 2000
       └─ 附件/关系/自定义字段截断到前 100
  ↓
textResult({ ok: true, ticket: InlineTicket })
  ↓
stdout → MCP Client
```

## 5. `ticket_export`（mode: write, media: download）

```text
MCP Client → ticket_export handler
  ↓
application.exportTicket(profile, { id }, "write", "download")
  ├─ getTicket(profile, reference)                 [归一化 + 校验 + 脱敏]
  ├─ mediaPlan(ticket)                             [去重 + 角色合并 + 路径计算]
  │    ├─ for each attachment: add(attachment, "attachment")
  │    ├─ for each descriptionImage: 找附件 add(attachment, "description-image")
  │    └─ for each comment.image: 找附件 add(attachment, "comment-image")
  └─ downloadMissingMedia(profile, ticket, media)
       ├─ bundleStore.beginExport(ticket, media)   [LocalTicketBundleStore]
       │    ├─ directory = <root>/<provider>/<project>/<ticket>
       │    ├─ exportId = randomUUID()
       │    ├─ lockDirectory = <directory>.lock     [mkdir 原子锁]
       │    ├─ stagingDirectory = <directory>.<exportId>.tmp
       │    ├─ plan(ticket, media)                  [读既有 manifest，算 contentHash/action]
       │    ├─ readExistingMedia(plan.directory)    [读 _machine/manifest.json + _machine/media.json]
       │    ├─ for each media item:
       │    │    若 matchesExistingMedia 且 copyVerifiedMedia 成功 → completed
       │    │    否则 → missingMedia
       │    └─ 返回 TicketExportWriteSession { missingMedia, writeMedia, commit, abort }
       ├─ for each item in session.missingMedia:
       │    mediaProvider.downloadAttachment(profile, item.attachment)
       │      ├─ [GraphQL] resolveAttachmentUrl (GET res/attachment/{id}) → 临时 URL（内存）
       │      └─ downloadResolvedAttachment: fetch 临时 URL → bytes
       │    session.writeMedia(item, download)      [写入 stagingDirectory，算 sha256]
       ├─ session.commit()
       │    ├─ 校验 completed.size === media.length
       │    ├─ [unchanged 快路径] plan.action === "unchanged" && missingMedia.length === 0
       │    │    → 读已有产物哈希，删暂存目录，返回 status: "unchanged"
       │    ├─ [正常路径] 生成 ticket.md / 3 个 README.md / 5 个 _machine/*.json / manifest.json
       │    ├─ 写入所有产物到 stagingDirectory
       │    ├─ commitDirectory(staging, destination, exportId)
       │    │    ├─ rename(destination, *.previous)  [可选]
       │    │    ├─ rename(staging, destination)
       │    │    └─ rm(*.previous)
       │    └─ 返回 ExportResult { files: [{path, sha256}], action, status, exportId }
       └─ [catch] session.abort()                   [删暂存目录 + 锁目录]
  ↓
textResult({ ok: true, export: ExportResult })
  ↓
stdout → MCP Client
```

## 6. `ticket_export_my_open_tasks`（mode: write, media: download, statuses: ["新建"]）

```text
MCP Client → ticket_export_my_open_tasks handler
  ↓
application.exportMyOpenTickets(profile, limit, "write", "download", ["新建"])
  ├─ listMyOpenDetailsForExport(profile, limit, ["新建"])
  │    ├─ listMyOpen(profile, limit)
  │    ├─ [安全闸 1] hasNextPage → SOURCE_INCOMPLETE
  │    ├─ [安全闸 2] expected.length !== page.matchedCount → SOURCE_INCOMPLETE
  │    ├─ selectedStatuses = ["新建"]
  │    ├─ selected = expected.filter(item => item.status && selectedStatuses.includes(item.status))
  │    └─ for each selected item: getTicket → tickets[]
  └─ for each ticket in tickets:
       media = mediaPlan(ticket)
       downloadMissingMedia(profile, ticket, media)   [同 §5 的事务会话流程]
       exports.push(ExportResult)
  ↓
textResult({ ok: true, export: { matchedCount, selectedCount, detailCount, complete, exports } })
  ↓
stdout → MCP Client
```

- **先全部读取详情成功，再批量导出**——避免失败时落盘不完整的摘要数据。
- 每张工单独立事务会话；某一张失败会中断整批，但已写入的会保留。

## 7. `ticket_browser_connect`（browser profile）

```text
MCP Client → ticket_browser_connect handler
  ↓
application.openBrowserSession(profile)
  └─ browserSessions().openBrowserSession(profile)   [OnesBrowserSource]
       ├─ profileFor(ticketProfile)
       ├─ ensurePage(profileName, profile)
       │    ├─ [若已有 page] 校验 activeProfileName 一致
       │    ├─ [否则] 找 Chrome 路径 (browser.executablePath / ONES_BROWSER_EXECUTABLE_PATH / DEFAULT_CHROME_PATHS)
       │    ├─ chromium.launch({ executablePath, headless: false })
       │    ├─ browser.newContext()                   [内存 context]
       │    ├─ context.newPage()
       │    ├─ page.goto(startUrl = myOpenViewUrl ?? workspace 入口)
       │    ├─ activeProfileName = profileName         [先绑定]
       │    └─ autoLogin(profile, page)                [可选]
       │         ├─ page.goto(login.loginUrl)
       │         ├─ isAllowedBrowserPage 校验
       │         ├─ emailInput / passwordInput waitFor visible
       │         ├─ fill(email) / fill(password)
       │         └─ submit click
       │              └─ [失败] throw HUMAN_ACTION_REQUIRED
       ├─ [autoLogin 配置] waitForAutoLoginAuthorization
       │    └─ for delay in [500, 1000, 2000, 4000]:
       │         page.waitForTimeout(delay)
       │         status(ticketProfile)                 [窄范围探针]
       │         if authorized: return
       └─ [未配置 autoLogin] authorized: false, 提示手动登录
  ↓
textResult({ ok: true, url, message, authentication: { mode, authorized, diagnostics } })
  ↓
stdout → MCP Client
```

## 8. `ticket_browser_disconnect`

```text
MCP Client → ticket_browser_disconnect handler
  ↓
application.closeBrowserSession(profile)
  └─ browserSessions().closeBrowserSession(profile)
       ├─ browser?.close()
       ├─ browser = undefined
       ├─ context = undefined
       ├─ page = undefined
       ├─ csrfToken = undefined
       ├─ activeProfileName = undefined
       └─ ticketCache.clear()
  ↓
textResult({ ok: true, closed: true })
  ↓
stdout → MCP Client
```

## 9. Browser profile 的 `listMyOpen` reconciliation 流程

```text
application.listMyOpen(profile, limit)
  └─ provider.listMyOpen(profile, limit)             [OnesBrowserSource override]
       ├─ super.listMyOpen(profile, limit)           [复用 GraphQL 实现]
       │    ├─ graphql(MY_OPEN_TREE_QUERY)
       │    ├─ graphql(MY_OPEN_MATCHED_QUERY)
       │    └─ 返回 index（含 matchedFilter 标记）
       ├─ [若 source !== browser] return index
       ├─ [若无 myOpenViewUrl] return index
       ├─ existingMatches = index.items.filter(matchedFilter === true)
       ├─ currentAssigneeIds / currentAssigneeNames  [从 existingMatches 提取]
       ├─ [若 currentAssigneeIds.size === 0] throw SOURCE_SCHEMA_CHANGED
       ├─ visibleRows = visibleTaskRows(profile)
       │    ├─ page.goto(myOpenViewUrl)
       │    └─ for attempt in 0..5:
       │         page.evaluate(读取 a[href*="/task/"] 链接)
       │         若有行 → 去重返回
       │         否则 waitForTimeout(250)
       ├─ for each { id, text } in visibleRows:
       │    ├─ [已知 id] continue
       │    ├─ [assigneeNames 不匹配] continue
       │    ├─ raw = super.getRawTicket(profile, { id })
       │    ├─ assigneeId = raw.detail.assign.uuid
       │    ├─ [不在 currentAssigneeIds] continue
       │    ├─ ticketCache.set(id, raw)              [缓存，供后续 getRawTicket 复用]
       │    └─ item = normalizeIndexItem(profile, raw.detail)
       │         item.matchedFilter = true
       │         item.includedAsAncestor = false
       │         index.items.push(item)
       └─ rebuildTree(index)                          [重算 roots / externalParentIds / page]
  ↓
返回 TicketIndexTree
```

## 10. 限流时序

```text
provider.listMyOpen / getTicket / downloadAttachment
  ↓
requestJson / downloadResolvedAttachment
  ↓
withRequestSlot(profile, operation)                  [profile 级串行]
  └─ retryRateLimited(profile, operation)            [429 退避重试]
       └─ acquireBudget(profile)                     [滑动窗口]
            ├─ 删除 60s 前的时间戳
            ├─ if times.length < maxRequestsPerMinute: push(now), return
            └─ else: delay(times[0] + 60_000 - now + 1), 重试
       ↓
       operation()
       ├─ [429] throw OnesRateLimitError(retryAfterMs)
       │    └─ [attempt < 3] delay(retryAfterMs ?? exponential + jitter), 重试
       │    └─ [attempt >= 3] throw
       ├─ [401/403] throw SOURCE_UNAUTHORIZED (或 HUMAN_ACTION_REQUIRED for browser)
       ├─ [其他非 2xx] throw SOURCE_FAILED
       └─ [2xx] parseJsonResponse → 返回
```

## 11. 错误传播时序

```text
Provider / Infrastructure
  └─ throw new TicketError(code, message) | throw new OnesRateLimitError(...) | throw 其他 Error
       ↓
TicketApplication 用例
  ├─ [status 方法] 吞并 TicketError，返回 ConnectionStatus { authorized: false, diagnostics }
  └─ [其他方法] 直接抛出
       ↓
Delivery tool handler 的 try/catch
  └─ errorResult(error)
       ├─ [TicketError] { ok: false, error: { code, message } }, isError: true
       └─ [其他] { ok: false, error: { code: "UNEXPECTED", message } }, isError: true
       ↓
stdout → MCP Client
```

## 12. 关键时序不变量

- **配置惰性加载**：首次工具调用才加载配置、创建 provider/application。
- **provider 单例**：`getApplication` 内 `application` 变量缓存，后续调用复用。
- **profile 级串行**：同一 profile 的所有请求串行，不同 profile 互不阻塞。
- **详情完整性**：`listMyOpenDetails` / `exportMyOpenTickets` 必须先全部读取详情成功。
- **脱敏前置**：`getTicket` 是所有读路径的漏斗，返回前必脱敏。
- **事务原子性**：`beginExport` → `writeMedia`*N → `commit`/`abort`，暂存目录 + 锁目录保证。
- **断点续传**：`beginExport` 已暂存并校验已有媒体，只下载 `missingMedia`。
- **临时 URL 不持久化**：`resolveAttachmentUrl` 的 URL 只存在于 `downloadAttachment` 栈帧。
