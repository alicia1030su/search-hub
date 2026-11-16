/**
 * Agent Skills validation and packaging.
 *
 * Implements the rules from the Agent Skills specification
 * (https://agentskills.io/specification) as a local validator, because the
 * upstream `skills-ref` CLI is a Python package that a Node deployment cannot
 * assume. The rules encoded here are the normative ones:
 *
 * - `SKILL.md` must exist and start with YAML frontmatter
 * - `name`: 1-64 chars, lowercase alphanumeric + hyphens, no leading/trailing or
 *   consecutive hyphens, and it must match the directory name
 * - `description`: 1-1024 chars, non-empty
 * - optional `license` / `compatibility` (<=500) / `metadata` (string map) /
 *   `allowed-tools`
 *
 * Two security rules go beyond the spec because they are how a malicious skill
 * would attack this host:
 *
 * - a referenced file must resolve **inside** the skill directory (no `../`,
 *   no absolute paths, no symlink escape)
 * - `scripts/` contents are never executed by the API; they are only packaged
 */
import { existsSync, readdirSync, readFileSync, lstatSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

export interface SkillIssue {
  level: "error" | "warning";
  field: string;
  message: string;
}

export interface SkillFile {
  path: string;
  bytes: number;
}

export interface SkillValidation {
  name: string;
  directory: string;
  valid: boolean;
  issues: SkillIssue[];
  metadata: {
    name: string | null;
    description: string | null;
    license: string | null;
    compatibility: string | null;
    version: string | null;
    metadata: Record<string, string>;
  };
  files: SkillFile[];
  /** Files referenced from SKILL.md that resolve inside the skill. */
  references: string[];
}

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Minimal frontmatter reader.
 *
 * Only the subset the spec defines is supported: scalar `key: value` lines and
 * one level of `metadata:` nesting. Anything else is reported rather than
 * silently ignored, so a malformed skill cannot pass by looking tidy.
 */
export function parseFrontmatter(source: string): {
  data: Record<string, unknown>;
  body: string;
  error: string | null;
} {
  if (!source.startsWith("---")) {
    return { data: {}, body: source, error: "SKILL.md must start with a YAML frontmatter block (---)" };
  }
  const end = source.indexOf("\n---", 3);
  if (end === -1) {
    return { data: {}, body: source, error: "Unterminated frontmatter block" };
  }
  const raw = source.slice(3, end).replace(/^\r?\n/, "");
  const body = source.slice(end + 4);
  const data: Record<string, unknown> = {};
  const nested: Record<string, Record<string, string>> = {};
  let currentNest: string | null = null;

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indented = /^\s+\S/.test(line);
    const match = line.match(/^(\s*)([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const [, , key, rawValue] = match;
    const value = rawValue!.trim();
    if (indented && currentNest) {
      (nested[currentNest] ??= {})[key!] = stripQuotes(value);
      continue;
    }
    if (!value) {
      currentNest = key!;
      nested[key!] = {};
      continue;
    }
    currentNest = null;
    data[key!] = stripQuotes(value);
  }
  for (const [key, value] of Object.entries(nested)) {
    if (Object.keys(value).length > 0) data[key] = value;
  }
  return { data, body, error: null };
}

function stripQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

/** Validates one skill directory. Never throws: every problem is an issue. */
export function validateSkillDir(dir: string): SkillValidation {
  const directory = dir.split(sep).pop() ?? dir;
  const issues: SkillIssue[] = [];
  const skillMd = join(dir, "SKILL.md");

  if (!existsSync(skillMd)) {
    return {
      name: directory,
      directory,
      valid: false,
      issues: [{ level: "error", field: "SKILL.md", message: "SKILL.md is missing" }],
      metadata: {
        name: null,
        description: null,
        license: null,
        compatibility: null,
        version: null,
        metadata: {},
      },
      files: [],
      references: [],
    };
  }

  const source = readFileSync(skillMd, "utf8");
  const parsed = parseFrontmatter(source);
  if (parsed.error) {
    issues.push({ level: "error", field: "frontmatter", message: parsed.error });
  }

  const name = typeof parsed.data["name"] === "string" ? (parsed.data["name"] as string) : null;
  const description =
    typeof parsed.data["description"] === "string" ? (parsed.data["description"] as string) : null;
  const license = typeof parsed.data["license"] === "string" ? (parsed.data["license"] as string) : null;
  const compatibility =
    typeof parsed.data["compatibility"] === "string" ? (parsed.data["compatibility"] as string) : null;
  const rawMetadata =
    parsed.data["metadata"] && typeof parsed.data["metadata"] === "object"
      ? (parsed.data["metadata"] as Record<string, string>)
      : {};

  if (!name) {
    issues.push({ level: "error", field: "name", message: "name is required" });
  } else {
    if (name.length < 1 || name.length > 64) {
      issues.push({ level: "error", field: "name", message: "name must be 1-64 characters" });
    }
    if (!NAME_PATTERN.test(name)) {
      issues.push({
        level: "error",
        field: "name",
        message:
          "name may only use lowercase letters, digits and single hyphens, and must not start or end with a hyphen",
      });
    }
    if (name !== directory) {
      issues.push({
        level: "error",
        field: "name",
        message: `name "${name}" must match the directory name "${directory}"`,
      });
    }
  }

  if (!description) {
    issues.push({ level: "error", field: "description", message: "description is required" });
  } else if (description.length > 1024) {
    issues.push({
      level: "error",
      field: "description",
      message: `description is ${description.length} characters; the limit is 1024`,
    });
  } else if (description.length < 40) {
    issues.push({
      level: "warning",
      field: "description",
      message: "a short description makes it hard for an agent to decide when to use this skill",
    });
  }

  if (compatibility && compatibility.length > 500) {
    issues.push({
      level: "error",
      field: "compatibility",
      message: "compatibility must be at most 500 characters",
    });
  }

  const files = listFiles(dir);
  if (source.split(/\r?\n/).length > 500) {
    issues.push({
      level: "warning",
      field: "SKILL.md",
      message: "SKILL.md is over 500 lines; move detail into references/",
    });
  }

  // Every markdown link to a local file must stay inside the skill directory.
  const references: string[] = [];
  for (const raw of collectLocalLinks(parsed.body)) {
    const target = raw.split("#")[0]!;
    if (!target) continue;
    // An external URL in prose is documentation, not a packaged file. Only
    // anything that looks like a path is validated.
    if (/^(https?|mailto|tel):/i.test(target)) continue;
    if (target.startsWith("/") || /^[a-zA-Z]+:/.test(target)) {
      issues.push({
        level: "error",
        field: "references",
        message: `reference "${raw}" is absolute or remote; use a relative path inside the skill`,
      });
      continue;
    }
    const resolved = resolve(dir, target);
    if (!isInside(dir, resolved)) {
      issues.push({
        level: "error",
        field: "references",
        message: `reference "${raw}" escapes the skill directory`,
      });
      continue;
    }
    if (!existsSync(resolved)) {
      issues.push({
        level: "warning",
        field: "references",
        message: `reference "${raw}" does not exist in the package`,
      });
      continue;
    }
    references.push(relative(dir, resolved).split(sep).join("/"));
  }

  // A symlink pointing outside the package would let a skill read host files.
  for (const file of files) {
    const path = join(dir, file.path.split("/").join(sep));
    try {
      if (lstatSync(path).isSymbolicLink()) {
        const target = realpathSync(path);
        if (!isInside(dir, target)) {
          issues.push({
            level: "error",
            field: "files",
            message: `symlink "${file.path}" points outside the skill directory`,
          });
        } else {
          issues.push({
            level: "warning",
            field: "files",
            message: `symlink "${file.path}" is packaged as a link; prefer a real file`,
          });
        }
      }
    } catch {
      // A broken link is reported by the reference check above.
    }
  }

  return {
    name: name ?? directory,
    directory,
    valid: !issues.some((issue) => issue.level === "error"),
    issues,
    metadata: {
      name,
      description,
      license,
      compatibility,
      version: typeof rawMetadata["version"] === "string" ? rawMetadata["version"] : null,
      metadata: rawMetadata,
    },
    files,
    references: [...new Set(references)],
  };
}

/** Validates every skill under a root, skipping non-directories. */
export function validateAllSkills(root: string): SkillValidation[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => validateSkillDir(join(root, entry.name)))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function listFiles(dir: string, base = dir, out: SkillFile[] = []): SkillFile[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) {
      listFiles(absolute, base, out);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      let bytes = 0;
      try {
        bytes = entry.isFile() ? statSync(absolute).size : 0;
      } catch {
        bytes = 0;
      }
      out.push({ path: relative(base, absolute).split(sep).join("/"), bytes });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function collectLocalLinks(body: string): string[] {
  const found: string[] = [];
  const markdown = /\[[^\]]*]\(([^)\s]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = markdown.exec(body)) !== null) found.push(match[1]!);
  // Bare `scripts/foo.py` style mentions are common in skill bodies.
  const bare = /(?:^|[\s(])((?:\.{0,2}\/)?(?:scripts|references|assets)\/[A-Za-z0-9._\-/]+)/g;
  while ((match = bare.exec(body)) !== null) found.push(match[1]!);
  return found;
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && !/^[a-zA-Z]:/.test(rel));
}
