# 14 · 构建与测试

> 相关文件：[package.json](../package.json)、[tsconfig.json](../tsconfig.json)、[test/](../test/)。

## 1. 构建配置

### 1.1 `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "rootDir": "src",
    "outDir": "dist",
    "strict": true,
    "types": ["node"],
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["dist"]
}
```

- `target: ES2022`：使用现代 JS 特性。
- `module: NodeNext` + `moduleResolution: NodeNext`：Node 原生 ESM。
- `strict: true`：严格类型检查。
- `rootDir: src` / `outDir: dist`：源码与产物分离。
- `include: src/**/*.ts`：只编译 src，测试用 `tsx` 直跑。

### 1.2 `package.json` 关键字段

```json
{
  "name": "clawer-ticket-server",
  "version": "1.0.0",
  "description": "Generic ticket-ingestion MCP server; ONES GraphQL is the first provider.",
  "main": "./dist/index.js",
  "bin": {
    "clawer-ticket-server": "./dist/index.js"
  },
  "files": ["dist", "config/*.example.json", "README.md"],
  "engines": { "node": ">=20" },
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsx src/index.ts",
    "start": "node dist/index.js",
    "prepack": "npm run build",
    "test": "npm run build && tsx test/package/npm-package.test.ts && tsx test/config/config-examples.test.ts && tsx test/integration/providers/ones/ones-provider.test.ts && tsx test/mcp/ticket-tools.test.ts && tsx test/mcp/stdio.test.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.30.0",
    "playwright-core": "^1.62.0",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@types/node": "^26.1.2",
    "tsx": "^4.23.1",
    "typescript": "^7.0.2"
  }
}
```

- `type: "module"`：ESM。
- `main: ./dist/index.js`：编译产物入口；`bin` 将其注册为 `clawer-ticket-server` 命令。
- `files`：npm 归档只包含运行产物、公开示例配置与 README，不会包含本地配置或导出数据。
- `prepack`：执行 `npm pack` 或 `npm publish` 前先编译，确保 `npx` 下载到可直接运行的 `dist/`。
- 依赖：MCP SDK、playwright-core（不下载浏览器，用系统 Chrome）、zod v4。
- devDependencies：仅 `@types/node`、`tsx`、`typescript`。

## 2. 脚本

| 命令 | 作用 |
| --- | --- |
| `npm run build` | `tsc -p tsconfig.json`，编译 `src/` → `dist/` |
| `npm run dev` | `tsx src/index.ts`，开发模式直跑 TS |
| `npm start` | `node dist/index.js`，运行编译产物 |
| `npm test` | build + npm 包、配置、provider、内存 MCP、stdio MCP 测试 |

## 3. 测试结构

```text
test/
  integration/
    providers/
      ones/
        ones-provider.test.ts      # ONES provider 集成测试（fake HTTP）
  mcp/
    stdio.test.ts                  # stdio 传输冒烟测试
    ticket-tools.test.ts           # 7 个工具的 in-memory MCP 测试
```

### 3.1 `test/mcp/ticket-tools.test.ts`

- 用 `InMemoryTransport` 创建 linked pair（client + server）。
- 自建 fake `TicketProvider` / `TicketBundleStore` / `StaticTicketProfileResolver`。
- `createServer({ application: new TicketApplication({ ... }) })` 注入测试 application。
- 断言：
  - 7 个工具都注册（`ticket_browser_connect` / `ticket_browser_disconnect` / `ticket_connection_status` / `ticket_my_open_tasks` / `ticket_get` / `ticket_export` / `ticket_export_my_open_tasks`）。
  - `ticket_connection_status` / `ticket_my_open_tasks` / `ticket_get` 调用成功（`isError: undefined`）。
  - `ticket_export` 默认 `media: "download"`，`mode: "plan"` 调用成功。

### 3.2 `test/mcp/stdio.test.ts`

- 测试 stdio 传输的冒烟（具体见该文件）。

### 3.3 `test/integration/providers/ones/ones-provider.test.ts`

- ONES provider 集成测试，用 fake HTTP（具体见该文件）。
- 每次新增能力后，扩展本地 fake-HTTP 测试并运行 `npm run build` 与 `npm test`。

## 4. 构建产物

- `dist/` 目录（被 `.gitignore` 排除）。
- 入口：`dist/index.js`。
- ESM 模块，`.js` 文件，import 路径需带 `.js` 后缀（NodeNext 要求）。

## 5. 部署形态

```json
{
  "mcpServers": {
    "clawer-ticket": {
      "command": "npx",
      "args": ["-y", "clawer-ticket-server@1.0.0"],
      "env": {
        "CLAWER_TICKET_CONFIG_PATH": "D:/secure/clawer-ticket.config.json",
        "ONES_READ_TOKEN": "<token>"
      }
    }
  }
}
```

- 先 `npm run build` 生成 `dist/`。
- 已发布版本由 MCP 客户端用 `npx -y clawer-ticket-server@<version>` 启动；源码开发时仍可用 `node dist/index.js`。
- `env` 中提供配置路径与（GraphQL profile）token。
- 入口仅使用标准输入/输出传输协议；**不要向标准输出添加普通日志**。

## 6. 开发流程建议

1. 修改 `src/`。
2. `npm run build` 确保类型检查通过。
3. 扩展 `test/` 覆盖新能力。
4. `npm test` 运行全部测试。
5. `npm run dev` 本地启动调试（stdio 传输，可配合 MCP 客户端调试工具）。

## 7. 注意事项

- **`npm run start` 运行编译后的 `dist/index.js`**，开发时用 `npm run dev`。
- **不要向 stdout 添加普通日志**——stdout 是 MCP JSON-RPC 通道，普通日志会破坏协议。
- 启动错误写 stderr。
- `playwright-core` 不下载浏览器，依赖系统 Chrome；Browser profile 需配置 `browser.executablePath` 或 `ONES_BROWSER_EXECUTABLE_PATH` 环境变量。
- 配置文件应放在受控位置，被 Git 忽略；不要提交真实凭据。
- `npm test` 会先 build 再跑测试，确保测试针对最新代码。
