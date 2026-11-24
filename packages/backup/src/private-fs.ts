import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, rmSync, type Stats } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, rm, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const systemDirectory = process.env["SystemRoot"] ? join(process.env["SystemRoot"], "System32") : "C:/Windows/System32";
const whoamiPath = join(systemDirectory, "whoami.exe");
const icaclsPath = join(systemDirectory, "icacls.exe");
const powershellPath = join(process.env["SystemRoot"] ?? "C:/Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
let cachedSid: string | undefined;

const WINDOWS_ACL = String.raw`$path = $env:SHUB_ACL_PATH;
$directory = $env:SHUB_ACL_DIRECTORY -eq '1';
$sid = $env:SHUB_ACL_SID;
$acl = Get-Acl -LiteralPath $path;
$acl.SetAccessRuleProtection($true, $false);
$allowed = @($sid, 'S-1-5-18', 'S-1-5-32-544');
foreach ($rule in @($acl.Access)) {
  $identity = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value;
  if ($allowed -notcontains $identity) { [void]$acl.RemoveAccessRuleSpecific($rule) }
}
$inheritance = if ($directory) { 'ContainerInherit,ObjectInherit' } else { 'None' };
foreach ($identity in $allowed) {
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
    [System.Security.Principal.SecurityIdentifier]$identity,
    'FullControl', $inheritance, 'None', 'Allow');
  $acl.SetAccessRule($rule);
}
if ($directory) { [System.IO.Directory]::SetAccessControl($path, $acl) }
else { [System.IO.File]::SetAccessControl($path, $acl) }`;

const WINDOWS_DIRECTORY_FSYNC = String.raw`$code = @'
using System;
using System.Runtime.InteropServices;
public static class SearchHubDirectoryFlush {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool FlushFileBuffers(IntPtr file);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr file);
}
'@;
Add-Type -TypeDefinition $code;
$handle = [SearchHubDirectoryFlush]::CreateFile($env:SHUB_FSYNC_PATH, [uint32]0x40000000, [uint32]7, [IntPtr]::Zero, [uint32]3, [uint32]0x02000000, [IntPtr]::Zero);
if ($handle -eq [IntPtr](-1)) { throw "CreateFile failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" };
try { if (-not [SearchHubDirectoryFlush]::FlushFileBuffers($handle)) { throw "FlushFileBuffers failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" } }
finally { [void][SearchHubDirectoryFlush]::CloseHandle($handle) }`;

async function currentWindowsSid(): Promise<string> {
  if (cachedSid) return cachedSid;
  const result = await execFileAsync(whoamiPath, ["/user", "/fo", "csv", "/nh"], { windowsHide: true });
  const fields = result.stdout.trim().match(/"([^"]*)"/g)?.map((field) => field.slice(1, -1));
  const sid = fields?.at(-1);
  if (!sid || !/^S-1-[0-9-]+$/.test(sid)) throw new Error("Cannot determine the current Windows SID");
  cachedSid = sid;
  return sid;
}

function currentWindowsSidSync(): string {
  const output = execFileSync(whoamiPath, ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true });
  const fields = output.trim().match(/"([^"]*)"/g)?.map((field) => field.slice(1, -1));
  const sid = fields?.at(-1);
  if (!sid || !/^S-1-[0-9-]+$/.test(sid)) throw new Error("Cannot determine the current Windows SID");
  return sid;
}

function aclIdentities(sddl: string): string[] {
  return [...sddl.matchAll(/;;;(S-1-[0-9-]+|SY|BA)\)/g)].map((match) => match[1] as string);
}

async function readWindowsAcl(path: string): Promise<string> {
  const aclPath = join(tmpdir(), `.shbackup-acl-${process.pid}-${randomBytes(8).toString("hex")}`);
  try {
    await execFileAsync(icaclsPath, [path, "/save", aclPath], { windowsHide: true });
    const bytes = await readFile(aclPath);
    return bytes[1] === 0 ? bytes.toString("utf16le") : bytes.toString("utf8");
  } finally {
    await rm(aclPath, { force: true }).catch(() => undefined);
  }
}

