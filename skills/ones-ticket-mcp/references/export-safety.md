# 本地导出与预览契约

仅在用户明确要求下载、导出、保存到本地或“获取到本地”时读取。`ticket_export` 的 `write` 会产生本地文件；明确的本地导出指令本身就是写入授权，不重复索取确认。

## 选择模式

1. 只有用户在同一导出请求中明确说“计划、预览、先看看、先查看范围、先给我计划”等，才传 `mode: "plan"`。plan 不写本地、不下载二进制，只返回范围、selection、媒体预算和已知大小。
2. 其他明确的本地导出请求传 `mode: "write"`。不要先展示计划再要求“确认下载”；在同一请求中直接完成导出并返回结果。
3. 预览后的后续“按刚才计划导出”是新的明确写入请求：查询导出必须带完全相同的 query、计划返回的 selection 和相同 media。

## 两种写入方式

- 单张：明确下载时传 `ticket` 和 `mode: "write"`；只有显式预览时才传 `mode: "plan"`。
- 查询直接导出：传 `query` 和 `mode: "write"`，不要传 page/cursor 或 selection；服务在同一调用中冻结并写入当前选择。
- 查询按计划导出：传 `query`、此前的 `selection`、相同 media 和 `mode: "write"`；服务会拒绝已变化的选择。

`media: "download"` 会在 write 下载附件和图片；用户只要详情与附件元数据时传 `media: "metadata"`。两者的 write 都会写入本地。

## 异常与结束

- `SELECTION_CHANGED`：重新 plan 并展示变化后的范围；不要静默把已计划的写入扩大到新选择。
- `EXPORT_LIMIT_EXCEEDED`：缩小范围或分批，不盲目重试。
- `complete: false`：检查 `failedTickets`；重新 plan 后再处理失败项，已有成功 bundle 可复用。
- plan 或 write 到达终态后，遵循主流程的 `finally` 清理临时 browser session。
