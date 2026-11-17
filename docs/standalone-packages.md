# 独立部署包（Windows / Linux）

Search Hub 现在有三种部署形态，共用同一套搜索核心、数据库模型与管理后台：

| 形态 | 前提 | 数据目录 |
|---|---|---|
| Windows 解压包 | 无（不需要 Node/pnpm/Git/Docker） | `%LOCALAPPDATA%\SearchHub` |
| Linux tar.gz | 无（不需要 Node/pnpm） | `~/.local/share/search-hub`（或 `SEARCH_HUB_DATA_DIR`） |
| Docker Compose | Docker | 命名卷 `search-hub-data` |

三种形态的搜索缓存都在数据目录下的同一个 SQLite 文件里（表 `search_cache`），
因此升级、重启、容器重建不会丢缓存；删数据目录/卷才会丢，与其它数据一致。
详见 [search-cache.md](./search-cache.md)。

## 构建

```bash
# Windows x64（在 Windows 上执行）
PACKAGE_TARGET=windows-x64 node packaging/build-package.mjs

# Linux x64 / arm64（在 Linux 上执行；arm64 需指定 arm64 运行时）
PACKAGE_TARGET=linux-x64 node packaging/build-package.mjs
PACKAGE_TARGET=linux-arm64 PACKAGE_NODE_BIN=/path/to/arm64/node node packaging/build-package.mjs
```

产物：`dist/package/search-hub-v<版本>-<target>.{zip,tar.gz}` 与同名 `.sha256`。

正式发布由 `.github/workflows/release.yml` 完成：打 tag（如 `v0.1.4-beta.5`）后，
在 windows-latest、ubuntu-latest、ubuntu-24.04-arm 上分别构建并跑同一套验收，
三个平台全部通过才会创建 prerelease 并上传 `SHA256SUMS`。

## 包内结构

```
SearchHub.exe            Windows 启动器（Node SEA）
bin/search-hub           Linux 启动器脚本
runtime/                 随包 Node 运行时（无需安装）
app/apps/api/dist/       server.mjs（单文件，含全部依赖）
app/apps/web/dist/       管理界面静态资源
app/packages/db/          SQLite 迁移脚本
app/node_modules/        仅 better-sqlite3（原生 .node 无法打包进 bundle）
launcher.json            启动器清单
README.txt / README.md   使用说明
search-hub.service       Linux systemd 模板
```

服务端刻意**不**塞进 EXE：`better_sqlite3.node` 是原生模块，无法从 SEA blob 内加载。
EXE 只做启动器，负责数据目录、端口、单实例、健康检查与浏览器跳转。

## 启动器命令

```
SearchHub.exe                 启动并打开浏览器
SearchHub.exe --port 9000     换端口（保存）
SearchHub.exe --lan           监听 0.0.0.0（有安全提示）
SearchHub.exe --service       后台运行，不打开浏览器（Windows Server）
SearchHub.exe --status        状态 / 地址 / 日志路径
SearchHub.exe --stop          停止
SearchHub.exe --logs          最近日志（截取末尾 64 KiB）
SearchHub.exe --autostart     写入当前用户启动文件夹
SearchHub.exe --no-autostart  取消
```

Linux 对应 `./bin/search-hub ...`，语义相同；headless 环境不会尝试打开浏览器。

## 安全边界

- 默认只监听 `127.0.0.1`，不修改防火墙。
- `--lan` 会打印明确警告：局域网内任何人都能访问管理后台。
- 管理员密码加盐哈希；API/MCP Token 与登录凭据分开，可单独吊销。
- 主密钥 `master.key` 与数据库同目录，备份时必须一起带走，否则已保存的 API Key 无法解密。
- 单实例锁 `launcher.lock`（pid + 端口）避免两个进程写同一个 SQLite 文件。

## 验收

`node packaging/verify-package.mjs <target>` 会解压到临时目录、**从 PATH 中移除 node/pnpm** 后启动，
依次验证：健康检查 → 首次初始化 → 创建 Provider → REST 搜索 → MCP initialize/tools.list/tools.call →
数据库与主密钥落盘 → 停止 → 再次启动后数据仍在。

GitHub Actions 的 `Release packages` 工作流在真实 Windows/Linux 上跑同一脚本，
只有全部通过才会发布 prerelease 并上传 SHA256SUMS。
