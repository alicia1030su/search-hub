import lockfile from "proper-lockfile";

/** Cross-process lock with proper-lockfile's owner metadata, heartbeat and stale recovery. */
export async function withBackupLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  let compromised: Error | undefined;
  const release = await lockfile.lock(path, {
    realpath: false,
    stale: 30_000,
    update: 10_000,
    retries: 0,
    onCompromised: (error) => { compromised = error; },
  }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ELOCKED") throw new Error("Another backup verification or restore process holds the lock");
    throw error;
  });
  try {
    const result = await operation();
    if (compromised) throw compromised;
    return result;
  } finally {
    await release().catch(() => undefined);
  }
}
