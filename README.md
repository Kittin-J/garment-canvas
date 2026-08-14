# Garment Canvas

## Docker 启动（推荐）

要求 Docker Desktop / Docker Engine + Compose。先复制 `.env.example` 为私有
`.env`，至少替换 PostgreSQL 密码、AI 网关和首次管理员配置，然后执行：

```bash
docker compose up -d --build --wait
```

网页默认为 `http://localhost:3002`。PostgreSQL 数据保存在 Docker 命名卷
`garment-canvas_postgres_data`，上传和生成文件仍保存在 `data/`。

如果 `data/garment-canvas.db` 存在且 PostgreSQL 还没有用户，首次启动会自动导入
旧 SQLite 中的用户、会话、项目、素材、生成记录和消耗流水。导入成功后原
SQLite 文件会保留，便于回退核对。

## 本地开发

要求 Node.js 20 或更高版本。先只启动 PostgreSQL，再启动开发服务：

```bash
docker compose up -d postgres --wait
npm ci
npm run dev
```

前端开发服务器默认为 `http://localhost:5173`，API 默认为
`http://localhost:3001`，本机 Node 通过 `POSTGRES_HOST_PORT`（默认 54329）连接容器。

`npm run test` 会自动启动隔离的临时 PostgreSQL 容器，运行全部回归后删除测试容器和卷；
测试数据不会污染正式数据。

## 非 Docker 构建与启动

```bash
npm ci
npm run check
npm run build
npm start
```

`npm run build` 会同时生成：

- `dist/`：Vite 前端静态文件；
- `dist-server/index.js`：可由 Node.js 直接运行的服务端产物。

部署机器只需要生产依赖和两个构建目录：

```bash
npm ci --omit=dev
npm start
```

完整生产模式缺少 `dist/index.html` 时会直接退出，避免 API 看似启动成功但前端不可用。
如果前端由其他服务托管，可显式设置 `API_ONLY=true` 启动仅 API 模式。

运行状态接口：

- `GET /api/health`：进程存活检查；
- `GET /api/ready`：检查 PostgreSQL、`DATA_DIR`、AI 配置和完整模式下的前端构建。

用户、会话、项目、素材、生成记录和消耗流水保存在 Docker 内置 PostgreSQL；上传及
生成图片保存在 `DATA_DIR`。当前部署使用本地磁盘，不自动备份，但 PostgreSQL 命名卷
与文件目录已分离，可后续接入备份接口。

首次启动前必须在私有 `.env` 中配置管理员临时凭据（不要提交 `.env`）：

```bash
INITIAL_ADMIN_ACCOUNT_ID=your-admin-account
INITIAL_ADMIN_PASSWORD=your-temporary-password
```

临时密码至少 10 位并同时包含字母和数字。它只在数据库没有任何用户时用于创建首位
管理员；管理员首次登录后必须修改密码。管理员随后可在网页右上角创建、停用、重置或
删除普通用户。每个账号仅保留一个有效设备会话，新设备登录会立即使旧会话失效；会话
固定有效 30 天。

素材默认仅创建者可见，用户可主动共享给所有账号；历史部署包中的素材和上传文件会在
首次启动时登记为全局素材。被项目引用的素材不能删除，普通删除进入 15 天回收期。
生成历史与成功消耗流水由服务端保存，失败记录保留在历史中但不计入消耗。用户可导出
自己的 CSV，管理员可按用户或全部导出。

`/api/ready` 还会检查 AI 网关已配置：必须提供非空的
`CHANGE2PRO_API_KEY`（或 `NANOBANANA_API_KEY`）以及 HTTPS
`CHANGE2PRO_BASE_URL`。该检查不会主动调用外部模型，不会产生费用。

生成和工作流执行接口使用进程内限流：同一 IP 每分钟最多请求 5 次；服务重启后计数重置。

带提示词的 AI 节点可按连线顺序接收最多 8 张参考图；多图编辑通过
Images Edit `image[]` multipart 字段提交。内置模板将“人物场景迁移”与
“图案风格迁移”分开，避免人物/座椅语义污染印花图案处理。
