#!/usr/bin/env node
/**
 * Builds a self-contained Search Hub package for one platform.
 *
 * Layout produced:
 *   <out>/SearchHub.exe            (Windows, Node SEA launcher)
 *   <out>/bin/search-hub           (Linux launcher script)
 *   <out>/runtime/...              bundled Node runtime
 *   <out>/app/...                  built server + production node_modules
 *   <out>/launcher.json            manifest read by the launcher
 *   <out>/README.txt, systemd unit, checksums
 *
 * The server is **not** embedded in the executable on purpose: better-sqlite3 is
 * a native addon and cannot be loaded from inside a SEA blob, so the launcher
 * spawns the bundled runtime against `app/`.
 */
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, renameSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeZip } from "./zip.mjs";
import { execOwnedProcess } from "./process-runner.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = process.env["PACKAGE_TARGET"] ?? (process.platform === "win32" ? "windows-x64" : "linux-x64");
// `SEARCH_HUB_VERSION` lets the release workflow stamp the tag version (with its
// prerelease suffix) so the package and the release agree on what it is.
const VERSION = (process.env["SEARCH_HUB_VERSION"]?.trim() ||
  JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version).replace(/^v/, "");
const OUT = join(REPO, "dist", "package", TARGET);
const IS_WINDOWS = TARGET.startsWith("windows");

log(`building ${TARGET} v${VERSION}`);

// Preserve the previous generated package instead of recursively deleting a
// large tree. This keeps rebuilds safe on managed hosts and leaves a recoverable
// previous output under the ignored dist/package directory.
if (existsSync(OUT)) renameSync(OUT, `${OUT}.previous-${Date.now()}-${process.pid}`);
mkdirSync(join(OUT, "app"), { recursive: true });
mkdirSync(join(OUT, "runtime"), { recursive: true });

// 1. Build the workspace (web bundle + server + stdio).
await run("corepack", ["pnpm", "build"], { cwd: REPO, shell: true });

log("copying build output");
// 2. Copy the built artefacts, then install production dependencies inside the
// package. Copying the development `node_modules` tree is not viable: pnpm uses
// symlinks into a content-addressed store, and a Windows recursive copy of that
// graph dies partway through. `pnpm install --prod` in the target directory
// produces a real, self-contained tree and is the same approach the Dockerfile
// takes for its prod-deps layer.
// pnpm's tree is ~90k files (virtual store + nested node_modules), which is both
// too large for a download and above the 65,535-entry limit of a plain ZIP. The
// release therefore ships one bundled server plus the single native addon.
await run(process.execPath, [join(REPO, "packaging", "bundle-release.mjs"), join(OUT, "app")], {
  cwd: REPO,
  // The bundler picks the native addon for the *target* platform, which may
  // differ from the build host (cross-compiled Linux arm64 on an x64 runner).
  env: { ...process.env, PACKAGE_TARGET: TARGET },
});
copyIfExists(join(REPO, "package.json"), join(OUT, "app", "package.json"));

log("copying node runtime");
// 3. Bundle a Node runtime so the user needs nothing installed.
// `PACKAGE_NODE_BIN` lets a release build bundle a runtime for a different
// architecture than the build host (Linux arm64 on an x64 runner).
const nodeBinary = process.env["PACKAGE_NODE_BIN"] || process.execPath;
if (!existsSync(nodeBinary)) {
  console.error(`[package] bundled runtime not found: ${nodeBinary}`);
  process.exit(3);
}
if (IS_WINDOWS) {
  copyIfExists(nodeBinary, join(OUT, "runtime", "node.exe"));
} else {
  mkdirSync(join(OUT, "runtime", "bin"), { recursive: true });
  copyIfExists(nodeBinary, join(OUT, "runtime", "bin", "node"));
  chmodSync(join(OUT, "runtime", "bin", "node"), 0o755);
}

