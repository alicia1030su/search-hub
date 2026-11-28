import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseFrontmatter,
  validateAllSkills,
  validateSkillDir,
} from "../../apps/api/src/services/skills.js";

/**
 * Agent Skills validation against the specification.
 *
 * The negative cases matter most: a validator that only accepts well-formed
 * input is useless, so every rule has a case that must fail.
 */
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "search-hub-skill-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeSkill(name: string, frontmatter: string, body = "# Body\n") {
  const path = join(dir, name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "SKILL.md"), `---\n${frontmatter}\n---\n${body}`, "utf8");
  return path;
}

describe("frontmatter parsing", () => {
  it("reads scalars and one nested metadata level", () => {
    const parsed = parseFrontmatter(
      `---\nname: demo\ndescription: does a thing\nlicense: MIT\nmetadata:\n  author: me\n  version: "1.0"\n---\nbody`,
    );
    expect(parsed.error).toBeNull();
    expect(parsed.data["name"]).toBe("demo");
    expect(parsed.data["metadata"]).toEqual({ author: "me", version: "1.0" });
    expect(parsed.body.trim()).toBe("body");
  });

  it("rejects a missing or unterminated block", () => {
    expect(parseFrontmatter("no frontmatter").error).toContain("frontmatter");
    expect(parseFrontmatter("---\nname: x\n").error).toContain("Unterminated");
  });
});

describe("skill validation", () => {
  it("accepts a minimal valid skill", () => {
    const path = writeSkill(
      "demo-skill",
      'name: demo-skill\ndescription: A valid description that says what it does and when to use it.',
    );
    const result = validateSkillDir(path);
    expect(result.valid).toBe(true);
    expect(result.issues.filter((issue) => issue.level === "error")).toHaveLength(0);
    expect(result.metadata.name).toBe("demo-skill");
  });

  it("rejects a name that does not match the directory", () => {
    const path = writeSkill("real-dir", "name: other-name\ndescription: " + "x".repeat(60));
    const result = validateSkillDir(path);
    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.message.includes("must match the directory"))).toBe(true);
  });

  it("rejects uppercase, leading hyphens and consecutive hyphens in the name", () => {
    for (const bad of ["Demo-Skill", "-demo", "demo--skill", "demo skill"]) {
      const path = writeSkill(bad, `name: ${bad}\ndescription: ${"x".repeat(60)}`);
      const result = validateSkillDir(path);
      expect(result.valid, bad).toBe(false);
      expect(result.issues.some((issue) => issue.field === "name")).toBe(true);
    }
  });

  it("rejects a name longer than 64 characters", () => {
    const long = "a".repeat(65);
    const path = writeSkill(long, `name: ${long}\ndescription: ${"x".repeat(60)}`);
    expect(validateSkillDir(path).valid).toBe(false);
  });

  it("rejects a missing description and one over 1024 characters", () => {
    const missing = writeSkill("no-desc", "name: no-desc");
    expect(validateSkillDir(missing).valid).toBe(false);

    const tooLong = writeSkill("long-desc", `name: long-desc\ndescription: ${"y".repeat(1025)}`);
    const result = validateSkillDir(tooLong);
    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.message.includes("1024"))).toBe(true);
  });

  it("rejects a compatibility string over 500 characters", () => {
    const path = writeSkill(
      "compat",
      `name: compat\ndescription: ${"x".repeat(60)}\ncompatibility: ${"z".repeat(501)}`,
    );
    expect(validateSkillDir(path).valid).toBe(false);
  });

  it("rejects a reference that escapes the skill directory", () => {
    const path = writeSkill(
      "escape",
      `name: escape\ndescription: ${"x".repeat(60)}`,
      "See [the guide](../secrets.md) for details.\n",
    );
    const result = validateSkillDir(path);
    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.message.includes("escapes"))).toBe(true);
  });

  it("rejects an absolute path reference", () => {
    const path = writeSkill(
      "absolute",
      `name: absolute\ndescription: ${"x".repeat(60)}`,
      "Run [the script](/etc/passwd) first.\n",
    );
    expect(validateSkillDir(path).valid).toBe(false);
  });

  it("warns but accepts a missing relative reference", () => {
    const path = writeSkill(
      "missing-ref",
      `name: missing-ref\ndescription: ${"x".repeat(60)}`,
      "See [the guide](references/GUIDE.md).\n",
    );
    const result = validateSkillDir(path);
    expect(result.valid).toBe(true);
    expect(result.issues.some((issue) => issue.level === "warning" && issue.field === "references")).toBe(true);
  });

  it("accepts a reference that exists and records it", () => {
    const path = writeSkill(
      "with-ref",
      `name: with-ref\ndescription: ${"x".repeat(60)}`,
      "See [the guide](references/GUIDE.md).\n",
    );
    mkdirSync(join(path, "references"), { recursive: true });
    writeFileSync(join(path, "references", "GUIDE.md"), "# Guide\n", "utf8");
    const result = validateSkillDir(path);
    expect(result.valid).toBe(true);
    expect(result.references).toContain("references/GUIDE.md");
    expect(result.files.some((file) => file.path === "references/GUIDE.md")).toBe(true);
  });

  it("does not treat prose URLs as packaged references", () => {
    const path = writeSkill(
      "prose-url",
      `name: prose-url\ndescription: ${"x".repeat(60)}`,
      "Background: [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110).\n",
    );
    const result = validateSkillDir(path);
    expect(result.valid).toBe(true);
    expect(result.references).toHaveLength(0);
  });

  it("rejects a symlink that points outside the skill", () => {
    const outside = join(dir, "outside.txt");
    writeFileSync(outside, "secret\n", "utf8");
    const path = writeSkill("linker", `name: linker\ndescription: ${"x".repeat(60)}`);
    try {
      symlinkSync(outside, join(path, "leak.txt"));
    } catch {
      // Windows without developer mode cannot create symlinks; skip quietly.
      return;
    }
    const result = validateSkillDir(path);
    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.message.includes("symlink"))).toBe(true);
  });

  it("reports a missing SKILL.md instead of throwing", () => {
    const path = join(dir, "empty-skill");
    mkdirSync(path, { recursive: true });
    const result = validateSkillDir(path);
    expect(result.valid).toBe(false);
    expect(result.issues[0]!.message).toContain("SKILL.md is missing");
  });

  it("validates every directory under a root", () => {
    writeSkill("one", `name: one\ndescription: ${"x".repeat(60)}`);
    writeSkill("two", `name: two\ndescription: ${"x".repeat(60)}`);
    const results = validateAllSkills(dir);
    expect(results.map((item) => item.name)).toEqual(["one", "two"]);
    expect(results.every((item) => item.valid)).toBe(true);
  });

  it("accepts the four skills that ship with the repository", async () => {
    const { validateSkillDir: validate } = await import("../../apps/api/src/services/skills.js");
    for (const name of ["search-web", "deep-research", "fetch-webpage", "research-with-citations"]) {
      const result = validate(join("packages", "skills", name));
      expect(result.valid, `${name}: ${JSON.stringify(result.issues)}`).toBe(true);
      expect(result.metadata.name).toBe(name);
      expect(result.metadata.description).toBeTruthy();
      expect(result.metadata.description!.length).toBeLessThanOrEqual(1024);
    }
  });
});
