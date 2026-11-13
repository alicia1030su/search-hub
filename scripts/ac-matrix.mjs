#!/usr/bin/env node
/**
 * Acceptance matrix generator (single source of truth).
 *
 * `docs/ac-matrix.json` is the only file that stores AC statuses. This script:
 *   - accepts either a bare array or `{ "items": [...] }`;
 *   - validates exactly 16 entries, ids in AC-01..AC-16 order, one valid status
 *     each, PASS with evidence, PARTIAL/BLOCKED with gaps;
 *   - renders `docs/ac-matrix.md` with a 16-row table and generated counts;
 *   - `--check` fails when the committed markdown is stale.
 *
 * AC-05b from the product doc is folded into AC-05 as a sub-check: the matrix
 * always has 16 rows, and sub-checks never change that count.
 *
 * Usage:
 *   node scripts/ac-matrix.mjs                       # regenerate docs/ac-matrix.md
 *   node scripts/ac-matrix.mjs --check               # CI gate: fail if stale
 *   node scripts/ac-matrix.mjs --json other.json --out other.md
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const STATUSES = ["PASS", "PARTIAL", "FAIL", "BLOCKED", "NOT_IMPLEMENTED"];
const EXPECTED_IDS = Array.from({ length: 16 }, (_, index) => `AC-${String(index + 1).padStart(2, "0")}`);

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith("--") ? fallback : value;
}

const jsonPath = resolve(root, arg("json", "docs/ac-matrix.json"));
const mdPath = resolve(root, arg("out", "docs/ac-matrix.md"));
const checkOnly = process.argv.includes("--check");

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

let parsed;
try {
  parsed = JSON.parse(readFileSync(jsonPath, "utf8"));
} catch (error) {
  fail(`cannot read ${jsonPath}: ${error.message}`);
}

const items = Array.isArray(parsed)
  ? parsed
  : parsed && Array.isArray(parsed.items)
    ? parsed.items
    : null;
if (!items) fail('expected a JSON array or an object with an "items" array');

if (items.length !== 16) fail(`expected exactly 16 items, found ${items.length}`);

items.forEach((item, index) => {
  const expectedId = EXPECTED_IDS[index];
  if (item.id !== expectedId) fail(`entry #${index + 1} must be ${expectedId}, found ${item.id}`);
  if (!STATUSES.includes(item.status)) {
    fail(`${item.id}: invalid status "${item.status}" (allowed: ${STATUSES.join(", ")})`);
  }
  if (!Array.isArray(item.evidence)) fail(`${item.id}: evidence must be an array`);
  if (!Array.isArray(item.gaps)) fail(`${item.id}: gaps must be an array`);
  if (item.status === "PASS" && item.evidence.length === 0) {
    fail(`${item.id}: PASS requires at least one evidence entry`);
  }
  if ((item.status === "PARTIAL" || item.status === "BLOCKED") && item.gaps.length === 0) {
    fail(`${item.id}: ${item.status} requires at least one gap`);
  }
  item.evidence.forEach((entry, position) => {
    const problems = [];
    if (typeof entry.command !== "string" || entry.command.trim() === "") {
      problems.push('missing "command" (string)');
    }
    if (typeof entry.result !== "string" || entry.result.trim() === "") {
      problems.push('missing "result" (string)');
    }
    if (problems.length > 0) {
      fail(`${item.id}: evidence #${position + 1} ${problems.join("; ")}`);
    }
  });
});

const counts = Object.fromEntries(STATUSES.map((status) => [status, 0]));
for (const item of items) counts[item.status] += 1;

function escapeCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

const rows = items.map((item) => {
  const evidence = item.evidence
    .map((entry) => `\`${escapeCell(entry.command)}\` → ${escapeCell(entry.result)}`)
    .join("<br>");
  const subchecks = Array.isArray(item.subchecks) && item.subchecks.length > 0
    ? `<br>` + item.subchecks.map((sub) => `${escapeCell(sub.name)}（${sub.status}）`).join("；")
    : "";
  const gaps = item.gaps.map(escapeCell).join("；") || "—";
  return `| ${item.id} | ${escapeCell(item.title)} | **${item.status}** | ${escapeCell(item.summary)}${subchecks} | ${evidence} | ${gaps} |`;
});

const md = `# 验收矩阵（AC-01 ~ AC-16）

> **唯一事实源**：\`docs/ac-matrix.json\`。本文件由 \`node scripts/ac-matrix.mjs\` 生成，**不要手改**。
> 每项只有一个总体状态；子项只是证据细节，不改变 16 项的总数。
> 状态定义：PASS / PARTIAL / FAIL / BLOCKED / NOT_IMPLEMENTED。

- 版本：${parsed.version ?? "0.1.2"}
- 生成时间：${new Date().toISOString()}
- 总项数：**${items.length}**

## 状态统计

| 状态 | 数量 |
|---|---|
${STATUSES.map((status) => `| ${status} | ${counts[status]} |`).join("\n")}

合计：${items.length}

## 逐项判定

| ID | 检查项 | 总体状态 | 摘要 | 证据 | 缺口 |
|---|---|---|---|---|---|
${rows.join("\n")}

## 说明

- AC-05b（搜索实验室明细）在产品文档中是 AC-05 的补充项，这里并入 AC-05，保证矩阵恒为 16 行。
- 任何 PASS 都必须有可复现的 evidence；PARTIAL/BLOCKED 必须写缺口。缺证据的 PASS 会被生成脚本直接拒绝。
- 统计数字只在这里自动生成；\`docs/acceptance-report.md\` 只引用本文件，不再维护第二份手工计数。
`;

const stripTimestamp = (value) => value.replace(/生成时间：.*$/m, "");

if (checkOnly) {
  let current = "";
  try {
    current = readFileSync(mdPath, "utf8");
  } catch {
    fail(`${mdPath} does not exist; run node scripts/ac-matrix.mjs`);
  }
  if (stripTimestamp(current) !== stripTimestamp(md)) {
    fail(`${mdPath} is stale; run node scripts/ac-matrix.mjs`);
  }
  console.log(
    `PASS: 16 AC items are valid (${STATUSES.map((status) => `${status}=${counts[status]}`).join(", ")})`,
  );
} else {
  writeFileSync(mdPath, md);
  console.log(
    `PASS: wrote ${mdPath} (16 AC items are valid: ${STATUSES.map((status) => `${status}=${counts[status]}`).join(", ")})`,
  );
}
