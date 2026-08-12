# 历史架构草案（已被 V1 取代）

本文曾描述包含树形待办、专用批量导出和兼容 wrapper 的早期方案。该方案没有作为当前实现规范继续生效。

当前 V1 的唯一需求依据是 [ticket_search 首版需求冻结与实施计划](../.cloudpivot-cli/task-runs/ticket-tool-surface-design/v1-requirements-and-delivery-plan.md)：

- 只注册六个规范工具；
- 用单一 `ticket_search` 表达我的待办、我的活跃工单与受控自定义查询；
- 不保留 `ticket_my_open_tasks`、`ticket_export_my_open_tasks`、`includeDetails`、树形索引或 `statuses`；
- 查询导出通过 `ticket_export({ query, mode })` 的 plan/write selection 协议完成。

如需新增能力，请更新当前 V1 需求和真实证据，不要恢复本历史草案中的旧接口。
