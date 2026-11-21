import type { ParsedCliArgs } from "../args.js";
import { HttpClient, ensureCompatible, requireToken } from "../client/http.js";
import { diag, table, writeJson, writeText, type OutputFormat } from "../output/index.js";
import type { ProvidersResponse } from "../types.js";

export async function runSources(
  args: ParsedCliArgs,
  client: HttpClient,
  token: string | undefined,
  format: OutputFormat,
): Promise<number> {
  requireToken(token);
  await ensureCompatible(client);
  const response = await client.request<ProvidersResponse>("/api/providers");
  const providers = args.values["enabled"] === true
    ? response.providers.filter((provider) => provider.enabled)
    : response.providers;
  const output = { ...response, providers };

  if (format === "json") {
    writeJson(output);
    return 0;
  }
  if (providers.length === 0) {
    writeText("No search sources configured.");
    return 0;
  }
  const status = new Map(response.status.map((item) => [item.providerId, item]));
  writeText(
    table(
      ["ID", "Name", "Type", "Enabled", "Keys", "Ready", "Healthy", "Circuit"],
      providers.map((provider) => {
        const runtime = status.get(provider.id);
        return [
          provider.id,
          provider.name,
          provider.type,
          provider.enabled,
          `${provider.availableKeyCount ?? provider.healthyKeyCount}/${provider.keyCount}`,
          provider.ready,
          runtime?.healthy ?? false,
          runtime?.circuitOpen ?? provider.circuitOpen,
        ];
      }),
    ),
  );
  const notReady = providers.filter((provider) => !provider.ready);
  if (notReady.length > 0) diag(`${notReady.length} source(s) are not ready; no credentials are displayed.`);
  return 0;
}
