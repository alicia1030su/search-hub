// Preloaded only into owned Node children. Sends bounded V8 samples to a
// random loopback endpoint; it never reads or transmits argv, env, or queries.
const endpoint = process.env["SEARCH_HUB_RESOURCE_TELEMETRY_URL"];
const token = process.env["SEARCH_HUB_RESOURCE_TELEMETRY_TOKEN"];
const intervalMs = 500;

if (endpoint && token) {
  const send = async () => {
    try {
      const memory = process.memoryUsage();
      await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", "x-resource-token": token },
        body: JSON.stringify({
          pid: process.pid,
          heapUsedBytes: memory.heapUsed,
          heapTotalBytes: memory.heapTotal,
          externalBytes: memory.external,
          arrayBuffersBytes: memory.arrayBuffers,
        }),
        signal: AbortSignal.timeout(1_000),
      });
    } catch {
      // Parent process teardown closes the server; telemetry must never fail work.
    }
  };
  const timer = setInterval(send, intervalMs);
  timer.unref();
  void send();
}
