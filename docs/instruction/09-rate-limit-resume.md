# 09 · 限流、重试与断点续传

> 源文件：[src/providers/ones/ones-graphql-source.ts](../src/providers/ones/ones-graphql-source.ts)、[src/modules/tickets/infrastructure/export/local-ticket-bundle-store.ts](../src/modules/tickets/infrastructure/export/local-ticket-bundle-store.ts)。

## 1. 设计目标

- **保护 ONES 服务端**：不通过调高本地预算来规避 ONES 的服务端限制。
- **保护本地导出进度**：达到本地预算时等待下一个可用窗口，而不是把限流变成终止性导出失败。
- **断点续传**：再次导出时用 manifest SHA-256 校验已有文件，仅补下载缺失或损坏的媒体。

## 2. 三层机制

```text
请求 → withRequestSlot (profile 串行) → retryRateLimited (429 退避) → acquireBudget (滑动窗口) → 实际 fetch
```

### 2.1 `withRequestSlot(profile, operation)` — profile 级串行

```ts
protected async withRequestSlot<T>(profile: OnesProfile, operation: () => Promise<T>): Promise<T> {
  const state = this.requestState(profile);
  let release: (() => void) | undefined;
  const previous = state.tail;
  state.tail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await operation();
  } finally {
    release?.();
  }
}
```

- 每个 profile 拥有独立串行请求队列，互不消耗 ONES 请求预算。
- 基于 `state.tail` Promise 链：每个请求等前一个完成才开始。
- `requestState(profile)` 按 `${source}:${baseUrl}:${teamId}` 区分，所以同租户同团队但不同 source（graphql vs browser）是独立队列。

### 2.2 `acquireBudget(profile)` — 滑动窗口

```ts
protected async acquireBudget(profile: OnesProfile): Promise<void> {
  const state = this.requestState(profile);
  for (;;) {
    const now = this.now();
    while (state.times.length > 0 && state.times[0]! <= now - 60_000) state.times.shift();
    if (state.times.length < profile.requestBudget.maxRequestsPerMinute) {
      state.times.push(now);
      return;
    }
    const next = state.times[0]! + 60_000 - now + 1;
    await this.delay(next);
  }
}
```

- 60 秒滑动窗口：删除 60s 前的时间戳，若当前窗口内请求数 < `maxRequestsPerMinute` 则放行（记录时间戳），否则等待到窗口最早时间戳 + 60s + 1ms。
- **达到本地预算时会等待下一个可用窗口**，不抛错。
- 默认 `maxRequestsPerMinute: 20`，最大可配 120。

### 2.3 `retryRateLimited(profile, operation)` — 429 退避重试

```ts
protected async retryRateLimited<T>(_profile: OnesProfile, operation: () => Promise<T>): Promise<T> {
  const maxRetries = 3;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof OnesRateLimitError) || attempt >= maxRetries) throw error;
      const exponential = Math.min(1_000 * 2 ** attempt, 15_000);
      const jitter = Math.floor(Math.random() * 250);
      await this.delay(error.retryAfterMs ?? exponential + jitter);
    }
  }
}
```

- 最多重试 3 次。
- 只对 `OnesRateLimitError`（429）重试，其他错误立即抛出。
- 优先用 `Retry-After`（`error.retryAfterMs`），否则指数退避 `min(1000 * 2^attempt, 15000)` + 0-249ms jitter。

### 2.4 `OnesRateLimitError`

```ts
class OnesRateLimitError extends OnesError {
  constructor(message: string, readonly retryAfterMs?: number) {
    super("SOURCE_RATE_LIMITED", message);
  }
}
```

### 2.5 `retryAfterMilliseconds(value, now)`

```ts
function retryAfterMilliseconds(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Math.round(seconds * 1_000), 60_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(Math.max(date - now, 0), 60_000) : undefined;
}
```

- 支持两种 `Retry-After` 格式：
  - 数字（秒）：`Math.min(seconds * 1000, 60_000)`。
  - HTTP 日期：`date - now`，同样上限 60s。
- 上限 60s 避免长时间阻塞导出。

### 2.6 `rateLimited(message, retryAfter)` 工厂

```ts
protected rateLimited(message: string, retryAfter: string | null): Error {
  return new OnesRateLimitError(message, retryAfterMilliseconds(retryAfter, this.now()));
}
```

- Browser provider 在 `page.evaluate` 内拿不到 Headers 对象，通过此工厂构造 `OnesRateLimitError`。

## 3. 限流触发点

