# Garment Canvas · Mac mini 部署包

## 系统要求

- macOS 13 或更高版本。
- Node.js 20 或更高版本。
- Docker Desktop（必须已启动），数据库由本机 Docker 内置 PostgreSQL 提供。
- `universal-online` 包支持 Apple Silicon 与 Intel，首次安装需要访问 npm registry 和 Docker Hub。
- `darwin-*-offline` 包已附带生产依赖和 PostgreSQL 镜像，仅用于打包时对应的 Mac 架构。

## 安装

1. 解压压缩包。
2. 双击 `install.command`，或在终端执行：

   ```bash
   ./install.command
   ```

3. 安装脚本会创建：

   - 版本程序：`~/Applications/GarmentCanvas/releases/<版本>`
   - 当前版本：`~/Applications/GarmentCanvas/current`
   - 数据：`~/Library/Application Support/GarmentCanvas/data`
   - PostgreSQL：Docker 容器 `garment-canvas-postgres`、命名卷 `garment-canvas-postgres-data`
   - 私密配置：`~/Library/Application Support/GarmentCanvas/config/service.env`
   - 日志：`~/Library/Logs/GarmentCanvas`
   - 开机自启：`~/Library/LaunchAgents/com.garmentcanvas.server.plist`

安装器会先核验包内文件清单；校验失败时不会继续安装。

4. 编辑生成的配置文件：

   ```bash
   open -e "$HOME/Library/Application Support/GarmentCanvas/config/service.env"
   ```

   安装器会自动生成 PostgreSQL 强密码。首次部署必须填写
   `INITIAL_ADMIN_ACCOUNT_ID` 和 `INITIAL_ADMIN_PASSWORD`。
   初始密码只在数据库没有用户时使用，首次登录后会强制修改；请勿把实际密码写回安装包或提交到 Git。

5. 双击 `start.command`。启动成功后访问：

   <http://127.0.0.1:3001/>

## 内网访问

其他内网设备使用 Mac mini 的局域网 IP，例如：

```text
http://192.168.1.20:3001/
```

请按你的路由器和 macOS 防火墙策略，仅允许可信内网访问 TCP 3001。

## 数据迁移

如果同时拿到了独立的数据包，将它与 `restore-data.command` 放在同一目录，执行：

```bash
./restore-data.command ./garment-canvas-data.tar.gz
```

恢复前先停止服务。脚本不会直接覆盖现有文件；若目标目录已有内容，会先改名备份。

从旧 SQLite 版本升级时，请在首次启动新版本前恢复数据包。PostgreSQL 为空时，
新版本会自动只读导入 `data/garment-canvas.db`，并保留原文件。

## 日常命令

```bash
./start.command
./stop.command
./status.command
```

卸载程序但保留文件和 PostgreSQL 命名卷：

```bash
./uninstall.command
```

## 更新

解压新版本后再次运行 `install.command`。它会安装到新的版本目录，再原子切换 `current`；不会覆盖私密配置、业务数据和日志。旧版本暂时保留，便于回退。

升级应安排在没有生成任务运行时进行：当前任务队列保存在内存中，服务重启会中断未完成任务。

## 排错

```bash
tail -f ~/Library/Logs/GarmentCanvas/server.log
tail -f ~/Library/Logs/GarmentCanvas/server-error.log
docker logs garment-canvas-postgres
curl http://127.0.0.1:3001/api/ready
```

`LaunchAgent` 会在该用户登录后运行；如果要求机器尚未登录也自动运行，需要另行配置带专用用户的系统级 `LaunchDaemon`。

如 macOS 因下载隔离属性阻止执行，可在 Finder 中右键 `install.command` 并选择“打开”。

传输后可在压缩包所在目录校验外层文件：

```bash
shasum -a 256 -c SHA256SUMS-*.txt
```