log("writing launcher manifest");
log("writing launcher manifest");
// 4. Launcher manifest.
writeFileSync(
  join(OUT, "launcher.json"),
  JSON.stringify(
    {
      name: "Search Hub",
      version: VERSION,
      defaultPort: 8787,
      dataDirHint: IS_WINDOWS ? "%LOCALAPPDATA%\\SearchHub" : "~/.local/share/search-hub",
      entry: "app/apps/api/dist/server.mjs",
    },
    null,
    2,
  ),
  "utf8",
);

log("building launcher");
log("building launcher");
// 5. Launcher: SEA on Windows, plain script on Linux.
if (IS_WINDOWS) {
  await buildSeaLauncher(OUT);
} else {
  const bin = join(OUT, "bin");
  mkdirSync(bin, { recursive: true });
  copyIfExists(join(REPO, "packaging", "launcher", "launcher.mjs"), join(bin, "search-hub.mjs"));
  writeFileSync(
    join(bin, "search-hub"),
    `#!/bin/sh\n# Search Hub launcher — uses the bundled runtime, nothing needs installing.\nDIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)\nexec "$DIR/runtime/bin/node" "$DIR/bin/search-hub.mjs" "$@"\n`,
    "utf8",
  );
  chmodSync(join(bin, "search-hub"), 0o755);
}

log("writing docs");
log("writing docs");
// 5b. Ship the updater. A package that cannot update itself is not updatable:
// the CLI has to travel with the release, not live only in the repository.
const binDir = join(OUT, "bin");
mkdirSync(binDir, { recursive: true });
copyIfExists(join(REPO, "packaging", "launcher", "updater.mjs"), join(binDir, "updater.mjs"));
copyIfExists(
  join(REPO, "packaging", "launcher", "updater-core.mjs"),
  join(binDir, "updater-core.mjs"),
);
copyIfExists(
  join(REPO, "packaging", "launcher", "updater-config.mjs"),
  join(binDir, "updater-config.mjs"),
);
writeFileSync(
  join(binDir, IS_WINDOWS ? "update.cmd" : "update"),
  IS_WINDOWS
    ? "@echo off\r\nrem Search Hub updater: verifies, backs up, swaps and rolls back.\r\n\"%~dp0..\\runtime\\node.exe\" \"%~dp0updater.mjs\" %*\r\n"
    : "#!/bin/sh\n# Search Hub updater: verifies, backs up, swaps and rolls back.\nDIR=$(CDPATH= cd -- \"$(dirname -- \"$0\")/..\" && pwd)\nexec \"$DIR/runtime/bin/node\" \"$DIR/bin/updater.mjs\" \"$@\"\n",
  "utf8",
);
if (!IS_WINDOWS) chmodSync(join(binDir, "update"), 0o755);

// 6. Docs and service template.
writeFileSync(join(OUT, IS_WINDOWS ? "README.txt" : "README.md"), readme(TARGET, VERSION), "utf8");
if (!IS_WINDOWS) {
  writeFileSync(join(OUT, "search-hub.service"), systemdUnit(), "utf8");
}

log("creating archive");
log("creating archive");
// 7. Archive + checksums.
const archive = archiveName(TARGET, VERSION);
const archivePath = join(REPO, "dist", "package", archive);
await makeArchive(OUT, archivePath);
writeFileSync(
  join(REPO, "dist", "package", `${archive}.sha256`),
  `${sha256(archivePath)}  ${archive}\n`,
  "utf8",
);
log(`done: dist/package/${archive}`);

function keepBuilt(path) {
  if (path.includes("node_modules")) return false;
  if (path.endsWith(".map")) return false;
  if (/[\\/](src|tests?)[\\/]/.test(path) && path.endsWith(".ts")) return false;
  return true;
}

