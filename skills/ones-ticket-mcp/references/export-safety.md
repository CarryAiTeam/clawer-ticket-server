# 本地导出安全契约

仅在用户明确要求下载、导出、保存到本地或“获取到本地”时读取。`ticket_export` 的 `write` 会产生本地文件，是唯一必须取得明确确认的步骤。

## 先计划，再写入

1. 先调用 `ticket_export`，明确传入 `mode: "plan"`；计划不写入本地、不下载二进制。
2. 展示计划中的范围、`selection.expectedCount`、工单/媒体预算和已知大小。
3. 仅在用户对该紧邻计划明确确认后，使用相同选择调用 `mode: "write"`。不要把查看或获取请求当作写入确认。

## 两种选择方式

- 单张：传 `ticket`，先 `mode: "plan"`，确认后以相同 `ticket` 写入。
- 查询：传 `query`，不要传 `page` 或 cursor；确认后的 write 必须携带完全相同的 `query`、计划返回的 `selection` 和相同 `media`。

`media: "download"` 会在 write 下载附件和图片；用户只要详情与附件元数据时传 `media: "metadata"`。两者的 write 都会写入本地。

## 异常与结束

- `SELECTION_CHANGED`：重新 plan，并重新取得确认。
- `EXPORT_LIMIT_EXCEEDED`：缩小范围或分批，不盲目重试。
- `complete: false`：检查 `failedTickets`；重新 plan 后再处理失败项，已有成功 bundle 可复用。
- plan 或已确认的 write 到达终态后，遵循主流程的 `finally` 清理临时 browser session。
