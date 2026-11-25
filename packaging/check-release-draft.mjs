#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

export function releaseReleasesApiPath(repo) {
  const repoParts = String(repo).split("/");
  if (repoParts.length !== 2 || repoParts.some((part) => !part)) throw new Error("release_repo_slug_invalid");
  return ["repos", ...repoParts, "releases"].map((part) => encodeURIComponent(String(part))).join("/");
}

export function classifyReleaseLookup({ exitCode = 0, stdout = "", stderr = "", tag } = {}) {
  if (exitCode === 0) {
    try {
      const pages = JSON.parse(stdout);
      if (!Array.isArray(pages) || pages.length === 0 || !pages.every((page) => Array.isArray(page) && page.every((release) => release && typeof release === "object"))) {
        return { kind: "error", message: "gh api returned an invalid release list" };
      }
      const matches = pages.flat().filter((entry) => entry.tag_name === tag);
      if (matches.length > 1) return { kind: "error", message: "release_tag_ambiguous" };
      return matches.length === 1 ? { kind: "success", release: matches[0] } : { kind: "not-found" };
    } catch {
      return { kind: "error", message: "gh api returned invalid release JSON" };
    }
  }
  return { kind: "error", message: stderr.trim() || `gh api exited with status ${exitCode}` };
}

export function resolveReleaseDraft(lookup, event) {
  if (event !== "push" && event !== "workflow_dispatch") throw new Error("release_event_invalid");
  if (lookup?.kind === "error") throw new Error(`release_lookup_failed:${lookup.message}`);
  if (lookup?.kind === "not-found") {
    if (event === "push") return { action: "create", assets: 0 };
    throw new Error("release_draft_not_found_for_dispatch");
  }
  if (lookup?.kind !== "success") throw new Error("release_lookup_invalid");
  const release = lookup.release;
  if (!Array.isArray(release?.assets)) throw new Error(`release_draft_invalid:${event}`);
  const assets = release.assets;
  if (release.draft !== true || release.prerelease !== false) throw new Error(`release_draft_invalid:${event}`);
  if (event === "push") {
    if (assets.length !== 0) throw new Error("release_push_draft_not_empty");
    return { action: "create", assets: 0 };
  }
  if (assets.length !== 9 || !assets.every((asset) => asset?.state === "uploaded")) throw new Error("release_dispatch_draft_assets_invalid");
  return { action: "reuse", assets: assets.length };
}

async function main() {
  const repo = arg("repo");
  const tag = arg("tag");
  const event = arg("event");
  if (!repo || !tag || !event) throw new Error("--repo, --tag and --event are required");
  const endpoint = `${releaseReleasesApiPath(repo)}?per_page=100`;
  let lookup;
  try {
    const stdout = execFileSync("gh", ["api", "--paginate", "--slurp", endpoint], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    lookup = classifyReleaseLookup({ exitCode: 0, stdout, tag });
  } catch (error) {
    lookup = classifyReleaseLookup({
      exitCode: error?.status ?? 1,
      stdout: error?.stdout ?? "",
      stderr: error?.stderr ?? String(error?.message ?? error),
      tag,
    });
  }
  const result = resolveReleaseDraft(lookup, event);
  console.log(JSON.stringify({ ok: true, repo, tag, event, endpoint, ...result }, null, 2));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(`release draft check failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
