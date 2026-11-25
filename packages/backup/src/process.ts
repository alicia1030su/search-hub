import { readFile } from "node:fs/promises";

/** Return the Linux process start-time token (proc field 22), when available. */
export async function readProcessStartTime(pid: number): Promise<string | null> {
  if (process.platform !== "linux" || !Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const raw = await readFile(`/proc/${pid}/stat`, "utf8");
    const closeParen = raw.lastIndexOf(")");
    if (closeParen < 0) return null;
    const fields = raw.slice(closeParen + 2).split(" ");
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

/** Return whether a PID exists; EPERM still proves that the process exists. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}
