import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSystemdUnit, resolveServiceConfig, updateWorkRoot } from "../../packaging/launcher/updater-config.mjs";

let directory: string | undefined;
afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("updater service configuration", () => {
  it("resolves relative SEARCH_HUB_DB_PATH against the data directory", () => {
    const root = directory = mkdtempSync(join(tmpdir(), "shub-updater-config-"));
    const config = resolveServiceConfig({
      root,
      env: { SEARCH_HUB_DATA_DIR: join(root, "custom-data"), SEARCH_HUB_DB_PATH: "nested/custom.sqlite" },
      platform: "win32",
    });
    expect(config.dataDir).toBe(join(root, "custom-data"));
    expect(config.dbPath).toBe(join(root, "custom-data", "nested", "custom.sqlite"));
    expect(config.unitName).toBeNull();
  });

  it("gives explicit CLI paths precedence over environment paths", () => {
    const root = directory = mkdtempSync(join(tmpdir(), "shub-updater-config-"));
    const config = resolveServiceConfig({
      root,
      dataDirArg: join(root, "cli-data"),
      dbPathArg: join(root, "external", "db.sqlite"),
      env: { SEARCH_HUB_DATA_DIR: join(root, "env-data"), SEARCH_HUB_DB_PATH: "env.sqlite" },
      platform: "win32",
    });
    expect(config.dataDir).toBe(join(root, "cli-data"));
    expect(config.dbPath).toBe(join(root, "external", "db.sqlite"));
  });

  it("parses systemd EnvironmentFile, Environment and ExecStart without executing it", () => {
    const root = directory = mkdtempSync(join(tmpdir(), "shub-updater-unit-"));
    const environmentFile = join(root, "search-hub.env");
    writeFileSync(environmentFile, "SEARCH_HUB_DATA_DIR=/srv/search-hub/data\nSEARCH_HUB_PORT=9001\n");
    const parsed = parseSystemdUnit(`
[Service]
EnvironmentFile=search-hub.env
Environment="SEARCH_HUB_DB_PATH=nested/db.sqlite"
ExecStart=/usr/bin/node /srv/search-hub/app/apps/api/dist/server.mjs --db-path /srv/external.sqlite
`, root);
    expect(parsed.env.SEARCH_HUB_DATA_DIR).toBe("/srv/search-hub/data");
    expect(parsed.env.SEARCH_HUB_DB_PATH).toBe("/srv/external.sqlite");
    expect(parsed.env.SEARCH_HUB_PORT).toBe("9001");
    expect(parsed.execStart).toContain("/srv/search-hub/app/apps/api/dist/server.mjs");
  });

  it("does not invent a systemd unit path when the default service is absent", () => {
    const root = directory = mkdtempSync(join(tmpdir(), "shub-updater-no-unit-"));
    const config = resolveServiceConfig({ root, env: {}, platform: "linux", unitName: "search-hub" });
    expect(config.unitName).toBeNull();
    expect(config.unitPath).toBeNull();
  });

  it("keeps update work outside the data directory so backup cannot recurse", () => {
    const dataDir = join(directory = mkdtempSync(join(tmpdir(), "shub-updater-work-")), "data");
    expect(updateWorkRoot(dataDir)).toBe(join(directory, ".data.search-hub-updates"));
  });
});
