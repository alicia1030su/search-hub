#!/usr/bin/env node
/**
 * Supply-chain audit for the public release.
 *
 * Checks the parts a user is told to trust, and reports what is *not* protected:
 *
 *  1. `SHA256SUMS` matches every published asset byte-for-byte
 *  2. each asset name matches the version, OS and architecture in the tag
 *  3. the release tag points at a commit that is on `main`
 *  4. every archive entry is a relative path inside the package (no traversal)
 *  5. file modes: no setuid/setgid bits, launcher and updater are executable
 *  6. what the trust anchor actually is (GitHub account + TLS + the asset digest
 *     the API reports), and whether build provenance exists
 *
 * Usage:
 *   node packaging/supply-chain-audit.mjs --tag v0.1.6-beta.1
 *   node packaging/supply-chain-audit.mjs --tag v0.1.6-beta.1 --dir ./downloads
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SLUG = "alicia1030su/search-hub";

/**
 * The tag to audit.
 *
 * Defaults to the newest published release rather than a hardcoded version: a
 * constant here quietly audits the *previous* release forever, which is a green
 * check that proves nothing about what users actually download today.
 */
function latestTag() {
  try {
    // `gh release view` resolves only the latest *stable* release and answers
    // "release not found" on a repository that has published only prereleases.
    // `release list` is ordered newest first, so the first entry is the one a
    // user is told to download.
    return execFileSync(
      "gh",
      ["release", "list", "--repo", SLUG, "--limit", "1", "--json", "tagName", "--jq", ".[0].tagName"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch (error) {
    throw new Error(`cannot resolve the latest release (pass --tag explicitly): ${String(error).slice(0, 120)}`);
  }
}

const TAG = arg("tag") ?? latestTag();
/**
 * `--metadata-only` audits everything that can be checked without pulling the
 * artifacts: tag→main, asset names, the digests GitHub reports and the sums file
 * if it is already on disk. Used where the network truncates large downloads;
 * the full audit runs in CI.
 */
const METADATA_ONLY = process.argv.includes("--metadata-only");
const DIR = resolve(arg("dir") ?? join(REPO, ".data", "supply-chain", TAG));
const VERSION = TAG.replace(/^v/, "");

/**
 * Release metadata, read once.
 *
 * Asset names come from the release itself, not from a naming rule guessed here:
 * a beta release used to ship assets named `0.1.6`, and newer ones carry the full
 * `0.1.7-beta.1`. Both are valid as long as the name matches what the tag says,
 * and only the release can tell us which happened.
 */
let assets = [];
try {
  assets = JSON.parse(
    execFileSync("gh", ["api", `repos/${SLUG}/releases/tags/${TAG}`, "--jq", ".assets"], {
      encoding: "utf8",
    }),
  );
} catch (error) {
  console.log(`cannot read the release metadata for ${TAG}: ${String(error).slice(0, 160)}`);
}

const PLATFORM_PATTERNS = [/linux-arm64\.tar\.gz$/, /linux-x64\.tar\.gz$/, /windows-x64\.zip$/];
const CLI_PATTERNS = [/shub-.*linux-arm64\.tar\.gz$/, /shub-.*linux-x64\.tar\.gz$/, /shub-.*windows-x64\.zip$/, /shub-.*node22\.tar\.gz$/];
const EXPECTED = assets
  .map((asset) => asset.name)
  .filter((name) => name.startsWith("search-hub-") && PLATFORM_PATTERNS.some((re) => re.test(name)))
  .sort();
const EXPECTED_CLI = assets
  .map((asset) => asset.name)
  .filter((name) => name.startsWith("shub-") && CLI_PATTERNS.some((re) => re.test(name)))
  .sort();
const ALL_EXPECTED = [...EXPECTED, ...EXPECTED_CLI].sort();

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
};
const warn = (message) => console.log(`NOTE  ${message}`);

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

console.log(`auditing ${TAG}\n`);

// ---- 1. tag → commit → main -------------------------------------------
let tagSha = null;
try {
  // `git/ref/tags/<tag>` points at the *tag object* for an annotated tag and at
  // the commit for a lightweight one. Comparing a tag object's SHA against main
  // is a guaranteed 404, so an annotated tag has to be dereferenced first.
  const ref = JSON.parse(
    execFileSync("gh", ["api", `repos/${SLUG}/git/ref/tags/${TAG}`], { encoding: "utf8" }),
  );
  tagSha = ref.object.sha;
  if (ref.object.type === "tag") {
    const tagObject = JSON.parse(
      execFileSync("gh", ["api", `repos/${SLUG}/git/tags/${tagSha}`], { encoding: "utf8" }),
    );
    tagSha = tagObject.object.sha;
    check("annotated tag dereferences to a commit", tagObject.object.type === "commit", tagSha.slice(0, 8));
  }
  check("tag resolves to a commit", /^[0-9a-f]{40}$/.test(tagSha), tagSha.slice(0, 8));
} catch (error) {
  check("tag exists", false, String(error).slice(0, 120));
}

if (tagSha) {
  try {
    const mainSha = execFileSync("gh", ["api", `repos/${SLUG}/branches/main`, "--jq", ".commit.sha"], {
      encoding: "utf8",
    }).trim();
    if (mainSha === tagSha) {
      check("tag points at main", true, "tag == main HEAD");
    } else {
      // A tag reached via merged PRs can be an ancestor of main; that is fine.
      const compare = execFileSync(
        "gh",
        ["api", `repos/${SLUG}/compare/${tagSha}...${mainSha}`, "--jq", ".status"],
        { encoding: "utf8" },
      ).trim();
      check("tag commit is on main", compare === "identical" || compare === "ahead", `compare=${compare}`);
    }
  } catch (error) {
    check("tag commit is on main", false, String(error).slice(0, 120));
  }
}

// ---- 2. download assets ------------------------------------------------
mkdirSync(DIR, { recursive: true });
let downloaded = 0;
const downloadFailures = [];
try {
  if (assets.length === 0) throw new Error("no release assets were readable");
  for (const asset of assets) {
    const out = join(DIR, asset.name);
    if (existsSync(out) && statSync(out).size === asset.size) {
      downloaded += 1;
      continue;
    }
    if (METADATA_ONLY) continue;
    try {
      // Streamed with a hard timeout: a proxy that stalls mid-body must surface as
      // a short file (caught by the size check), not as a hang.
      const response = await fetch(
        `https://api.github.com/repos/${SLUG}/releases/assets/${asset.id}`,
        {
          headers: {
            accept: "application/octet-stream",
            authorization: `Bearer ${process.env["GH_TOKEN"] ?? process.env["GITHUB_TOKEN"] ?? ""}`,
            "user-agent": "search-hub-supply-chain-audit",
          },
          redirect: "follow",
          signal: AbortSignal.timeout(180_000),
        },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength !== asset.size) {
        throw new Error(`short read: ${buffer.byteLength} of ${asset.size} bytes`);
      }
      writeFileSync(out, buffer);
      downloaded += 1;
    } catch (error) {
      downloadFailures.push(`${asset.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
} catch (error) {
  downloadFailures.push(`release metadata: ${String(error).slice(0, 160)}`);
}
if (downloadFailures.length > 0) {
  // Never quietly continue: an audit that could not fetch the artifacts proves
  // nothing about them.
  check("release assets downloaded", false, downloadFailures.slice(0, 2).join(" | "));
} else if (METADATA_ONLY) {
  warn(`metadata-only: ${assets.length} asset(s) listed, none downloaded by design`);
} else {
  check("release assets downloaded", downloaded === assets.length, `${downloaded} of ${assets.length} assets`);
}

const publishedSizes = new Map(assets.map((asset) => [asset.name, asset.size]));

for (const name of ["SHA256SUMS", ...ALL_EXPECTED]) {
  const path = join(DIR, name);
  const present = existsSync(path);
  const size = present ? statSync(path).size : 0;
  const expectedSize = publishedSizes.get(name);
  // A truncated download is the single most common way a "verification" lies: the
  // bytes are wrong, the hash is wrong, and the reason looks like a bad release.
  const sizeOk = present && (expectedSize === undefined || size === expectedSize);
  if (METADATA_ONLY && !present) {
    // Nothing was downloaded on purpose; saying "missing" would look like a
    // failed release. The published size is still checked below.
    warn(`${name}: not on disk (metadata-only run); published size ${expectedSize ?? "unknown"}`);
    continue;
  }
  check(
    `asset present and complete: ${name}`,
    sizeOk,
    present ? `${size} bytes${expectedSize === undefined ? "" : ` of ${expectedSize}`}` : "missing",
  );
}

// ---- 3. SHA256SUMS vs actual bytes ------------------------------------
const sumsPath = join(DIR, "SHA256SUMS");
if (existsSync(sumsPath)) {
  const lines = readFileSync(sumsPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  check("SHA256SUMS is not empty", lines.length > 0, `${lines.length} entries`);
  for (const line of lines) {
    const [expected, name] = line.split(/\s+/);
    const file = join(DIR, name ?? "");
    if (!name || !existsSync(file)) {
      check(`sums entry has a file: ${name ?? "(none)"}`, false);
      continue;
    }
    const actual = createHash("sha256").update(readFileSync(file)).digest("hex");
    check(`sha256 matches: ${name}`, actual === expected, actual.slice(0, 12));
  }
}

// ---- 4. the release digest GitHub itself reports ----------------------
try {
  for (const asset of assets) {
    const local = join(DIR, asset.name);
    if (!existsSync(local)) continue;
    const digest = String(asset.digest ?? "");
    if (!digest.startsWith("sha256:")) {
      warn(`${asset.name}: GitHub publishes no digest for this asset (older upload)`);
      continue;
    }
    const actual = createHash("sha256").update(readFileSync(local)).digest("hex");
    // This is the value the updater trusts: it comes from the API response, not
    // from a file that travelled with the download.
    check(`platform digest matches: ${asset.name}`, actual === digest.slice(7), actual.slice(0, 12));
  }
} catch (error) {
  check("release metadata readable", false, String(error).slice(0, 120));
}

// ---- 5. asset name vs tag version / arch ------------------------------
// Every platform must be present exactly once, and each name must carry the
// version the tag claims. An asset named 0.1.6 inside a v0.1.6-beta.1 release is
// a real supply-chain smell: a beta package becomes indistinguishable from the
// final 0.1.6 by filename alone.
check("three server platform assets are published", EXPECTED.length === 3, `${EXPECTED.length}: ${EXPECTED.join(", ")}`);
if (EXPECTED_CLI.length > 0) {
  check("four CLI assets are published", EXPECTED_CLI.length === 4, `${EXPECTED_CLI.length}: ${EXPECTED_CLI.join(", ")}`);
  for (const pattern of CLI_PATTERNS) {
    check(`exactly one CLI asset matches ${String(pattern)}`, EXPECTED_CLI.filter((name) => pattern.test(name)).length === 1);
  }
}
for (const pattern of PLATFORM_PATTERNS) {
  check(
    `exactly one asset matches ${String(pattern)}`,
    EXPECTED.filter((name) => pattern.test(name)).length === 1,
  );
}
/** The version the tag claims, without a leading `v` (e.g. `0.1.7-beta.1`). */
const bareVersion = VERSION.replace(/-(alpha|beta|rc)\.\d+$/, "");
for (const asset of ALL_EXPECTED) {
  const carriesFull = asset.includes(`v${VERSION}-`);
  const carriesBare = new RegExp(`v${bareVersion.replace(/\./g, "\\.")}-(windows|linux)-`).test(asset);
  check(`asset name carries a version: ${asset}`, carriesFull || carriesBare);
  if (carriesBare && !carriesFull) {
    warn(
      `${asset}: the name says ${bareVersion} while the tag says ${VERSION}; ` +
        "a beta package is indistinguishable from a final release by filename alone",
    );
  }
  check(`asset name carries a platform: ${asset}`, /-(windows|linux)-(x64|arm64)\.|-(node22)\./.test(asset));
}

// ---- 6. archive contents: no traversal, sane modes --------------------
for (const asset of ALL_EXPECTED) {
  const path = join(DIR, asset);
  if (!existsSync(path)) continue;
  try {
    const listing =
      asset.endsWith(".zip")
        ? execFileSync("unzip", ["-Z1", path], { encoding: "utf8" })
        : execFileSync("tar", ["-tzf", path], { encoding: "utf8" });
    const entries = listing.split("\n").map((line) => line.trim()).filter(Boolean);
    const unsafe = entries.filter(
      (entry) => entry.startsWith("/") || entry.split("/").includes("..") || /^[a-zA-Z]:/.test(entry),
    );
    check(`no path traversal in ${asset}`, unsafe.length === 0, unsafe.slice(0, 2).join(", "));
    const suspicious = entries.filter((entry) => entry.includes("..\\") || entry.startsWith("./../"));
    check(`no Windows-style traversal in ${asset}`, suspicious.length === 0);
  } catch (error) {
    check(`archive readable: ${asset}`, false, String(error).slice(0, 120));
  }
}

// ---- 7. executable bits inside the package ---------------------------
// Linux tarballs must ship an executable launcher and updater; a non-executable
// launcher turns into "permission denied" on first use.
const tarList = EXPECTED.find((name) => name.includes("linux-x64"));
if (tarList) {
  const path = join(DIR, tarList);
  if (existsSync(path)) {
    try {
      const verbose = execFileSync("tar", ["-tvzf", path], { encoding: "utf8" });
      const launcher = verbose.split("\n").find((line) => line.includes("bin/search-hub") && !line.includes(".mjs"));
      check(
        "linux launcher is executable",
        Boolean(launcher && launcher.startsWith("-rwx")),
        launcher?.slice(0, 40) ?? "not found",
      );
      const updater = verbose.split("\n").find(
        (line) => line.includes("bin/update") && !line.includes(".mjs"),
      );
      if (!updater) {
        // Releases published before the updater was shipped legitimately lack it.
        // Reported, not failed: failing here would block a PR on an old release.
        warn("this release predates the shipped updater (bin/update absent); the next tag includes it");
      } else {
        check("linux updater is executable", updater.startsWith("-rwx"), updater.slice(0, 40));
      }
      const setuid = verbose.split("\n").filter((line) => /^-...s|^-......s/.test(line) || line.includes(" SUID "));
      check("no setuid/setgid files in the package", setuid.length === 0, setuid.slice(0, 1).join(""));
    } catch (error) {
      check("linux archive modes readable", false, String(error).slice(0, 120));
    }
  }
}

const cliTarList = EXPECTED_CLI.find((name) => name.includes("linux-x64"));
if (cliTarList) {
  const path = join(DIR, cliTarList);
  if (existsSync(path)) {
    try {
      const verbose = execFileSync("tar", ["-tvzf", path], { encoding: "utf8" });
      const executable = verbose.split("\n").find((line) => /(?:^|\s)\.\/shub$/.test(line.trim()));
      check("linux CLI is executable", Boolean(executable && executable.startsWith("-rwx")), executable?.slice(0, 40) ?? "not found");
      const setuid = verbose.split("\n").filter((line) => /^-...s|^-......s/.test(line) || line.includes(" SUID "));
      check("no setuid/setgid files in the CLI package", setuid.length === 0, setuid.slice(0, 1).join(""));
    } catch (error) {
      check("CLI archive modes readable", false, String(error).slice(0, 120));
    }
  }
}

// ---- 8. what the trust anchor actually is ----------------------------
warn("trust anchor: GitHub account/TLS + the `digest` field GitHub computes for each asset");
try {
  execFileSync("gh", ["release", "verify", TAG, "--repo", SLUG], { encoding: "utf8", stdio: "pipe" });
  check("build provenance (attestation) present", true);
} catch (error) {
  const text = String(error?.stdout ?? "") + String(error?.stderr ?? "") + String(error);
  if (text.includes("no attestations")) {
    // Not a pass: an attestation would let a user verify *how* the artifact was
    // built, which the digest alone cannot. Reported as a gap, not as a failure
    // of this release's integrity.
    warn("no build provenance: `gh release verify` reports no attestations for this tag");
    warn("so integrity rests on the GitHub account + TLS, not on a signed build record");
  } else {
    warn(`attestation check inconclusive: ${text.slice(0, 120)}`);
  }
}

console.log(
  failures === 0
    ? "\nSupply-chain checks passed (see NOTE lines for what is *not* protected)."
    : `\n${failures} supply-chain check(s) failed.`,
);
process.exitCode = failures === 0 ? 0 : 1;
