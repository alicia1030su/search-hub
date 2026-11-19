import { useEffect, useState, type FormEvent } from "react";
import { ExternalLink, Pencil, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import { api, toApiError, type ApiError } from "../../lib/api";
import { formatDateTime, formatMs, formatNumber } from "../../lib/format";
import { t } from "../../lib/i18n";
import { codeAdvice, codeLabel } from "../../lib/batch-labels";
import { redactKeyId, requestsLabel } from "../../lib/batch-classify";
import type { ApiKeySummary, KeyInput, ProviderRuntimeSnapshot, ProviderTestResult } from "../../lib/types";
import { ConfirmDialog, Dialog } from "../../components/overlay";
import { Table, TBody, TD, TH, THead, TR } from "../../components/table";
import { useToast } from "../../components/toast";
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  KeyStatusBadge,
  Switch,
} from "../../components/ui";

export function TestResultDialog({
  open,
  onClose,
  title,
  result,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  result: ProviderTestResult | null;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      size="md"
      footer={
        <Button variant="outline" size="sm" onClick={onClose}>
          {t("providers.test.close")}
        </Button>
      }
    >
      {result ? (
        <div className="space-y-3">
          <Alert
            tone={result.ok ? "success" : "error"}
            title={result.ok ? t("providers.test.ok") : t("providers.test.fail")}
          >
            {result.message}
          </Alert>
          {/*
            The probe's own conclusion, when the server sends it. `requests` is
            rendered as an em dash when absent: "no request was sent" is a fact,
            and `0` would be a measurement this probe never made.
          */}
          <div className="flex flex-wrap gap-1.5">
            {result.kind ? <Badge tone="muted">{result.kind}</Badge> : null}
            {result.status ? <Badge tone={result.ok ? "success" : "warning"}>{result.status}</Badge> : null}
            {result.cause ? <Badge tone="muted">{codeLabel(result.cause)}</Badge> : null}
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div className="rounded-md border bg-muted/25 p-2.5">
              <p className="text-[11px] text-muted-foreground">{t("providers.test.latency")}</p>
              <p className="font-mono text-sm">{formatMs(result.latencyMs)}</p>
            </div>
            <div className="rounded-md border bg-muted/25 p-2.5">
              <p className="text-[11px] text-muted-foreground">{t("providers.test.resultCount")}</p>
              <p className="font-mono text-sm">
                {result.resultCount === undefined ? "—" : formatNumber(result.resultCount)}
              </p>
            </div>
            <div className="rounded-md border bg-muted/25 p-2.5">
              <p className="text-[11px] text-muted-foreground">{t("providers.batch.detail.requests")}</p>
              <p className="font-mono text-sm" data-testid="single-test-requests">
                {requestsLabel(result.requests ?? null)}
              </p>
            </div>
            <div className="rounded-md border bg-muted/25 p-2.5">
              <p className="text-[11px] text-muted-foreground">{t("providers.batch.detail.key")}</p>
              <p className="font-mono text-sm">{redactKeyId(result.keyId ?? null)}</p>
            </div>
          </div>
          {result.cause ? (
            <p className="rounded-md bg-muted/40 px-2 py-1.5 text-xs leading-relaxed text-muted-foreground">
              {codeAdvice(result.cause)}
            </p>
          ) : null}
          <div>
            <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">{t("providers.test.sample")}</p>
            {result.sample && result.sample.length > 0 ? (
              <ul className="divide-y rounded-md border">
                {result.sample.map((item, index) => (
                  <li key={`${item.url}-${index}`} className="px-3 py-2">
                    <a
                      href={item.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-flex items-center gap-1 text-sm hover:underline"
                    >
                      <span className="line-clamp-1">{item.title || item.url}</span>
                      <ExternalLink className="size-3 shrink-0 text-muted-foreground" aria-hidden />
                    </a>
                    <p className="truncate font-mono text-[10px] text-muted-foreground">{item.url}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">{t("providers.test.noSample")}</p>
            )}
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}

interface KeyFormState {
  label: string;
  key: string;
  weight: string;
  enabled: boolean;
}

const emptyKeyForm: KeyFormState = { label: "", key: "", weight: "100", enabled: true };

export function ProviderKeysPanel({
  providerId,
  providerName,
}: {
  providerId: string;
  providerName: string;
}) {
  const toast = useToast();
  const [keys, setKeys] = useState<ApiKeySummary[] | null>(null);
  const [snapshot, setSnapshot] = useState<ProviderRuntimeSnapshot | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState<ApiError | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ApiKeySummary | null>(null);
  const [form, setForm] = useState<KeyFormState>(emptyKeyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<ApiKeySummary | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [testingKeyId, setTestingKeyId] = useState<string | null>(null);
  const [togglingKeyId, setTogglingKeyId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ title: string; result: ProviderTestResult } | null>(null);

  const reload = () => setTick((value) => value + 1);

  const refreshStatus = async () => {
    setStatusLoading(true);
    setStatusError(null);
    try {
      const next = await api.providerStatus(providerId);
      setSnapshot(next);
      toast.success({ title: t("providers.keys.statusRefreshed") });
    } catch (caught) {
      setStatusError(toApiError(caught));
    } finally {
      setStatusLoading(false);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    setStatusLoading(true);
    api
      .providerStatus(providerId, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setSnapshot(data);
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setStatusError(toApiError(caught));
      })
      .finally(() => {
        if (!controller.signal.aborted) setStatusLoading(false);
      });
    return () => controller.abort();
  }, [providerId, tick]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    api
      .providerKeys(providerId, controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setKeys(data);
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setError(toApiError(caught));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [providerId, tick]);

  const openCreate = () => {
    setEditing(null);
    setForm(emptyKeyForm);
    setFormError(null);
    setFormOpen(true);
  };

  const openEdit = (key: ApiKeySummary) => {
    setEditing(key);
    setForm({ label: key.label, key: "", weight: String(key.weight), enabled: key.enabled });
    setFormError(null);
    setFormOpen(true);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setFormError(null);
    if (!form.label.trim()) {
      setFormError(t("providers.keys.labelRequired"));
      return;
    }
    if (!editing && !form.key.trim()) {
      setFormError(t("providers.keys.keyRequired"));
      return;
    }
    const weight = Number(form.weight);
    if (!Number.isInteger(weight) || weight < 1 || weight > 1000) {
      setFormError(t("providers.form.rangeError", { label: t("common.weight"), min: 1, max: 1000 }));
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        const patch: Partial<KeyInput> = { label: form.label.trim(), weight, enabled: form.enabled };
        if (form.key.trim()) patch.key = form.key.trim();
        await api.updateKey(editing.id, patch);
        toast.success({ title: t("providers.keys.updated") });
      } else {
        await api.createKey(providerId, {
          label: form.label.trim(),
          key: form.key.trim(),
          weight,
          enabled: form.enabled,
        });
        toast.success({ title: t("providers.keys.created") });
      }
      setFormOpen(false);
      reload();
    } catch (caught) {
      const apiError = toApiError(caught);
      setFormError(`${apiError.code}: ${apiError.message}`);
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setDeletePending(true);
    try {
      await api.deleteKey(deleting.id);
      toast.success({ title: t("providers.keys.deleted") });
      setDeleting(null);
      reload();
    } catch (caught) {
      const apiError = toApiError(caught);
      toast.error({ title: apiError.message, description: apiError.code });
    } finally {
      setDeletePending(false);
    }
  };

  const toggleKeyEnabled = async (key: ApiKeySummary, enabled: boolean) => {
    setTogglingKeyId(key.id);
    try {
      await api.updateKey(key.id, { enabled });
      toast.success({ title: t("providers.keys.updated") });
      reload();
    } catch (caught) {
      const apiError = toApiError(caught);
      toast.error({ title: apiError.message, description: apiError.code });
    } finally {
      setTogglingKeyId(null);
    }
  };

  const runKeyTest = async (key: ApiKeySummary) => {
    setTestingKeyId(key.id);
    try {
      const result = await api.testKey(key.id);
      setTestResult({ title: `${t("providers.keys.test")} · ${key.label}`, result });
      reload();
    } catch (caught) {
      const apiError = toApiError(caught);
      toast.error({ title: apiError.message, description: apiError.code });
    } finally {
      setTestingKeyId(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] text-muted-foreground">
          {providerName} · {t("providers.keys.count", { count: keys?.length ?? 0 })}
        </p>
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="outline" onClick={() => void refreshStatus()} disabled={statusLoading}>
            <RefreshCw className={statusLoading ? "animate-spin" : undefined} aria-hidden />
            {t("providers.list.refreshStatus")}
          </Button>
          <Button size="sm" variant="outline" onClick={reload} disabled={loading}>
            <RefreshCw className={loading ? "animate-spin" : undefined} aria-hidden />
            {t("common.refresh")}
          </Button>
          <Button size="sm" onClick={openCreate}>
            <Plus aria-hidden />
            {t("providers.keys.add")}
          </Button>
        </div>
      </div>

      {statusError ? (
        <Alert tone="warning" title={`${statusError.code}: ${statusError.message}`} />
      ) : null}

      {snapshot ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/20 px-3 py-2 text-[11px]">
          <span className="text-muted-foreground">{t("providers.keys.runtime")}</span>
          <Badge tone={snapshot.circuitOpen ? "warning" : "success"}>
            {snapshot.circuitOpen ? t("providers.list.circuitOpen") : t("providers.list.circuitClosed")}
          </Badge>
          {snapshot.circuitOpenUntil ? (
            <span className="text-muted-foreground">
              {t("providers.list.circuitOpenUntil", { time: formatDateTime(snapshot.circuitOpenUntil) })}
            </span>
          ) : null}
          <span className="text-muted-foreground">
            {t("providers.list.healthyKeys")}: {snapshot.keys.filter((key) => key.status === "healthy").length} / {snapshot.keys.length}
          </span>
        </div>
      ) : null}

      {error ? (
        <Alert
          tone="error"
          title={`${error.code}: ${error.message}`}
          action={
            <Button size="sm" variant="outline" onClick={reload}>
              {t("common.retry")}
            </Button>
          }
        />
      ) : null}

      {keys === null && loading ? (
        <div className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">
          {t("common.loading")}
        </div>
      ) : keys && keys.length === 0 ? (
        <EmptyState
          icon={Search}
          title={t("providers.keys.empty")}
          description={t("providers.keys.emptyDesc")}
          action={
            <Button size="sm" onClick={openCreate}>
              <Plus aria-hidden />
              {t("providers.keys.add")}
            </Button>
          }
        />
      ) : keys ? (
        <Table minWidth="min-w-[900px]" caption={t("providers.keys.title", { name: providerName })}>
          <THead>
            <tr>
              <TH>{t("common.label")}</TH>
              <TH>{t("providers.keys.masked")}</TH>
              <TH>{t("common.status")}</TH>
              <TH className="text-right">{t("common.weight")}</TH>
              <TH className="text-right">{t("providers.keys.inFlight")}</TH>
              <TH className="text-right">{t("providers.keys.rpm")}</TH>
              <TH className="text-right">{t("providers.keys.quotaToday")}</TH>
              <TH className="text-right">{t("providers.keys.requests")}</TH>
              <TH className="text-right">{t("providers.keys.failures")}</TH>
              <TH>{t("providers.keys.lastError")}</TH>
              <TH className="text-right">{t("common.actions")}</TH>
            </tr>
          </THead>
          <TBody>
            {keys.map((key) => (
              <TR key={key.id}>
                <TD>
                  <p className="font-medium">{key.label}</p>
                  <p className="text-[10px] text-muted-foreground">
                    {t("providers.keys.added", { time: formatDateTime(key.createdAt) })}
                  </p>
                </TD>
                <TD className="font-mono text-xs text-muted-foreground">{key.maskedKey}</TD>
                <TD>
                  <div className="flex flex-col items-start gap-1">
                    <KeyStatusBadge status={key.status} />
                    {!key.enabled ? (
                      <span className="text-[10px] text-muted-foreground">{t("common.disabled")}</span>
                    ) : null}
                    {key.cooldownUntil ? (
                      <span className="text-[10px] text-muted-foreground">
                        {t("providers.keys.cooldownUntil")} {formatDateTime(key.cooldownUntil)}
                      </span>
                    ) : null}
                  </div>
                </TD>
                <TD className="text-right font-mono tabular-nums">{key.weight}</TD>
                <TD className="text-right font-mono tabular-nums">{key.inFlight}</TD>
                <TD className="text-right font-mono tabular-nums">
                  {formatNumber(snapshot?.keys.find((item) => item.id === key.id)?.rpmUsed ?? 0)}
                </TD>
                <TD className="text-right font-mono tabular-nums">{formatNumber(key.quotaUsedToday)}</TD>
                <TD className="text-right font-mono tabular-nums">
                  {formatNumber(key.requestCount)}
                  {key.avgLatencyMs !== null ? (
                    <span className="block text-[10px] text-muted-foreground">{formatMs(key.avgLatencyMs)}</span>
                  ) : null}
                </TD>
                <TD className="text-right font-mono tabular-nums">
                  <span className={key.failureCount > 0 ? "text-destructive" : undefined}>
                    {formatNumber(key.failureCount)}
                  </span>
                  {key.consecutiveFailures > 0 ? (
                    <span className="block text-[10px] text-muted-foreground">
                      {t("providers.keys.consecutiveFailures")} {key.consecutiveFailures}
                    </span>
                  ) : null}
                </TD>
                <TD className="max-w-[220px]">
                  {key.lastErrorCode ? (
                    <div className="space-y-0.5">
                      <Badge tone="destructive">{key.lastErrorCode}</Badge>
                      {key.lastErrorMessage ? (
                        <p className="line-clamp-2 text-[10px] leading-snug text-muted-foreground">
                          {key.lastErrorMessage}
                        </p>
                      ) : null}
                    </div>
                  ) : (
                    <span className="text-[11px] text-muted-foreground">
                      {key.lastUsedAt ? formatDateTime(key.lastUsedAt) : t("common.never")}
                    </span>
                  )}
                </TD>
                <TD>
                  <div className="flex items-center justify-end gap-0.5">
                    <Switch
                      checked={key.enabled}
                      onChange={(value) => void toggleKeyEnabled(key, value)}
                      disabled={togglingKeyId === key.id}
                      label={key.enabled ? t("common.disable") : t("common.enable")}
                    />
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      title={t("providers.keys.test")}
                      aria-label={t("providers.keys.test")}
                      loading={testingKeyId === key.id}
                      onClick={() => void runKeyTest(key)}
                    >
                      {testingKeyId === key.id ? null : <RefreshCw aria-hidden />}
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      title={t("common.edit")}
                      aria-label={t("common.edit")}
                      onClick={() => openEdit(key)}
                    >
                      <Pencil aria-hidden />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      title={t("common.delete")}
                      aria-label={t("common.delete")}
                      onClick={() => setDeleting(key)}
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  </div>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      ) : null}

      <Dialog
        open={formOpen}
        onClose={() => setFormOpen(false)}
        title={editing ? t("providers.keys.editTitle") : t("providers.keys.addTitle")}
        description={editing ? t("providers.keys.keyEditHint") : t("providers.keys.weightHint")}
        size="sm"
        footer={
          <>
            <Button variant="outline" size="sm" onClick={() => setFormOpen(false)} disabled={saving}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" form="key-form" size="sm" loading={saving}>
              {saving ? t("common.saving") : t("common.save")}
            </Button>
          </>
        }
      >
        <form id="key-form" onSubmit={(event) => void submit(event)} className="space-y-3">
          {formError ? <Alert tone="error" title={formError} /> : null}
          <Field label={t("providers.keys.label")} htmlFor="key-label" required>
            <Input
              id="key-label"
              required
              maxLength={80}
              value={form.label}
              onChange={(event) => setForm((current) => ({ ...current, label: event.target.value }))}
              placeholder={t("providers.keys.labelPlaceholder")}
            />
          </Field>
          <Field
            label={t("providers.keys.key")}
            htmlFor="key-value"
            required={!editing}
            hint={editing ? t("providers.keys.keyEditHint") : t("models.form.apiKeyHint")}
          >
            <Input
              id="key-value"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={form.key}
              onChange={(event) => setForm((current) => ({ ...current, key: event.target.value }))}
              placeholder={t("providers.keys.keyPlaceholder")}
            />
          </Field>
          <Field label={t("common.weight")} htmlFor="key-weight" hint={t("providers.keys.weightHint")}>
            <Input
              id="key-weight"
              type="number"
              min={1}
              max={1000}
              value={form.weight}
              onChange={(event) => setForm((current) => ({ ...current, weight: event.target.value }))}
            />
          </Field>
          <div className="flex items-center justify-between rounded-md border bg-muted/20 px-3 py-2">
            <span className="text-xs">{t("providers.keys.enabled")}</span>
            <Switch
              checked={form.enabled}
              onChange={(value) => setForm((current) => ({ ...current, enabled: value }))}
              label={t("providers.keys.enabled")}
            />
          </div>
        </form>
      </Dialog>

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={confirmDelete}
        title={t("common.deleteConfirmTitle")}
        description={`${deleting?.label ?? ""} — ${t("providers.keys.deleteConfirm")}`}
        confirmLabel={t("common.delete")}
        loading={deletePending}
      />

      <TestResultDialog
        open={testResult !== null}
        onClose={() => setTestResult(null)}
        title={testResult?.title ?? ""}
        result={testResult?.result ?? null}
      />
    </div>
  );
}