function readWindowsAclSync(path: string): string {
  const aclPath = join(tmpdir(), `.shbackup-acl-${process.pid}-${randomBytes(8).toString("hex")}`);
  try {
    execFileSync(icaclsPath, [path, "/save", aclPath], { windowsHide: true, stdio: "ignore" });
    const bytes = readFileSync(aclPath);
    return bytes[1] === 0 ? bytes.toString("utf16le") : bytes.toString("utf8");
  } finally {
    try { rmSync(aclPath, { force: true }); } catch { /* best-effort owned temp cleanup */ }
  }
}

/** Synchronous variant for first-run master.key creation before async services exist. */
export function restrictWindowsAclSync(path: string, directory: boolean): void {
  const sid = currentWindowsSidSync();
  execFileSync(powershellPath, ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_ACL], {
    windowsHide: true,
    env: { ...process.env, SHUB_ACL_PATH: resolve(path), SHUB_ACL_DIRECTORY: directory ? "1" : "0", SHUB_ACL_SID: sid },
  });
  const readback = readWindowsAclSync(path);
  if (/\([AD];[^;]*;[^)]*;ID\)/.test(readback) || /\(D;/.test(readback)) throw new Error("Private Windows ACL still contains inherited or deny entries");
  const allowed = new Set([sid, "S-1-5-18", "S-1-5-32-544", "SY", "BA"]);
  const identities = aclIdentities(readback);
  if (!identities.includes(sid) || identities.some((identity) => !allowed.has(identity))) {
    throw new Error("Private Windows ACL read-back contains an unauthorized principal");
  }
}

/** Applies and reads back a non-inherited ACL for only SID/SYSTEM/Administrators. */
export async function restrictWindowsAcl(path: string, directory: boolean): Promise<void> {
  const sid = await currentWindowsSid();
  await execFileAsync(powershellPath, ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_ACL], {
    windowsHide: true,
    env: {
      ...process.env,
      SHUB_ACL_PATH: resolve(path),
      SHUB_ACL_DIRECTORY: directory ? "1" : "0",
      SHUB_ACL_SID: sid,
    },
  });
  const readback = await readWindowsAcl(path);
  if (/\([AD];[^;]*;[^)]*;ID\)/.test(readback) || /\(D;/.test(readback)) throw new Error("Private Windows ACL still contains inherited or deny entries");
  const allowed = new Set([sid, "S-1-5-18", "S-1-5-32-544", "SY", "BA"]);
  const identities = aclIdentities(readback);
  if (!identities.includes(sid) || identities.some((identity) => !allowed.has(identity))) {
    throw new Error("Private Windows ACL read-back contains an unauthorized principal");
  }
}

