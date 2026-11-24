import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");

function commandBlocks(relative: string, needle: string): string[] {
  const lines = readFileSync(resolve(root, relative), "utf8").split("\n");
  const blocks: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index]?.includes(needle)) continue;
    let start = index;
    while (start > 0 && lines[start - 1]!.trimEnd().endsWith("\\")) start -= 1;
    let end = index;
    while (lines[end]?.trimEnd().endsWith("\\")) end += 1;
    blocks.push(lines.slice(start, end + 1).join("\n"));
  }
  return blocks;
}

function restoreBlocks(relative: string): string[] {
  return commandBlocks(relative, "backup restore");
}

describe("platform restore origin environment", () => {
  const cases = [
    { script: "tests/disaster-recovery/platform-linux.sh", data: 'SEARCH_HUB_DATA_DIR="$WORK/source-data"', install: 'SEARCH_HUB_INSTALL_DIR="$PACKAGE_ROOT"' },
    { script: "tests/disaster-recovery/platform-docker.sh", data: "SEARCH_HUB_DATA_DIR=/data", install: "SEARCH_HUB_INSTALL_DIR=/app" },
    { script: "tests/disaster-recovery/platform-systemd.sh", data: 'SEARCH_HUB_DATA_DIR="$DATA"', install: 'SEARCH_HUB_INSTALL_DIR="$BASE"' },
  ];

  it.each(cases)("$script sets the original data and install directories on every restore", ({ script, data, install }) => {
    const blocks = restoreBlocks(script);
    expect(blocks).toHaveLength(3);
    for (const block of blocks) {
      expect(block).toContain(data);
      expect(block).toContain(install);
    }
    const startCheck = blocks.find((block) => block.includes("--start-check"));
    expect(startCheck).toBeDefined();
    expect(startCheck).toContain("SEARCH_HUB_APP_ENTRY");
    if (script.endsWith("platform-docker.sh")) expect(startCheck).toContain("SEARCH_HUB_START_CHECK_NODE=/usr/local/bin/node");
  });

  it("prefixes every Docker SEARCH_HUB environment assignment with -e", () => {
    const lines = readFileSync(resolve(root, "tests/disaster-recovery/platform-docker.sh"), "utf8").split("\n");
    let migrations = 0;
    for (const line of lines) {
      const tokens = line.trim().split(/\s+/);
      for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index]!;
        if (!token.startsWith("SEARCH_HUB_")) continue;
        expect(token).toContain("=");
        expect(["-e", "--env"]).toContain(tokens[index - 1]);
        if (token.startsWith("SEARCH_HUB_MIGRATIONS_DIR=")) migrations += 1;
      }
    }
    expect(migrations).toBe(5);
  });

  it("keeps Docker stdin interactive for all five passphrase commands", () => {
    const blocks = commandBlocks("tests/disaster-recovery/platform-docker.sh", "--passphrase-stdin");
    expect(blocks).toHaveLength(5);
    for (const block of blocks) {
      const tokens = block.split(/\s+/);
      expect(tokens.includes("-i") || tokens.includes("--interactive")).toBe(true);
    }
  });

  it("mounts the package volume writable for verify and all restore lock operations", () => {
    const script = readFileSync(resolve(root, "tests/disaster-recovery/platform-docker.sh"), "utf8");
    const blocks = [...commandBlocks("tests/disaster-recovery/platform-docker.sh", "backup verify"), ...restoreBlocks("tests/disaster-recovery/platform-docker.sh")];
    expect(blocks).toHaveLength(4);
    for (const block of blocks) expect(block).toContain("$PACKAGE_VOL:/packages:rw");
    expect(script).not.toContain("$PACKAGE_VOL:/packages:ro");
    expect(script).toContain('cmp "$WORK/production-before.sha256" "$WORK/production-after.sha256"');
    expect(script).toContain('cp "$WORK/production-before.sha256" "$EVIDENCE/production-volume-unchanged.sha256"');
  });

  it("includes launcher server log diagnostics for failed updater runs", () => {
    const source = readFileSync(resolve(root, "packaging/launcher/updater-test.mjs"), "utf8");
    expect(source).toContain('join(root, "data", "logs", "server.log")');
    expect(source).toContain("launcher server log: missing");
    expect(source).toContain("text.slice(-8000)");
    expect(source.split("\n").filter((line) => line.includes("updaterFailureDetail(root, run)") && !line.includes("function "))).toHaveLength(2);
  });

  it("logs systemd helper output before returning the original exit code", () => {
    const script = readFileSync(resolve(root, "tests/disaster-recovery/platform-systemd.sh"), "utf8");
    const start = script.indexOf("run_logged() {");
    const end = script.indexOf("\n}\n", start) + 3;
    expect(start).toBeGreaterThan(-1);
    const helper = script.slice(start, end);
    const redirect = helper.indexOf('"$@" >"$log" 2>&1');
    const capture = helper.indexOf("local code=$?");
    const cat = helper.indexOf('cat "$log"');
    const returned = helper.indexOf('return "$code"');
    expect(redirect).toBeGreaterThan(-1);
    expect(capture).toBeGreaterThan(redirect);
    expect(cat).toBeGreaterThan(capture);
    expect(returned).toBeGreaterThan(cat);
    expect(script.match(/run_logged "\$EVIDENCE\/updater-test\.log"/g)).toHaveLength(1);
    expect(script.match(/run_logged "\$EVIDENCE\/updater-faults\.log"/g)).toHaveLength(1);
    expect(script.match(/run_logged "\$EVIDENCE\/upgrade-matrix\.log"/g)).toHaveLength(2);
  });

  it.skipIf(process.platform === "win32")("run_logged cats diagnostics and preserves a non-zero exit", () => {
    const script = readFileSync(resolve(root, "tests/disaster-recovery/platform-systemd.sh"), "utf8");
    const start = script.indexOf("run_logged() {");
    const end = script.indexOf("\n}\n", start) + 3;
    const directory = mkdtempSync(join(tmpdir(), "sh-dr-run-logged-"));
    const log = join(directory, "diagnostic.log");
    try {
      const result = spawnSync("bash", ["-c", `set -e\n${script.slice(start, end)}\nrun_logged "$1" bash -c 'echo visible-diagnostic; exit 7'`, "run-logged-test", log], { encoding: "utf8" });
      expect(result.status).toBe(7);
      expect(result.stdout).toContain("visible-diagnostic");
      expect(readFileSync(log, "utf8")).toContain("visible-diagnostic");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("stops the rolled-back systemd source before WAL and mode assertions", () => {
    const script = readFileSync(resolve(root, "tests/disaster-recovery/platform-systemd.sh"), "utf8");
    const verify = script.indexOf('rollback-verify.json');
    const stop = script.indexOf('systemctl stop "$SOURCE_UNIT"', verify);
    const wal = script.indexOf('[[ ! -e "$DATA/search-hub.db-wal"', stop);
    const modes = script.indexOf('stat -c', wal);
    const updater = script.indexOf('updater-test.mjs', modes);
    expect(verify).toBeGreaterThan(-1);
    expect(stop).toBeGreaterThan(verify);
    expect(wal).toBeGreaterThan(stop);
    expect(modes).toBeGreaterThan(wal);
    expect(updater).toBeGreaterThan(modes);
  });

  it("runs launcher updater diagnostics after extraction and before installing the systemd unit", () => {
    const workflow = readFileSync(resolve(root, ".github/workflows/systemd.yml"), "utf8");
    expect(workflow).toContain('-v "$PWD:/workspace:ro"');
    const extract = workflow.indexOf("tar -xzf /pkgs/search-hub-v0.9.0-ci-linux-x64.tar.gz");
    const diagnostics = workflow.indexOf("/opt/search-hub/runtime/bin/node /workspace/packaging/launcher/updater-test.mjs");
    const installUnit = workflow.indexOf("cp /opt/search-hub/search-hub.service /etc/systemd/system/");
    expect(extract).toBeGreaterThan(-1);
    expect(diagnostics).toBeGreaterThan(extract);
    expect(installUnit).toBeGreaterThan(diagnostics);
    expect(workflow).toContain("systemctl enable --now search-hub");
    expect(workflow).toContain('if [ "$CODE" != "3" ]');
    expect(workflow).toContain("PASS health scheduler under systemd");
  });

  it("repairs systemd restore ownership and permissions before starting the unit", () => {
    const script = readFileSync(resolve(root, "tests/disaster-recovery/platform-systemd.sh"), "utf8");
    const apply = script.indexOf('--apply --start-check');
    const chown = script.indexOf('chown -R search-hub:search-hub "$RESTORED"');
    const chmodDirectory = script.indexOf('chmod 700 "$RESTORED"');
    const chmodKey = script.indexOf('chmod 600 "$RESTORED/master.key"');
    const start = script.indexOf('systemctl start "$RESTORED_UNIT"');
    expect(apply).toBeGreaterThan(-1);
    expect(chown).toBeGreaterThan(apply);
    expect(chmodDirectory).toBeGreaterThan(chown);
    expect(chmodKey).toBeGreaterThan(chmodDirectory);
    expect(start).toBeGreaterThan(chmodKey);
  });
});
