import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";

const PRELOAD_PATH = fileURLToPath(new URL("./node-telemetry.mjs", import.meta.url));
const MAX_BODY_BYTES = 4096;

/** Create a random loopback-only V8 telemetry receiver for owned children. */
export async function createTelemetryServer() {
  const token = randomBytes(32).toString("hex");
  const samples = new Map();
  const peaks = new Map();
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method !== "POST" || request.url !== "/sample") {
      response.writeHead(404).end("{}");
      return;
    }
    const supplied = Buffer.from(request.headers["x-resource-token"] ?? "");
    const expected = Buffer.from(token);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      response.writeHead(403).end("{}");
      return;
    }
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const fields = ["heapUsedBytes", "heapTotalBytes", "externalBytes", "arrayBuffersBytes"];
        if (!Number.isSafeInteger(value.pid) || value.pid <= 0 || fields.some((field) => !Number.isSafeInteger(value[field]) || value[field] < 0)) {
          response.writeHead(400).end("{}");
          return;
        }
        const sample = { pid: value.pid, ...Object.fromEntries(fields.map((field) => [field, value[field]])) };
        samples.set(sample.pid, sample);
        const previous = peaks.get(sample.pid);
        peaks.set(sample.pid, fields.reduce((peak, field) => ({ ...peak, [field]: Math.max(previous?.[field] ?? 0, sample[field]) }), { pid: sample.pid }));
        response.writeHead(204).end();
      } catch {
        response.writeHead(400).end("{}");
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const endpoint = `http://127.0.0.1:${address.port}/sample`;
  return {
    endpoint,
    token,
    samples,
    peaks,
    environment() {
      const preload = `--import=${pathToFileURL(PRELOAD_PATH).href}`;
      return {
        SEARCH_HUB_RESOURCE_TELEMETRY_URL: endpoint,
        SEARCH_HUB_RESOURCE_TELEMETRY_TOKEN: token,
        NODE_OPTIONS: process.env["NODE_OPTIONS"] ? `${process.env["NODE_OPTIONS"]} ${preload}` : preload,
      };
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      samples.clear();
      peaks.clear();
    },
  };
}