| 触发点 | 行为 |
| --- | --- |
| `requestJson`（GraphQL/REST） | 429 → `OnesRateLimitError`（带 `retry-after`） |
| `downloadResolvedAttachment` | 429 → `OnesRateLimitError`（带 `retry-after`） |
| `downloadAttachment` (browser) | 429 → `this.rateLimited(...)`（带 `retryAfter`） |
| `parseJsonResponse` | 429 → `TicketError("SOURCE_RATE_LIMITED")`（无 retry-after，不会重试） |

> 注意：`parseJsonResponse` 抛的是普通 `TicketError`，不是 `OnesRateLimitError`，所以**不会触发 `retryRateLimited` 重试**。`OnesRateLimitError` 在 `requestJson` / `downloadResolvedAttachment` / browser `downloadAttachment` 中**在调 `parseJsonResponse` 之前**就被显式抛出，确保走重试路径。

## 4. 串行 + 预算的组合效果

- 串行队列保证同一 profile 不会并发请求 ONES。
- 滑动窗口保证 60s 内请求数不超过 `maxRequestsPerMinute`。
- 429 重试保证短暂限流不会终止导出。
- 不同 profile（甚至同租户不同 source）互不阻塞。

## 5. 断点续传

### 5.1 `plan` 阶段

- 读取既有 `_machine/manifest.json`，比较 `contentHash` + `layoutVersion`：
  - 都一致 → `action: "unchanged"`。
  - manifest 存在但不一致 → `action: "updated"`。
  - 无 manifest → `action: "created"`。

### 5.2 `beginExport` 阶段

- 读取既有 `_machine/manifest.json` 与 `_machine/media.json`。
- 对每个 `TicketMediaPlan`：
  1. 取既有 manifest 中该 path 的 sha256（`expected`）。
  2. 取既有 media.json 中该 path 的 `{ attachmentId, hash, contentType }`（`previous`）。
  3. 若 `matchesExistingMedia(item, previous)`（attachmentId 一致 + hash 一致或为空）：
     - `copyVerifiedMedia`：流式复制 + 边读边算 sha256；hash 匹配 `expected` → 视为已验证，加入 `completed`。
     - hash 不匹配或读取失败 → 删除目标，加入 `missingMedia`。
  4. 否则加入 `missingMedia`。
- **已存在且 hash 匹配的媒体不会被重复下载**。

### 5.3 `commit` 阶段

- `plan.action === "unchanged" && missingMedia.length === 0` → 直接读已有产物哈希，删暂存目录，返回 `status: "unchanged"`，不重新生成产物。
- 否则重新生成所有产物（即使 contentHash 不变但 layoutVersion 变了也要重生成）。
- 媒体文件：已验证的从源目录复制到暂存目录，缺失的由应用层 `writeMedia` 写入暂存目录。

### 5.4 `write` 模式的 SHA-256 返回

- `ExportResult.files` 每个文件都带 `sha256`。
- `_machine/manifest.json` 记录所有产物的 sha256、`layoutVersion`、`contentHash`、`exportId`。
- 便于后续校验、布局迁移和幂等更新判断。

## 6. 用户层语义（README 摘要）

> 导出请求按 profile 串行执行，并受 `requestBudget.maxRequestsPerMinute` 的滑动窗口约束。达到本地预算时会等待下一个可用窗口；若 ONES 返回 `429`，会优先遵从 `Retry-After`，否则进行有限次数的退避重试。**不要通过调高预算来规避 ONES 的服务端限制。**

> `ticket_export_my_open_tasks` 可传入 `statuses: ["新建"]`，只读取并导出当前用户处于该状态的工单详情。默认 `media: "download"` 会下载图片和附件；再次导出时会用 manifest SHA-256 校验已有文件，仅补下载缺失或损坏的媒体。只有显式传入 `media: "metadata"` 才会省略二进制下载。

## 7. 边界情况

- **同一工单并发导出**：`lockDirectory` 防止，第二个会得到 `SOURCE_FAILED: Another export for this ticket is already in progress`。
- **导出中途崩溃**：暂存目录与锁目录残留；下次导出会重新创建新暂存目录（`exportId` 不同），但旧锁目录会阻止（需手动清理）。这是有意的保守策略——避免并发覆盖。
- **既有文件损坏**：`copyVerifiedMedia` 的 sha256 校验失败 → 加入 `missingMedia` → 重新下载。
- **既有 manifest 缺失 media.json**：`readExistingMedia` 返回空 media map → 所有媒体都进 `missingMedia`。
- **layoutVersion 升级**：`plan` 返回 `action: "updated"`，`commit` 重新生成所有产物，已有媒体仍按 sha256 校验复用。
- **profile 预算耗尽**：`acquireBudget` 等待，不抛错；导出会变慢但不会失败。
- **429 持续超过 3 次重试**：抛 `SOURCE_RATE_LIMITED`，导出中止；下次调用从断点续传。
