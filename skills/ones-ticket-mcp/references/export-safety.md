# 导出与批量安全

仅在用户要求获取、下载、导出、保存到本地、“获取到本地”、同步到本地或同步更新本地时使用 `ticket_export`。`write` 会产生本地文件；这些明确指令本身就是写入授权，不重复索取确认。

## 选择与媒体

- “获取”默认表示本地写入：`mode: "write", media: "download"`。
- 只有明确要求“仅文本”“不要下载图片/附件/媒体”时，才传 `media: "metadata"`；不得为了缩小输出或提高速度使用它。
- 出现“计划、预览、先看看”时才使用 `mode: "plan"`。不要先展示计划再要求“确认下载”；普通小范围导出直接写入，而大范围确认由服务返回的冻结 selection 触发。
- `plan` 返回的 `selection` 只能与相同 query、media 一起用于 `write`；变化返回 `SELECTION_CHANGED`，不得静默扩大写入范围。
- 查询 `write` 会在服务端固定使用每页 50 条的 cursor 分页。最终选择 1–50 条直接完整写入；51–2,000 条第一次只返回 `EXPORT_CONFIRMATION_REQUIRED` 和冻结 selection，零详情读取、零媒体下载、零本地写入。先向用户展示数量，得到明确确认后才以同一 query、media、selection 再次调用；不要向工具传 page 或拆成单张调用。
- `maxItems` 是 2,000 的硬上限；超过它返回 `EXPORT_LIMIT_EXCEEDED`，不得声称已导出前 50 条。确认只覆盖工单范围，媒体预算仍在实际执行时强制。

## 三工位补位

- 一次查询导出是一个 `ticket_export` 调用，不要拆成多个并发调用。
- 服务端最多启动 3 个工位；每个工位依次执行一张工单的详情读取、附件下载和原子 bundle 提交。
- 任一工位完成后立即领取下一张，不等待其余工位；这样不会混写工单，也不会空等。
- 附件在单张工单内顺序下载。`exports` 与 `failedTickets` 按原选择顺序返回，`completedTickets` 表示实际完成顺序。
- 30 秒是进度观察阈值。取消后停止补位；正在处理的工单不被强杀。

## 完成判定与异常

## 同步完成条件

同步到本地或同步更新本地只有同时满足以下条件才可称为成功：

1. 参数为 `mode: "write", media: "download"`；
2. 查询结果 `complete: true`，且 `selectedCount === completedCount`、`failedTickets` 为空；
3. 汇总 `budget.mediaMode === "download"`；
4. 每个 bundle 的 `_machine/manifest.json` 完整，`downloadedMediaCount` 与计划媒体数量相符；不满足时不得称“同步成功”。

- `EXPORT_CONFIRMATION_REQUIRED`：展示 `details.confirmation.selectedCount` 并等待用户确认；确认后只回传该错误中的 selection 与不变的 query、media。
- `EXPORT_LIMIT_EXCEEDED`：缩小范围或分批；不要盲目重试。
- `complete: false`：检查 `failedTickets`；重新 plan 后仅继续失败项，已成功 bundle 可幂等复用。
- `SOURCE_UNAUTHORIZED` / `HUMAN_ACTION_REQUIRED`：服务端只自动恢复一次。仅在 `details.authorizationState: "manual-action-required"` 时保留页面并要求用户完成实际操作。
- `AUTHORIZATION_PENDING`：自动登录已提交但会话仍在结算；保持页面后只重试原导出一次，不要求用户登录或完成 MFA、CAPTCHA、SSO。
- 自动创建并授权的会话由服务端在终态清理；显式连接的会话由调用方断开。
