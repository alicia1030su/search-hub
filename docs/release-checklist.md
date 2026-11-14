# Release checklist

用于 v0.1.2 及之后每次公开发布。**没有证据的项不能打勾。**

## 1. 代码与测试

- [ ] `corepack pnpm install --frozen-lockfile` 退出码 0
- [ ] `corepack pnpm typecheck` 退出码 0
- [ ] `corepack pnpm lint` 0 warning / 0 error
- [ ] `corepack pnpm test` 全部通过（记录用例数）
- [ ] `corepack pnpm build` 产出 `apps/web/dist`、`apps/api/dist/server.mjs`、`packages/mcp/dist/stdio.mjs`
- [ ] `corepack pnpm test:e2e` 全部通过
- [ ] `bash tests/scripts/smoke.sh <fresh-instance>` 输出 `SMOKE TEST PASSED`
- [ ] `node tests/scripts/clean-install.mjs` 全部 PASS
- [ ] `node tests/scripts/leak-scan.mjs` 0 命中
- [ ] `node tests/scripts/mcp-live.mjs --url ... --token ...` 20/20
- [ ] `node tests/scripts/live-search.mjs --url ... --token ...` 全部 PASS（仅当有真实 provider）
- [ ] `node scripts/ac-matrix.mjs` 通过，矩阵恒为 16 项
- [ ] `node scripts/secret-scan.mjs` PASS（工作区 + 历史）

## 2. 安全

- [ ] `corepack pnpm audit --audit-level high` 无 HIGH/CRITICAL
- [ ] 镜像扫描（trivy / docker scout）无 HIGH/CRITICAL；或有书面豁免理由
- [ ] 仓库中无真实 API Key / Token / 代理凭证 / 内网地址
- [ ] `SEARCH_HUB_PROXY` 相关测试通过：代理模式下私网/回环/元数据在应用层被拒且代理收不到请求
- [ ] `/api/health` 与启动日志不打印密钥、代理 userinfo
- [ ] 备份接口使用 Online Backup API；并发写入下 `integrity_check=ok`
- [ ] 恢复演练在隔离目录完成，未触碰生产数据

## 3. Docker / 部署

- [ ] `docker build` 成功，记录镜像大小
- [ ] `docker compose up -d` 到 `/api/health` 200
- [ ] 首次初始化：无 token 403，正确 token 200
- [ ] Web 管理端可登录并完成一次真实搜索
- [ ] `docker compose restart` 后配置与统计一致
- [ ] `down`（不删 volume）→ `up` 后数据仍在
- [ ] `docker kill` 后自动拉起且数据未损坏
- [ ] `docker stats` 记录空载 / 负载资源
- [ ] 以上任一项无法执行 → 标记 BLOCKED 并写明原因，不算通过

## 4. 文档

- [ ] `README.md` / `README_EN.md` 版本、provider 数量、测试数量与实际一致
- [ ] `CHANGELOG.md` 有本次版本条目（Added / Changed / Fixed / Known limitations）
- [ ] `docs/acceptance-report.md` 引用 `docs/ac-matrix.md`，不再维护第二份手工统计
- [ ] Provider 矩阵状态与 `catalog.ts` 的 `verification` 一致
- [ ] 部署文档的安装顺序、备份、代理边界与代码一致
- [x] 所有 `<your-org>` 占位符已替换为 `alicia1030su`（2026-11-14）
- [ ] 未实现的能力仍在 UI/文档中标注"未实现"

## 5. 发布动作（需维护者授权，缺一不可）

- [ ] 维护者明确授权 push
- [ ] 维护者明确授权打 tag `vX.Y.Z`
- [ ] 维护者明确授权创建 GitHub Release
- [ ] Release notes 链接 CHANGELOG 与验收报告
- [ ] 发布后回滚路径已写清（上一 tag + 数据迁移兼容性说明）
