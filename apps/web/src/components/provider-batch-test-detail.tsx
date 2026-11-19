import { useEffect, useState } from "react";
import { api, toApiError } from "../lib/api";
import { t } from "../lib/i18n";
import { formatDateTime } from "../lib/format";
import type { BatchItem, HealthCheckResult } from "../lib/types";
import { Badge, Button, DataRow, Skeleton } from "../components/ui";
import { codeAdvice, codeLabel, groupOf, requestsLabel, stateLabel } from "./provider-batch-test-results";

/**
 * The per-source detail drawer.
 *
 * It answers "why", and it answers it from the **stored health row** rather than
 * from anything the UI computed: the batch item carries the state and the code,
 * while `keyId`, `checkedAt` and the sample rows live in `provider_health_checks`.
 * Reading them back (instead of widening the run payload) keeps the ledger small
 * and means the drawer shows exactly what was recorded, not a reconstruction.
 *
 * The key is displayed as `key_ab…9f` derived from the key **id**: there is no
 * code path in this app that could produce the secret for display, and this
 * function is the reason.
 *
 * Samples are rendered as plain text. A vendor's result title is untrusted input;
 * rendering it as HTML would turn "test a search source" into an XSS vector.
 */
export function ProviderBatchTestDetail({
  item,
  providerType,
  onRetry,
  retrying,
}: {
  item: BatchItem | null;
  providerType?: string;
  onRetry: (providerId: string) => void;
  retrying: boolean;
}) {
  const [check, setCheck] = useState<HealthCheckResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const checkId = item?.checkId ?? null;
  const providerId = item?.providerId ?? null;

  useEffect(() => {
    setCheck(null);
    setError(null);
    if (!providerId || !checkId) return;
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    void api
      .healthHistory(providerId, controller.signal)
      .then((data) => {
        if (cancelled) return;
        // The history endpoint returns the newest rows; the exact one we want is
        // identified by id, never by position.
        setCheck(data.checks.find((row) => row.id === checkId) ?? null);
      })
      .catch((failure) => {
        if (cancelled) return;
        setError(toApiError(failure).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [providerId, checkId]);

  if (!item) return null;

  const group = groupOf(item);
  const samples = (check?.sample ?? []).slice(0, 3);
  const checkedAt = check?.checkedAt ?? null;
  const requests = check?.requests ?? item.requests;

  return (
    <div className="space-y-4" data-testid="batch-detail">
      <div className="space-y-1">
        <p className="text-sm font-semibold" data-testid="batch-detail-name">
          {item.providerName || item.providerId}
        </p>
        {providerType ? <p className="text-xs text-muted-foreground">{providerType}</p> : null}
        <div className="flex flex-wrap gap-1 pt-1">
          <span data-testid="batch-detail-state">
            <Badge tone={group === "failed" ? "destructive" : group === "restricted" ? "warning" : "muted"}>
              {stateLabel(item)}
            </Badge>
          </span>
          <Badge tone="muted">{codeLabel(item.code)}</Badge>
        </div>
      </div>

      <dl className="divide-y rounded-lg border text-sm">
        <DataRow
          label={t("providers.batch.detail.key")}
          value={<span data-testid="batch-detail-key">{redactKeyId(check?.keyId ?? null)}</span>}
        />
        <DataRow
          label={t("providers.batch.detail.checkedAt")}
          value={
            loading && !check ? <Skeleton className="h-3 w-32" /> : <span data-testid="batch-detail-checked">{formatDateTime(checkedAt)}</span>
          }
        />
        <DataRow
          label={t("providers.batch.detail.latency")}
          value={item.latencyMs === null ? "—" : `${item.latencyMs} ms`}
        />
        <DataRow
          label={t("providers.batch.detail.results")}
          value={item.resultCount === null ? "—" : String(item.resultCount)}
        />
        <DataRow
          label={t("providers.batch.detail.requests")}
          value={
            <span
              data-testid="batch-detail-requests"
              title={requests === null ? t("providers.batch.requestsUnknownHint") : undefined}
            >
              {requestsLabel(requests)}
            </span>
          }
        />
        <DataRow label={t("providers.batch.detail.code")} value={codeLabel(item.code)} />
        <DataRow label={t("providers.batch.detail.advice")} value={codeAdvice(item.code) || "—"} />
        <DataRow
          label={t("providers.batch.detail.healthRow")}
          value={
            item.checkId === null ? (
              <span data-testid="batch-detail-health">{t("providers.batch.detail.notCommitted")}</span>
            ) : (
              <span data-testid="batch-detail-health">{t("providers.batch.detail.committed")}</span>
            )
          }
        />
      </dl>

      {item.reason ? (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">{t("providers.batch.detail.reason")}</p>
          <p
            className="max-h-32 overflow-y-auto rounded-md bg-muted/40 px-2 py-1.5 text-xs leading-relaxed"
            data-testid="batch-detail-reason"
          >
            {item.reason}
          </p>
        </div>
      ) : null}

      {error ? <p className="text-xs text-destructive">{error}</p> : null}

      <div className="space-y-1">
        <p className="text-xs font-medium text-muted-foreground">{t("providers.batch.detail.samples")}</p>
        {loading && !check ? (
          <Skeleton className="h-12" />
        ) : samples.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="batch-detail-no-samples">
            {t("providers.batch.detail.noSamples")}
          </p>
        ) : (
          <ul className="space-y-1" data-testid="batch-detail-samples">
            {samples.map((sample, index) => (
              <li key={`${sample.url}-${index}`} className="rounded-md border px-2 py-1.5">
                {/* Plain text, never HTML: a result title is untrusted input. */}
                <span className="block truncate text-xs font-medium" title={sample.title}>
                  {sample.title}
                </span>
                <span className="block truncate text-[11px] text-muted-foreground" title={sample.url}>
                  {sample.url}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex justify-end border-t pt-3">
        <Button
          size="sm"
          variant="outline"
          loading={retrying}
          data-testid="batch-detail-retry"
          onClick={() => onRetry(item.providerId)}
        >
          {t("providers.batch.detail.retry")}
        </Button>
      </div>
    </div>
  );
}

/**
 * Renders `key_ab…9f` from a key **identifier**.
 *
 * The full id is not a secret, but a hint in the UI is only useful as a
 * disambiguator, so the middle is elided. Nothing here can reach the key
 * material: the server never sends it.
 */
export function redactKeyId(keyId: string | null): string {
  if (!keyId) return "—";
  const trimmed = keyId.trim();
  if (trimmed.length <= 8) return trimmed;
  return `${trimmed.slice(0, 6)}…${trimmed.slice(-2)}`;
}
