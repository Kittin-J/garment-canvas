# Garment Canvas

## 本地开发

要求 Node.js 20 或更高版本。

```bash
npm ci
npm run check
npm run dev
```

前端开发服务器默认为 `http://localhost:5173`，API 默认为
`http://localhost:3001`。

`npm run test` 会同时运行 DAG/Run、工作流 Schema、图片、SSRF、AI Provider 与限流回归；
测试数据只写入临时目录，不会污染 `data/`。

## 生产构建与启动

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
- `GET /api/ready`：检查 `DATA_DIR` 是否可写，以及完整模式下前端构建是否存在。

持久化目录可通过 `DATA_DIR` 指定，生产部署应将其指向有备份的持久卷。

`/api/ready` 还会检查 AI 网关已配置：必须提供非空的
`CHANGE2PRO_API_KEY`（或 `NANOBANANA_API_KEY`）以及 HTTPS
`CHANGE2PRO_BASE_URL`。该检查不会主动调用外部模型，不会产生费用。

生成和工作流执行接口使用进程内限流：同一 IP 每分钟最多请求 5 次；服务重启后计数重置。

带提示词的 AI 节点可按连线顺序接收最多 8 张参考图；多图编辑通过
Images Edit `image[]` multipart 字段提交。内置模板将“人物场景迁移”与
“图案风格迁移”分开，避免人物/座椅语义污染印花图案处理。
