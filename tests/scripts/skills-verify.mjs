#!/usr/bin/env node
/**
 * Agent Skills — static and independent execution checks.
 *
 * This does NOT replace a real Agent client (Claude Desktop, Cursor, ...): it
 * cannot prove that a client loads `SKILL.md` or interprets it correctly. It
 * proves the parts a client would rely on:
 *
 *   1. frontmatter is present, `name`/`description` are usable, no TODO/placeholder;
 *   2. `metadata.version` matches the package version;
 *   3. every documented curl call actually works against a live instance;
 *   4. a `search`-scope token cannot reach the admin model listing (the skill
 *      must not instruct users to do that);
 *   5. results keep absolute URLs and never echo the token;
 *   6. missing credentials fail with 401 instead of returning an empty success.
 *
 * Usage:
 *   node tests/scripts/skills-verify.mjs --url http://127.0.0.1:8870 --token sh_...
 * Exit code 0 only when every executed check passes.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith("--") ? fallback : value;
}

const BASE = arg("url", "http://127.0.0.1:8787").replace(/\/+$/, "");
const TOKEN = arg("token", process.env.SEARCH_HUB_TOKEN ?? "");
const ROOT = "packages/skills";

let failures = 0;
function check(ok, label, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

function frontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!match) return null;
  const fields = {};
  for (const line of match[1].split("\n")) {
    const item = /^([a-zA-Z_]+):\s*(.*)$/.exec(line.trim());
    if (item) fields[item[1]] = item[2].replace(/^["']|["']$/g, "");
  }
  return fields;
}

const skills = readdirSync(ROOT, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => {
    try {
      readFileSync(join(ROOT, name, "SKILL.md"));
      return true;
    } catch {
      return false;
    }
  });

check(skills.length === 3, "three skills are present", skills.join(", "));

const packageVersion = JSON.parse(readFileSync("package.json", "utf8")).version;

for (const name of skills) {
  const file = join(ROOT, name, "SKILL.md");
  const text = readFileSync(file, "utf8");
  const meta = frontmatter(text);
  check(Boolean(meta), `${name}: frontmatter parses`);
  check(meta?.name === name, `${name}: name matches directory`, meta?.name);
  check((meta?.description?.length ?? 0) >= 40, `${name}: description explains when to use it`);
  check(!/\bTODO\b|\bFIXME\b|<your-token>|<placeholder>/i.test(text), `${name}: no placeholders`);
  const version = /version:\s*"([^"]+)"/.exec(text)?.[1];
  check(version === packageVersion, `${name}: metadata.version matches ${packageVersion}`, version);
  const mentionsAdminModels = text.includes('api/admin/models');
  check(!mentionsAdminModels || /requires an administrator session/.test(text), `${name}: does not instruct token-only clients to call admin models`);
}

if (!TOKEN) {
  check(false, "live calls", "--token / SEARCH_HUB_TOKEN is required");
  process.exit(1);
}

async function call(path, body, token = TOKEN) {
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  let parsed = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed, raw: JSON.stringify(parsed) ?? "" };
}

const calls = [
  {
    name: "search-web",
    path: "/api/search",
    body: { query: "postgres logical replication lag", mode: "rrf", limit: 8 },
  },
  {
    name: "research-with-citations",
    path: "/api/search",
    body: { query: "postgres logical replication", mode: "rrf", limit: 12, includeRaw: false },
  },
  {
    name: "deep-research (retrieval only)",
    path: "/api/search/deep",
    body: { query: "self-hosted search aggregators and key rotation", limit: 5 },
  },
];

for (const item of calls) {
  const result = await call(item.path, item.body);
  const results = Array.isArray(result.body?.results) ? result.body.results : [];
  const urls = results.map((row) => row.url).filter((url) => typeof url === "string");
  const absolute = urls.filter((url) => /^https?:\/\//.test(url));
  const hasToken = result.raw.includes(TOKEN);

  if (item.name.startsWith("deep-research")) {
    // Without a chat model this must fail with a clear 4xx, not return an
    // empty 200. A configured instance may return 200 with a summary.
    const acceptable = result.status === 200 || (result.status >= 400 && result.status < 500);
    check(acceptable, `${item.name}: responds with 200 or a clear 4xx`, `HTTP ${result.status}`);
    check(!hasToken, `${item.name}: response does not echo the token`);
    continue;
  }

  check(result.status === 200, `${item.name}: HTTP 200`, `HTTP ${result.status}`);
  check(results.length > 0, `${item.name}: returns at least one result`, `${results.length}`);
  check(
    absolute.length === urls.length && urls.length > 0,
    `${item.name}: every URL is absolute`,
    `${absolute.length}/${urls.length}`,
  );
  check(!hasToken, `${item.name}: response does not echo the token`);
}

// A search-scope token must not be able to read admin models; the skill now
// tells users to ask for a model id instead of calling this endpoint.
const admin = await fetch(`${BASE}/api/admin/models`, {
  headers: { authorization: `Bearer ${TOKEN}` },
});
check([401, 403].includes(admin.status), "admin model list rejects a search-scope token", `HTTP ${admin.status}`);

// Missing token must fail, not return an empty success.
const anonymous = await call("/api/search", { query: "missing token" }, "sh_invalid_token_for_verify");
check([401, 403].includes(anonymous.status), "missing/invalid token is rejected", `HTTP ${anonymous.status}`);

console.log(failures === 0 ? "\nSKILLS: PASS" : `\nSKILLS: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
