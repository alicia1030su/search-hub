import { lookup } from "node:dns/promises";
import type { ParsedCliArgs } from "../args.js";
import { HttpClient, HttpResponseError, isCompatibleServerVersion, requireToken } from "../client/http.js";
import { CliError, EXIT_CODES } from "../errors/index.js";
import { table, writeJson, writeText, type OutputFormat } from "../output/index.js";
import { CLI_VERSION } from "../version.js";

interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export async function runDoctor(
  args: ParsedCliArgs,
  client: HttpClient,
  token: string | undefined,
  format: OutputFormat,
): Promise<number> {
  const checks: DoctorCheck[] = [];
  const server = new URL(client.baseUrl);
  checks.push({ name: "url", ok: true, detail: client.baseUrl });

  let addresses = "";
  try {
    const records = await lookup(server.hostname, { all: true });
    addresses = records.map((record) => `${record.address} (${record.family})`).join(", ");
    checks.push({ name: "dns", ok: true, detail: addresses });
  } catch (error) {
    checks.push({ name: "dns", ok: false, detail: error instanceof Error ? error.message : String(error) });
  }

  let healthVersion: string | undefined;
  let healthError: CliError | undefined;
  try {
    const health = await client.health();
    healthVersion = health.version;
    checks.push({ name: "reachable", ok: true, detail: `HTTP ${health.status}, version ${health.version}` });
    checks.push({
      name: "tls",
      ok: true,
      detail: server.protocol === "https:" ? "certificate verified by Node.js" : "loopback HTTP exception",
    });
  } catch (error) {
    healthError = error instanceof CliError ? error : new CliError("network_error", String(error), EXIT_CODES.network);
    const tlsFailure = /certificate|self.signed|CERT_|TLS/i.test(healthError.message);
    checks.push({ name: "reachable", ok: false, detail: healthError.message });
    checks.push({ name: "tls", ok: !tlsFailure, detail: tlsFailure ? healthError.message : "not established" });
  }
  const compatible = healthVersion ? isCompatibleServerVersion(healthVersion) : false;
  checks.push({
    name: "version",
    ok: compatible,
    detail: healthVersion ? `server ${healthVersion} / cli ${CLI_VERSION}` : "not checked",
  });

  checks.push({ name: "token", ok: Boolean(token), detail: token ? "present (value hidden)" : "missing; set SEARCH_HUB_TOKEN" });
  let searchScope = false;
  let sourcesScope = false;
  if (token && healthError === undefined) {
    requireToken(token);
    try {
      await client.request("/api/search/tasks/shub-doctor-permission-check");
      searchScope = true;
      checks.push({ name: "search_scope", ok: true, detail: "accepted" });
    } catch (error) {
      if (error instanceof HttpResponseError && error.status === 404) {
        searchScope = true;
        checks.push({ name: "search_scope", ok: true, detail: "accepted (task not found is expected)" });
      } else {
        checks.push({ name: "search_scope", ok: false, detail: error instanceof Error ? error.message : String(error) });
      }
    }
    try {
      await client.request("/api/providers");
      sourcesScope = true;
      checks.push({ name: "sources_scope", ok: true, detail: "accepted" });
    } catch (error) {
      checks.push({ name: "sources_scope", ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
    try {
      await client.request("/api/admin/provider-health/settings");
      checks.push({ name: "admin_scope", ok: true, detail: "accepted (read-only)" });
    } catch (error) {
      checks.push({ name: "admin_scope", ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
    try {
      const backup = await client.request("/api/admin/backups/status") as { restoreReadiness?: boolean; keyReadiness?: string; latestBackup?: unknown };
      checks.push({ name: "backup_status", ok: true, detail: `read-only check accepted; readiness=${String(backup.restoreReadiness ?? "unknown")}; key=${backup.keyReadiness ?? "unknown"}` });
    } catch (error) {
      // This endpoint intentionally requires an admin session, not a Bearer
      // token. Its failure must not change the established doctor contract.
      checks.push({ name: "backup_status", ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  } else {
    checks.push({ name: "search_scope", ok: false, detail: "not checked" });
    checks.push({ name: "sources_scope", ok: false, detail: "not checked" });
    checks.push({ name: "admin_scope", ok: false, detail: "not checked" });
    checks.push({ name: "backup_status", ok: false, detail: "not checked" });
  }

  const requiredChecks = checks.filter((check) => check.name !== "admin_scope" && check.name !== "backup_status");
  const ok = requiredChecks.every((check) => check.ok) && searchScope && sourcesScope;
  const output = {
    ok,
    cliVersion: CLI_VERSION,
    serverUrl: client.baseUrl,
    compatible,
    checks,
  };
  if (format === "json") writeJson(output);
  else if (format === "ndjson") writeJson({ type: "doctor", ...output });
  else writeText(table(["Check", "OK", "Detail"], checks.map((check) => [check.name, check.ok, check.detail])));

  if (args.values["verbose"] === true && addresses) process.stderr.write(`shub: dns=${addresses}\n`);
  if (healthError) return healthError.exitCode;
  if (!compatible) return EXIT_CODES.incompatible;
  if (!token) return EXIT_CODES.auth;
  if (!searchScope || !sourcesScope) return EXIT_CODES.forbidden;
  return ok ? EXIT_CODES.ok : EXIT_CODES.server;
}
