#!/usr/bin/env node
/**
 * Scrub provider-live log files in place before they are uploaded as an
 * artifact. GitHub masks secrets in the *job log*, but artifact file contents
 * are not masked; a vendor that echoes a credential into an error page or a
 * result title would otherwise persist it for the artifact retention window.
 *
 * Usage (keys come from the environment, never argv):
 *   node tests/scripts/scrub-provider-logs.mjs provider-*.log
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { redactText, providerKeysFromEnv } from "./redact-secrets.mjs";

const keys = providerKeysFromEnv();
const files = process.argv.slice(2);
let changed = 0;

for (const file of files) {
  if (!existsSync(file)) continue;
  const before = readFileSync(file, "utf8");
  const after = redactText(before, keys);
  if (before !== after) {
    writeFileSync(file, after, "utf8");
    changed += 1;
  }
}

console.log(`scrubbed ${changed} of ${files.length} log file(s) using ${keys.length} configured key(s)`);