async function buildSeaLauncher(out) {
  const blob = join(REPO, "dist", "package", "sea-prep.blob");
  const seaConfig = join(REPO, "dist", "package", "sea-config.json");
  mkdirSync(dirname(seaConfig), { recursive: true });

  // Node's SEA runtime evaluates the embedded script as CommonJS, so the ESM
  // launcher must be bundled down to CJS first; otherwise the exe dies with
  // "Cannot use import statement outside a module".
  const launcherCjs = join(REPO, "dist", "package", "launcher.cjs");
  await run(
    process.execPath,
    [
      join(REPO, "node_modules", "esbuild", "bin", "esbuild"),
      join(REPO, "packaging", "launcher", "launcher.mjs"),
      "--bundle",
      "--platform=node",
      "--format=cjs",
      "--target=node22",
      `--outfile=${launcherCjs}`,
    ],
    { cwd: REPO },
  );

  writeFileSync(
    seaConfig,
    JSON.stringify(
      {
        main: launcherCjs,
        output: blob,
        disableExperimentalSEAWarning: true,
      },
      null,
      2,
    ),
    "utf8",
  );

  // The SEA blob is produced by Node itself; no extra tooling is needed.
  await run(process.execPath, ["--experimental-sea-config", seaConfig], { cwd: REPO });

  const exe = join(out, "SearchHub.exe");
  copyFileSync(process.execPath, exe);

  // postject injects the blob into the copied runtime. Without this step the exe
  // is only a copy of node and would start nothing.
  const postject = join(REPO, "node_modules", "postject", "dist", "cli.js");
  if (existsSync(postject)) {
    await run(process.execPath, [
      postject,
      exe,
      "NODE_SEA_BLOB",
      blob,
      "--sentinel-fuse",
      "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    ]);
    return;
  }

  // No injector available: keep the exe as a documented fallback that still
  // starts the launcher, and say so instead of pretending it is a real SEA.
  log("postject not installed — SearchHub.exe is a runtime copy plus a cmd shim");
  writeFileSync(
    join(out, "SearchHub.cmd"),
    `@echo off\r\nrem Fallback launcher: runs the reviewed launcher script with the bundled runtime.\r\n"%~dp0runtime\\node.exe" "%~dp0launcher.mjs" %*\r\n`,
    "utf8",
  );
  copyIfExists(join(REPO, "packaging", "launcher", "launcher.mjs"), join(out, "launcher.mjs"));
}

function readme(target, version) {
  const port = 8787;
  if (IS_WINDOWS) {
    return `Search Hub ${version} (${target})

1. 解压到任意目录（不要放在 Program Files，避免权限问题）。
2. 双击 SearchHub.exe。
3. 浏览器自动打开 http://127.0.0.1:${port}
4. 首次启动会要求 Setup Token —— 它写在数据目录的 setup-token.txt 里。

无需安装 Node.js / pnpm / Git / Docker。

常用命令（在解压目录打开 cmd）:
  SearchHub.exe                 启动并打开浏览器
  SearchHub.exe --port 9000     换端口（会保存）
  SearchHub.exe --lan           监听局域网（有安全风险）
  SearchHub.exe --service       后台运行，不打开浏览器（适合 Windows Server）
  SearchHub.exe --status        查看状态
  SearchHub.exe --stop          停止
  SearchHub.exe --logs          查看日志
  SearchHub.exe --autostart     开机自启动（写入当前用户的启动文件夹）

升级（事务化，不会用旧程序打开新 schema）:
  bin\\update.cmd --package <新包.zip> --version <新版本> --sha256 <校验和>
  它会先做只读 SQLite 一致快照和完整 dataDir 备份，再停服、替换程序、启动并健康检查；
  失败时交换回整个升级前 dataDir，并保留失败版本数据。

数据目录: %LOCALAPPDATA%\\SearchHub
  search-hub.db / master.key / launcher-config.json / logs/

备份：在管理后台“备份恢复中心”创建加密 .shbackup，或使用 CLI 包中的
  shub backup create --output <file.shbackup> --passphrase-stdin
恢复：shub backup restore <file.shbackup> --data-dir <新目录> --apply
不要停止服务后复制 search-hub.db/-wal/-shm 作为恢复点；master.key 已加密包含在完整包内。
`;
  }
  return `# Search Hub ${version} (${target})

## 安装（不需要 Node.js / pnpm）

    mkdir search-hub && tar -xzf ${archiveName(target, version)} -C search-hub
    cd search-hub
    ./bin/search-hub

首次启动会打印访问地址 http://127.0.0.1:${port} 与 Setup Token 的位置。
headless 环境不会强行打开浏览器。

## systemd（长期运行推荐）

    sudo useradd --system --home /var/lib/search-hub --shell /usr/sbin/nologin search-hub
    sudo mkdir -p /var/lib/search-hub && sudo chown search-hub: /var/lib/search-hub
    sudo cp search-hub.service /etc/systemd/system/
    sudo systemctl daemon-reload
    sudo systemctl enable --now search-hub

unit 已设置 User=search-hub，非 root 运行，数据目录可持久化。

## 常用命令

    ./bin/search-hub --status
    ./bin/search-hub --stop
    ./bin/search-hub --logs
    ./bin/search-hub --port 9000 --lan

## 升级（不会丢数据）

    ./bin/update --package <新包.tar.gz> --version <新版本> --sha256 <校验和>

先做只读 SQLite 一致快照和完整 dataDir 备份，再停服、替换程序、启动并健康检查；
失败时交换回整个升级前 dataDir，并保留失败版本数据。
退出码：0 成功；3 已回滚且健康；4 需要人工介入；1 校验/降级/架构不通过（未动文件）。

## 升级

1. ./bin/search-hub --stop
2. 备份数据目录（默认 ~/.local/share/search-hub）
3. 解压新版本
4. 用同样的 SEARCH_HUB_DATA_DIR 启动

数据库迁移在启动时自动执行，不会清空既有 Provider / Key / 管理员。

## 备份与恢复

在管理后台“备份恢复中心”创建加密 .shbackup，或使用 CLI 包：

    shub backup create --output search-hub.shbackup --passphrase-stdin
    shub backup restore search-hub.shbackup --data-dir /srv/search-hub-restored --apply

不要停止服务后复制 search-hub.db / -wal / -shm 作为恢复点。
完整包已加密包含数据库与 master.key；恢复只写入新的空目录，不覆盖生产数据。
`;
}

function systemdUnit() {
  return `[Unit]
Description=Search Hub
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=search-hub
Group=search-hub
WorkingDirectory=/opt/search-hub
Environment=SEARCH_HUB_DATA_DIR=/var/lib/search-hub
Environment=SEARCH_HUB_PORT=8787
Environment=SEARCH_HUB_HOST=127.0.0.1
ExecStart=/opt/search-hub/bin/search-hub --service --no-browser
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/search-hub

[Install]
WantedBy=multi-user.target
`;
}

function archiveName(target, version) {
  return `search-hub-v${version}-${target}.${IS_WINDOWS ? "zip" : "tar.gz"}`;
}

async function makeArchive(fromDir, toFile) {
  mkdirSync(dirname(toFile), { recursive: true });
  const parent = dirname(fromDir);
  const base = fromDir.split(/[\\/]/).pop();

  if (IS_WINDOWS) {
    // Windows has GNU tar (no zip support) and no guaranteed `zip` binary, so
    // the container is produced directly by packaging/zip.mjs.
    writeZip(fromDir, toFile);
    log(`wrote ${toFile}`);
    return;
  }
  // Name each top-level entry explicitly. Passing "." makes GNU tar emit a
  // canonical but ambiguous "./" root member, which the strict updater rejects.
  // Explicit names keep the archive root identical across platforms without
  // weakening path validation.
  await run("tar", ["--force-local", "-czf", toFile, "-C", fromDir, ...readdirSync(fromDir)], { cwd: parent });
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function copyIfExists(from, to) {
  if (!existsSync(from)) return;
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to);
}

async function run(command, args, options = {}) {
  await execOwnedProcess(command, args, { stdio: "inherit", ...options });
}

function log(message) {
  console.log(`[package] ${message}`);
}
