# 14 · 构建与测试

## 常用命令

```bash
npx tsc --noEmit
npm run build
npm test
```

`npx tsc --noEmit` 只检查源码类型，不生成 `dist/`。`npm test` 会先构建，再执行 package/config、ONES fake-provider integration、in-memory MCP 和 compiled stdio 测试。

## V1 覆盖重点

- 只发现六个规范工具，两个旧 wrapper 不存在。
- 默认 `my_open`、`my_active`、显式 `all`，以及一层 AND 条件规范化。
- 非法筛选和原始 ONES 字段返回稳定 `QUERY_INVALID`。
- 公共 cursor 的篡改、跨查询复用和过期拒绝。
- ONES fixture 的 variables、`endCursor → after`、精确总数与缺失 `hasNextPage` 的 fail-closed 行为。
- 搜索摘要人员脱敏、profile 项目白名单最终防线。
- 查询导出 plan/write selection 冻结，以及详情读取失败前不启动写入。

构建、安装、MCP 重载和真实授权 profile 的只读 smoke 属于运行态接入验证，不应与源码级测试混为一谈。