/** Rejects symlinks/junctions/reparse points at every existing path prefix. */
export async function assertNoReparseAncestors(path: string, includeLeaf = true): Promise<void> {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const relative = absolute.slice(root.length);
  const prefixes = [root];
  let current = root;
  for (const component of relative.split(/[\\/]+/).filter(Boolean)) {
    current = join(current, component);
    prefixes.push(current);
  }
  if (!includeLeaf && prefixes.length > 0) prefixes.pop();
  for (const prefix of prefixes) {
    try {
      const info = await lstat(prefix);
      if (info.isSymbolicLink()) throw new Error(`Reparse points are not allowed: ${prefix}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
}

async function assertAllowedWindowsAcl(path: string, label: string): Promise<void> {
  const readback = await readWindowsAcl(path);
  if (/\([AD];[^;]*;[^)]*;ID\)/.test(readback) || /\(D;/.test(readback)) throw new Error(`${label} ACL must not inherit permissions or contain deny entries`);
  const sid = await currentWindowsSid();
  const allowed = new Set([sid, "S-1-5-18", "S-1-5-32-544", "SY", "BA"]);
  const identities = aclIdentities(readback);
  if (!identities.includes(sid) || identities.some((identity) => !allowed.has(identity))) {
    throw new Error(`${label} ACL contains an unauthorized principal`);
  }
}

/** Validates a regular input file, its size, ownership bits and Windows ACL. */
export async function assertSecureRegularFile(path: string, maxBytes: number, options: { allowPrivateParent?: boolean } = {}): Promise<Stats> {
  await assertNoReparseAncestors(path);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Input must be a regular file, not a link or special file");
  if (info.size > maxBytes) throw new Error(`Input exceeds the ${maxBytes}-byte safety limit`);
  if (process.platform === "win32") {
    if (options.allowPrivateParent === true) await assertAllowedWindowsAcl(dirname(path), "Private parent");
    else await assertAllowedWindowsAcl(path, "Input");
  } else if ((info.mode & 0o777) !== 0o600) {
    throw new Error(`Input file mode must be exactly 0600: ${path}`);
  }
  return info;
}

/** Creates a private 0700 directory and proves its permissions. */
export async function createPrivateDirectory(parent: string, prefix: string): Promise<string> {
  await assertNoReparseAncestors(parent);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const path = await mkdtemp(join(parent, prefix));
  try {
    if (process.platform === "win32") await restrictWindowsAcl(path, true);
    else await chmod(path, 0o700);
    if (process.platform !== "win32") {
      const info = await lstat(path);
      if ((info.mode & 0o777) !== 0o700) throw new Error("Private directory mode read-back failed");
    }
    return path;
  } catch (error) {
    await rm(path, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/** Creates a private subdirectory inside an already-private staging root. */
export async function createPrivateSubdirectory(parent: string, name: string): Promise<string> {
  await assertNoReparseAncestors(parent);
  const path = join(parent, name);
  await mkdir(path, { mode: 0o700 });
  if (process.platform === "win32") await restrictWindowsAcl(path, true);
  else {
    const handle = await open(path, "r");
    try { await handle.chmod(0o700); } finally { await handle.close(); }
  }
  return path;
}

/** Opens a new 0600 file and proves its permissions. */
export async function openPrivateFile(path: string): Promise<Awaited<ReturnType<typeof open>>> {
  await assertNoReparseAncestors(path, false);
  const handle = await open(path, "wx", 0o600);
  try {
    if (process.platform === "win32") await restrictWindowsAcl(path, false);
    else await handle.chmod(0o600);
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(path, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Ensures the output parent exists without following reparse points. */
export async function ensureOutputParent(path: string): Promise<void> {
  await assertNoReparseAncestors(dirname(path));
  await mkdir(dirname(path), { recursive: true });
}

export async function fsyncFile(path: string): Promise<void> {
  const handle = await open(path, "r+");
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function fsyncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") {
    await execFileAsync(powershellPath, ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_DIRECTORY_FSYNC], {
      windowsHide: true,
      env: { ...process.env, SHUB_FSYNC_PATH: resolve(path) },
    });
    return;
  }
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Atomically publishes a completed file without overwriting an existing path. */
export async function publishNoOverwrite(temporaryPath: string, outputPath: string): Promise<void> {
  const { link } = await import("node:fs/promises");
  await fsyncFile(temporaryPath);
  try {
    await link(temporaryPath, outputPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Output already exists; refusing to overwrite it");
    throw error;
  }
  await fsyncDirectory(dirname(outputPath));
}

export async function availableDiskBytes(path: string): Promise<number> {
  const info = await statfs(path);
  return Number(info.bavail) * Number(info.bsize);
}

export async function requireDiskBytes(path: string, bytes: number): Promise<void> {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Invalid disk-space requirement");
  if (await availableDiskBytes(path) < bytes) throw new Error("Insufficient disk space for the requested backup operation");
}

export async function readSmallTextFile(path: string, maxBytes: number): Promise<string> {
  await assertSecureRegularFile(path, maxBytes);
  const value = await readFile(path, "utf8");
  if (Buffer.byteLength(value, "utf8") > maxBytes) throw new Error("Input exceeds its safety limit");
  return value;
}
