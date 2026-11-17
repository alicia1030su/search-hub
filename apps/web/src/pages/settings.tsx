import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  AlertCircle,
  ArrowDownToLine,
  ArrowUpFromLine,
  FileText,
  RefreshCw,
  Save,
  ShieldAlert,
} from "lucide-react";
import { api, toApiError, type ApiError } from "../lib/api";
import {
  downloadJson,
  formatBytes,
  formatDateTime,
  formatMs,
  formatNumber,
  formatPercent,
  parseJsonObject,
  prettyJson,
  timestampSlug,
} from "../lib/format";
import { useAsyncData, useDocumentTitle } from "../lib/hooks";
import {
  freshnessLabel,
  logLevels,
  searchModeLabel,
  t,
} from "../lib/i18n";
import type { AppSettings, AuditLog, Freshness, LogEvent, SearchMode } from "../lib/types";
import { Table, TBody, TD, TH, THead, TR } from "../components/table";
import { Tabs } from "../components/tabs";
import { useToast } from "../components/toast";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Field,
  Input,
  JsonPreview,
  PageHeader,
  Select,
  Skeleton,
  Switch,
  Textarea,
} from "../components/ui";

type Tab = "general" | "logs" | "audit";

/** Matches the server default (24 hours) so an unset value shows something sane. */
const DEFAULT_CACHE_TTL_SECONDS = 86_400;


const modes: SearchMode[] = [
  "basic",
  "rrf",
  "rerank",
  "embedding",
  "embedding_rerank",
  "rerank_summary",
  "deep",
];

const freshnessOptions: Freshness[] = ["day", "week", "month", "year", "all"];

interface SettingsFormState {
  instanceName: string;
  publicBaseUrl: string;
  limit: string;
  timeoutMs: string;
  mode: SearchMode;
  language: string;
  freshness: Freshness;
  allowlist: string;
  allowHttp: boolean;
  sessionTtlHours: string;
  loginRateLimitPerMin: string;
  taskRetentionDays: string;
  logRetentionDays: string;
  cacheEnabled: boolean;
  /** Hours, 1–72. Converted to seconds on submit. */
  cacheTtlHours: string;
  logLevel: string;
}

function toForm(settings: AppSettings): SettingsFormState {
  return {
    instanceName: settings.instance.name,
    publicBaseUrl: settings.instance.publicBaseUrl,
    limit: String(settings.defaults.limit),
    timeoutMs: String(settings.defaults.timeoutMs),
    mode: settings.defaults.mode,
    language: settings.defaults.language,
    freshness: settings.defaults.freshness,
    allowlist: settings.security.privateHostAllowlist.join("\n"),
    allowHttp: settings.security.allowHttp,
    sessionTtlHours: String(settings.security.sessionTtlHours),
    loginRateLimitPerMin: String(settings.security.loginRateLimitPerMin),
    taskRetentionDays: String(settings.retention.taskRetentionDays),
    logRetentionDays: String(settings.retention.logRetentionDays),
    cacheEnabled: settings.cache.enabled,
    cacheTtlHours: String(Math.round((settings.cache.ttlSeconds || DEFAULT_CACHE_TTL_SECONDS) / 3600)),
    logLevel: settings.logging.level,
  };
}

export function SettingsPage() {
  useDocumentTitle(t("settings.title"));
  const toast = useToast();
  const [tab, setTab] = useState<Tab>("general");
  const settings = useAsyncData((signal) => api.settings(signal), []);
  const [form, setForm] = useState<SettingsFormState | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<ApiError | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const cache = useAsyncData((signal) => api.cacheStats(signal), []);
  const [busy, setBusy] = useState(false);
  const [cacheActionHint, setCacheActionHint] = useState<string | null>(null);

  useEffect(() => {
    if (settings.data) setForm(toForm(settings.data));
  }, [settings.data]);

  const runCacheAction = async (action: "sweep" | "clear") => {
    // Clearing is irreversible and removes every cached response for every
    // caller, so it needs an explicit confirmation — not just a red button.
    if (action === "clear") {
      const confirmed = window.confirm(
        t("settings.cache.clearConfirm"),
      );
      if (!confirmed) return;
    }
    setBusy(true);
    setCacheActionHint(null);
    try {
      const result = action === "clear" ? await api.clearCache() : await api.sweepCache();
      setCacheActionHint(
        t(action === "clear" ? "settings.cache.cleared" : "settings.cache.swept", { count: result.removed }),
      );
      cache.reload();
      toast.success({
        title: t(action === "clear" ? "settings.cache.clearedTitle" : "settings.cache.sweptTitle"),
      });
    } catch (caught) {
      setCacheActionHint(toApiError(caught).message ?? String(caught));
    } finally {
      setBusy(false);
    }
  };

  const update = <K extends keyof SettingsFormState>(key: K, value: SettingsFormState[K]) => {
    setForm((current) => (current ? { ...current, [key]: value } : current));
  };

  const save = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!form) return;
    setSaveError(null);
    const problems: string[] = [];
    const limit = Number(form.limit);
    const timeoutMs = Number(form.timeoutMs);
    const sessionTtlHours = Number(form.sessionTtlHours);
    const loginRateLimitPerMin = Number(form.loginRateLimitPerMin);
    const taskRetentionDays = Number(form.taskRetentionDays);
    const logRetentionDays = Number(form.logRetentionDays);
    const cacheTtlHours = Number(form.cacheTtlHours);

    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      problems.push(t("providers.form.rangeError", { label: t("settings.defaults.limit"), min: 1, max: 100 }));
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) {
      problems.push(t("providers.form.rangeError", { label: t("settings.defaults.timeout"), min: 1000, max: 120000 }));
    }
    if (!Number.isInteger(sessionTtlHours) || sessionTtlHours < 1 || sessionTtlHours > 720) {
      problems.push(t("providers.form.rangeError", { label: t("settings.security.sessionTtl"), min: 1, max: 720 }));
    }
    if (!Number.isInteger(loginRateLimitPerMin) || loginRateLimitPerMin < 1 || loginRateLimitPerMin > 100) {
      problems.push(
        t("providers.form.rangeError", { label: t("settings.security.loginRateLimit"), min: 1, max: 100 }),
      );
    }
    if (!Number.isInteger(taskRetentionDays) || taskRetentionDays < 1 || taskRetentionDays > 365) {
      problems.push(
        t("providers.form.rangeError", { label: t("settings.retention.taskDays"), min: 1, max: 365 }),
      );
    }
    if (!Number.isInteger(logRetentionDays) || logRetentionDays < 1 || logRetentionDays > 365) {
      problems.push(
        t("providers.form.rangeError", { label: t("settings.retention.logDays"), min: 1, max: 365 }),
      );
    }
    // 1–72 hours. Enforced again server-side; this check only shortens the
    // feedback loop, it is not the authority.
    if (!Number.isInteger(cacheTtlHours) || cacheTtlHours < 1 || cacheTtlHours > 72) {
      problems.push(t("providers.form.rangeError", { label: t("settings.cache.ttl"), min: 1, max: 72 }));
    }

    setErrors(problems);
    if (problems.length > 0) return;

    setSaving(true);
    try {
      const payload: Partial<AppSettings> = {
        instance: { name: form.instanceName.trim() || "Search Hub", publicBaseUrl: form.publicBaseUrl.trim() },
        defaults: {
          limit,
          timeoutMs,
          mode: form.mode,
          language: form.language.trim(),
          freshness: form.freshness,
        },
        security: {
          privateHostAllowlist: form.allowlist
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean),
          allowHttp: form.allowHttp,
          sessionTtlHours,
          loginRateLimitPerMin,
        },
        retention: { taskRetentionDays, logRetentionDays },
        cache: { enabled: form.cacheEnabled, ttlSeconds: cacheTtlHours * 3600 },
        logging: { level: form.logLevel },
      };
      const updated = await api.updateSettings(payload);
      setForm(toForm(updated));
      settings.reload();
      window.dispatchEvent(new CustomEvent("sh:settings-updated"));
      toast.success({ title: t("settings.saved") });
    } catch (caught) {
      setSaveError(toApiError(caught));
    } finally {
      setSaving(false);
    }
  };

  const exportConfig = async () => {
    setExporting(true);
    try {
      const config = await api.exportConfig();
      downloadJson(`search-hub-config-${timestampSlug()}.json`, config);
      toast.success({ title: t("settings.config.exported") });
    } catch (caught) {
      const apiError = toApiError(caught);
      toast.error({ title: apiError.message, description: apiError.code });
    } finally {
      setExporting(false);
    }
  };

  const importConfig = async (file: File) => {
    setImportError(null);
    setImporting(true);
    try {
      const text = await file.text();
      const parsed = parseJsonObject(text);
      if (!parsed.ok || !parsed.value) {
        setImportError(t("settings.config.importInvalid"));
        return;
      }
      await api.importConfig(parsed.value);
      window.dispatchEvent(new CustomEvent("sh:settings-updated"));
      toast.success({ title: t("settings.config.imported") });
      settings.reload();
    } catch (caught) {
      const apiError = toApiError(caught);
      toast.error({ title: apiError.message, description: apiError.code });
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title={t("settings.title")}
        description={t("settings.subtitle")}
        actions={
          <Button variant="outline" size="sm" onClick={settings.reload} disabled={settings.loading}>
            <RefreshCw className={settings.loading ? "animate-spin" : undefined} aria-hidden />
            {t("common.refresh")}
          </Button>
        }
      />

      <Tabs
        items={[
          { value: "general", label: t("settings.tabs.general") },
          { value: "logs", label: t("settings.tabs.logs") },
          { value: "audit", label: t("settings.tabs.audit") },
        ]}
        value={tab}
        onChange={setTab}
        ariaLabel={t("settings.title")}
      />

      {settings.error ? (
        <Alert
          tone="error"
          title={t("states.errorTitle")}
          action={
            <Button size="sm" variant="outline" onClick={settings.reload}>
              {t("common.retry")}
            </Button>
          }
        >
          <p className="font-mono">{settings.error.code}</p>
          <p>{settings.error.message}</p>
        </Alert>
      ) : null}

      {tab === "general" ? (
        settings.loading && !settings.data ? (
          <div className="space-y-4">
            <Skeleton className="h-64" />
            <Skeleton className="h-64" />
          </div>
        ) : form ? (
          <form onSubmit={(event) => void save(event)} className="space-y-4">
            {saveError ? (
              <Alert tone="error" title={`${saveError.code}: ${saveError.message}`}>
                {saveError.details ? <JsonPreview value={saveError.details} /> : null}
              </Alert>
            ) : null}
            {errors.length > 0 ? (
              <Alert tone="warning" title={t("settings.formInvalid")}>
                <ul className="list-disc pl-4">
                  {errors.map((message) => (
                    <li key={message}>{message}</li>
                  ))}
                </ul>
              </Alert>
            ) : null}

            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader>
                  <div>
                    <CardTitle>{t("settings.instance.title")}</CardTitle>
                    <CardDescription>
                      {t("settings.instance.initializedAt")}:{" "}
                      {settings.data?.initializedAt ? formatDateTime(settings.data.initializedAt) : t("settings.notInitialized")}
                    </CardDescription>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <Field label={t("settings.instance.name")} htmlFor="settings-name">
                    <Input
                      id="settings-name"
                      maxLength={80}
                      value={form.instanceName}
                      onChange={(event) => update("instanceName", event.target.value)}
                    />
                  </Field>
                  <Field
                    label={t("settings.instance.publicBaseUrl")}
                    htmlFor="settings-base-url"
                    hint={t("settings.instance.publicBaseUrlHint")}
                  >
                    <Input
                      id="settings-base-url"
                      maxLength={500}
                      value={form.publicBaseUrl}
                      onChange={(event) => update("publicBaseUrl", event.target.value)}
                      placeholder="https://search.example.com"
                      spellCheck={false}
                    />
                  </Field>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <div>
                    <CardTitle>{t("settings.defaults.title")}</CardTitle>
                    <CardDescription>{t("lab.modeHint")}</CardDescription>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <Field label={t("settings.defaults.limit")} htmlFor="settings-limit">
                      <Input
                        id="settings-limit"
                        type="number"
                        min={1}
                        max={100}
                        value={form.limit}
                        onChange={(event) => update("limit", event.target.value)}
                      />
                    </Field>
                    <Field label={t("settings.defaults.timeout")} htmlFor="settings-timeout">
                      <Input
                        id="settings-timeout"
                        type="number"
                        min={1000}
                        max={120000}
                        value={form.timeoutMs}
                        onChange={(event) => update("timeoutMs", event.target.value)}
                      />
                    </Field>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label={t("settings.defaults.mode")} htmlFor="settings-mode">
                      <Select
                        id="settings-mode"
                        value={form.mode}
                        onChange={(event) => update("mode", event.target.value as SearchMode)}
                      >
                        {modes.map((mode) => (
                          <option key={mode} value={mode}>
                            {searchModeLabel(mode)}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label={t("settings.defaults.freshness")} htmlFor="settings-freshness">
                      <Select
                        id="settings-freshness"
                        value={form.freshness}
                        onChange={(event) => update("freshness", event.target.value as Freshness)}
                      >
                        {freshnessOptions.map((freshness) => (
                          <option key={freshness} value={freshness}>
                            {freshnessLabel(freshness)}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </div>
                  <Field label={t("settings.defaults.language")} htmlFor="settings-language">
                    <Input
                      id="settings-language"
                      maxLength={24}
                      value={form.language}
                      onChange={(event) => update("language", event.target.value)}
                      placeholder="zh"
                    />
                  </Field>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <div>
                    <CardTitle className="flex items-center gap-1.5">
                      <ShieldAlert className="size-4" aria-hidden />
                      {t("settings.security.title")}
                    </CardTitle>
                    <CardDescription>{t("settings.securityHint")}</CardDescription>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <Field
                    label={t("settings.security.allowlist")}
                    htmlFor="settings-allowlist"
                    hint={t("settings.security.allowlistHint")}
                  >
                    <Textarea
                      id="settings-allowlist"
                      rows={4}
                      className="font-mono text-[12px]"
                      value={form.allowlist}
                      onChange={(event) => update("allowlist", event.target.value)}
                      placeholder={"internal-search.example.com\n10.0.0.12"}
                    />
                  </Field>
                  <div className="flex items-center justify-between rounded-md border bg-muted/20 px-3 py-2">
                    <div>
                      <p className="text-xs font-medium">{t("settings.security.allowHttp")}</p>
                      <p className="text-[10px] text-muted-foreground">{t("settings.security.allowHttpHint")}</p>
                    </div>
                    <Switch
                      checked={form.allowHttp}
                      onChange={(value) => update("allowHttp", value)}
                      label={t("settings.security.allowHttp")}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label={t("settings.security.sessionTtl")} htmlFor="settings-session">
                      <Input
                        id="settings-session"
                        type="number"
                        min={1}
                        max={720}
                        value={form.sessionTtlHours}
                        onChange={(event) => update("sessionTtlHours", event.target.value)}
                      />
                    </Field>
                    <Field label={t("settings.security.loginRateLimit")} htmlFor="settings-login-rate">
                      <Input
                        id="settings-login-rate"
                        type="number"
                        min={1}
                        max={100}
                        value={form.loginRateLimitPerMin}
                        onChange={(event) => update("loginRateLimitPerMin", event.target.value)}
                      />
                    </Field>
                  </div>
                </CardContent>
              </Card>

              <div className="space-y-4">
                <Card>
                  <CardHeader>
                    <div>
                      <CardTitle>{t("settings.retention.title")}</CardTitle>
                      <CardDescription>{t("settings.retentionHint")}</CardDescription>
                    </div>
                  </CardHeader>
                  <CardContent className="grid grid-cols-2 gap-3">
                    <Field label={t("settings.retention.taskDays")} htmlFor="settings-task-retention">
                      <Input
                        id="settings-task-retention"
                        type="number"
                        min={1}
                        max={365}
                        value={form.taskRetentionDays}
                        onChange={(event) => update("taskRetentionDays", event.target.value)}
                      />
                    </Field>
                    <Field label={t("settings.retention.logDays")} htmlFor="settings-log-retention">
                      <Input
                        id="settings-log-retention"
                        type="number"
                        min={1}
                        max={365}
                        value={form.logRetentionDays}
                        onChange={(event) => update("logRetentionDays", event.target.value)}
                      />
                    </Field>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <div>
                      <CardTitle>{t("settings.cache.title")}</CardTitle>
                      <CardDescription>{t("settings.cache.hint")}</CardDescription>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex items-center justify-between rounded-md border bg-muted/20 px-3 py-2">
                      <span className="text-xs">{t("settings.cache.enabled")}</span>
                      <Switch
                        checked={form.cacheEnabled}
                        onChange={(value) => update("cacheEnabled", value)}
                        label={t("settings.cache.enabled")}
                      />
                    </div>
                    <Field
                      label={t("settings.cache.ttlHours")}
                      hint={t("settings.cache.ttlHint")}
                      htmlFor="settings-cache-ttl"
                    >
                      <Input
                        id="settings-cache-ttl"
                        type="number"
                        min={1}
                        max={72}
                        step={1}
                        value={form.cacheTtlHours}
                        onChange={(event) => update("cacheTtlHours", event.target.value)}
                      />
                    </Field>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <div>
                      <CardTitle>{t("settings.cache.statsTitle")}</CardTitle>
                      <CardDescription>{t("settings.cache.statsHint")}</CardDescription>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <dl className="grid grid-cols-2 gap-3 text-xs">
                      <div className="rounded-md border bg-muted/20 px-3 py-2">
                        <dt className="text-muted-foreground">{t("settings.cache.entries")}</dt>
                        <dd className="mt-1 text-base font-medium">
                          {cache.data ? cache.data.entries.toLocaleString() : "—"}
                          <span className="ml-1 text-xs font-normal text-muted-foreground">
                            / {cache.data ? cache.data.maxEntries.toLocaleString() : "—"}
                          </span>
                        </dd>
                      </div>
                      <div className="rounded-md border bg-muted/20 px-3 py-2">
                        <dt className="text-muted-foreground">{t("settings.cache.bytes")}</dt>
                        <dd className="mt-1 text-base font-medium">
                          {cache.data ? formatBytes(cache.data.bytes) : "—"}
                          <span className="ml-1 text-xs font-normal text-muted-foreground">
                            / {cache.data ? formatBytes(cache.data.maxBytes) : "—"}
                          </span>
                        </dd>
                      </div>
                      <div className="rounded-md border bg-muted/20 px-3 py-2">
                        <dt className="text-muted-foreground">{t("settings.cache.hitRate24h")}</dt>
                        <dd className="mt-1 text-base font-medium">
                          {cache.data?.hitRate24h === null || cache.data === null
                            ? t("settings.cache.noData")
                            : formatPercent(cache.data.hitRate24h)}
                        </dd>
                        <dd className="text-[11px] text-muted-foreground">
                          {cache.data
                            ? t("settings.cache.hitRateDetail", {
                                hits: cache.data.hits24h,
                                misses: cache.data.misses24h,
                              })
                            : ""}
                        </dd>
                      </div>
                      <div className="rounded-md border bg-muted/20 px-3 py-2">
                        <dt className="text-muted-foreground">{t("settings.cache.hitRateAll")}</dt>
                        <dd className="mt-1 text-base font-medium">
                          {cache.data?.hitRate === null || cache.data === null
                            ? t("settings.cache.noData")
                            : formatPercent(cache.data.hitRate)}
                        </dd>
                        <dd className="text-[11px] text-muted-foreground">
                          {cache.data
                            ? t("settings.cache.hitRateDetail", {
                                hits: cache.data.hits,
                                misses: cache.data.misses,
                              })
                            : ""}
                        </dd>
                      </div>
                      <div className="rounded-md border bg-muted/20 px-3 py-2">
                        <dt className="text-muted-foreground">{t("settings.cache.expiredRemoved")}</dt>
                        <dd className="mt-1 text-base font-medium">
                          {cache.data ? cache.data.expiredRemoved.toLocaleString() : "—"}
                        </dd>
                      </div>
                      <div className="rounded-md border bg-muted/20 px-3 py-2">
                        <dt className="text-muted-foreground">{t("settings.cache.evicted")}</dt>
                        <dd className="mt-1 text-base font-medium">
                          {cache.data ? cache.data.evicted.toLocaleString() : "—"}
                        </dd>
                      </div>
                      <div className="col-span-2 rounded-md border bg-muted/20 px-3 py-2">
                        <dt className="text-muted-foreground">{t("settings.cache.lastSweep")}</dt>
                        <dd className="mt-1 text-sm">
                          {cache.data?.lastSweepAt
                            ? new Date(cache.data.lastSweepAt).toLocaleString()
                            : t("settings.cache.noData")}
                        </dd>
                      </div>
                    </dl>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => void runCacheAction("sweep")}
                      >
                        {t("settings.cache.sweep")}
                      </Button>
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        disabled={busy}
                        onClick={() => void runCacheAction("clear")}
                      >
                        {t("settings.cache.clear")}
                      </Button>
                    </div>
                    {cacheActionHint ? (
                      <p className="text-xs text-muted-foreground">{cacheActionHint}</p>
                    ) : null}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <div>
                      <CardTitle>{t("settings.logging.title")}</CardTitle>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <Field label={t("settings.logging.level")} htmlFor="settings-log-level">
                      <Select
                        id="settings-log-level"
                        value={form.logLevel}
                        onChange={(event) => update("logLevel", event.target.value)}
                      >
                        {logLevels.map((level) => (
                          <option key={level} value={level}>
                            {level}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </CardContent>
                </Card>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-3">
              <Button type="submit" size="sm" loading={saving}>
                <Save aria-hidden />
                {saving ? t("settings.saving") : t("settings.save")}
              </Button>
              {settings.data ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setForm(toForm(settings.data as AppSettings))}
                >
                  {t("common.cancel")}
                </Button>
              ) : null}
              <span className="ml-auto text-[11px] text-muted-foreground">
                {settings.data?.initializedAt
                  ? `${t("settings.instance.initializedAt")}: ${formatDateTime(settings.data.initializedAt)}`
                  : t("settings.notInitialized")}
              </span>
            </div>
          </form>
        ) : null
      ) : null}

      {tab === "general" ? (
        <Card>
          <CardHeader>
            <div>
              <CardTitle className="flex items-center gap-1.5">
                <FileText className="size-4" aria-hidden />
                {t("settings.config.title")}
              </CardTitle>
              <CardDescription>{t("settings.config.desc")}</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" loading={exporting} onClick={() => void exportConfig()}>
                <ArrowDownToLine aria-hidden />
                {t("settings.config.export")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                loading={importing}
                onClick={() => fileInput.current?.click()}
              >
                <ArrowUpFromLine aria-hidden />
                {t("settings.config.import")}
              </Button>
              <input
                ref={fileInput}
                type="file"
                accept="application/json,.json"
                className="sr-only"
                aria-label={t("settings.config.import")}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) void importConfig(file);
                }}
              />
              <span className="text-[11px] text-muted-foreground">{t("settings.config.importHint")}</span>
            </div>
            {importError ? <Alert tone="error" title={importError} /> : null}
          </CardContent>
        </Card>
      ) : tab === "logs" ? (
        <LogsPanel />
      ) : (
        <AuditPanel />
      )}
    </div>
  );
}

function LogsPanel() {
  useDocumentTitle(t("settings.logs.title"));
  const [offset, setOffset] = useState(0);
  const pageSize = 100;
  const logs = useAsyncData(
    (signal) => api.logs({ limit: pageSize, offset }, signal),
    [offset],
  );

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>{t("settings.logs.title")}</CardTitle>
          <CardDescription>{t("settings.logs.desc")}</CardDescription>
        </div>
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="outline" onClick={logs.reload} disabled={logs.loading}>
            <RefreshCw className={logs.loading ? "animate-spin" : undefined} aria-hidden />
            {t("settings.logs.refresh")}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {logs.error ? (
          <Alert
            tone="error"
            title={`${logs.error.code}: ${logs.error.message}`}
            action={<Button size="sm" variant="outline" onClick={logs.reload}>{t("common.retry")}</Button>}
          />
        ) : null}
        {logs.loading && !logs.data ? (
          <Skeleton className="h-48" />
        ) : logs.data && logs.data.events.length === 0 ? (
          <EmptyState icon={FileText} title={t("settings.logs.empty")} />
        ) : logs.data ? (
          <>
            <Table minWidth="min-w-[820px]" caption={t("settings.logs.title")}>
              <THead>
                <tr>
                  <TH>{t("settings.logs.task")}</TH>
                  <TH>{t("settings.logs.provider")}</TH>
                  <TH>{t("settings.logs.ok")}</TH>
                  <TH className="text-right">{t("settings.logs.latency")}</TH>
                  <TH className="text-right">{t("settings.logs.results")}</TH>
                  <TH>{t("settings.logs.error")}</TH>
                  <TH>{t("common.time")}</TH>
                </tr>
              </THead>
              <TBody>
                {logs.data.events.map((event: LogEvent) => (
                  <TR key={event.id}>
                    <TD className="font-mono text-[10px] text-muted-foreground">{event.taskId ?? "—"}</TD>
                    <TD>
                      <p className="text-xs">{event.providerName ?? "—"}</p>
                      <p className="font-mono text-[10px] text-muted-foreground">{event.providerId ?? ""}</p>
                    </TD>
                    <TD>
                      <Badge tone={event.ok ? "success" : "destructive"}>
                        {event.ok ? t("common.success") : t("common.failed")}
                      </Badge>
                    </TD>
                    <TD className="text-right font-mono text-xs">{formatMs(event.latencyMs)}</TD>
                    <TD className="text-right font-mono text-xs">{formatNumber(event.resultCount)}</TD>
                    <TD className="max-w-[260px]">
                      {event.errorCode ? (
                        <div>
                          <Badge tone="destructive">{event.errorCode}</Badge>
                          {event.errorMessage ? (
                            <p className="mt-0.5 line-clamp-2 text-[10px] text-muted-foreground">
                              {event.errorMessage}
                            </p>
                          ) : null}
                        </div>
                      ) : (
                        <span className="text-[11px] text-muted-foreground">—</span>
                      )}
                    </TD>
                    <TD className="whitespace-nowrap text-[11px] text-muted-foreground">
                      {formatDateTime(event.createdAt)}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-muted-foreground">
                {logs.data.events.length} {t("common.records")}
              </span>
              <div className="flex gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={offset === 0 || logs.loading}
                  onClick={() => setOffset(Math.max(0, offset - pageSize))}
                >
                  {t("common.previous")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={logs.data.events.length < pageSize || logs.loading}
                  onClick={() => setOffset(offset + pageSize)}
                >
                  {t("common.next")}
                </Button>
              </div>
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

function AuditPanel() {
  useDocumentTitle(t("settings.audit.title"));
  const [limit, setLimit] = useState(100);
  const audit = useAsyncData((signal) => api.audit({ limit }, signal), [limit]);

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>{t("settings.audit.title")}</CardTitle>
          <CardDescription>{t("settings.audit.desc")}</CardDescription>
        </div>
        <div className="flex items-center gap-1.5">
          <Select
            value={String(limit)}
            onChange={(event) => setLimit(Number(event.target.value))}
            className="h-8 w-24 text-xs"
            aria-label={t("common.limit")}
          >
            {[50, 100, 200, 500].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </Select>
          <Button size="sm" variant="outline" onClick={audit.reload} disabled={audit.loading}>
            <RefreshCw className={audit.loading ? "animate-spin" : undefined} aria-hidden />
            {t("settings.audit.refresh")}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {audit.error ? (
          <Alert
            tone="error"
            title={`${audit.error.code}: ${audit.error.message}`}
            action={<Button size="sm" variant="outline" onClick={audit.reload}>{t("common.retry")}</Button>}
          />
        ) : null}
        {audit.loading && !audit.data ? (
          <Skeleton className="h-48" />
        ) : audit.data && audit.data.logs.length === 0 ? (
          <EmptyState icon={AlertCircle} title={t("settings.audit.empty")} />
        ) : audit.data ? (
          <Table minWidth="min-w-[900px]" caption={t("settings.audit.title")}>
            <THead>
              <tr>
                <TH>{t("settings.audit.createdAt")}</TH>
                <TH>{t("settings.audit.actor")}</TH>
                <TH>{t("settings.audit.action")}</TH>
                <TH>{t("settings.audit.target")}</TH>
                <TH>{t("settings.audit.ip")}</TH>
                <TH>{t("settings.audit.detail")}</TH>
              </tr>
            </THead>
            <TBody>
              {audit.data.logs.map((log: AuditLog) => (
                <TR key={log.id}>
                  <TD className="whitespace-nowrap text-[11px] text-muted-foreground">
                    {formatDateTime(log.createdAt)}
                  </TD>
                  <TD className="text-xs">{log.actor}</TD>
                  <TD>
                    <Badge tone="outline" className="font-mono">
                      {log.action}
                    </Badge>
                  </TD>
                  <TD className="max-w-[180px] truncate font-mono text-[10px] text-muted-foreground">
                    {log.target ?? "—"}
                  </TD>
                  <TD className="font-mono text-[10px] text-muted-foreground">{log.ip ?? "—"}</TD>
                  <TD className="max-w-[280px]">
                    {log.detail === null || log.detail === undefined ? (
                      <span className="text-[11px] text-muted-foreground">—</span>
                    ) : (
                      <details>
                        <summary className="cursor-pointer text-[10px] text-muted-foreground hover:text-foreground">
                          {typeof log.detail === "string" ? log.detail.slice(0, 60) : prettyJson(log.detail).slice(0, 60)}
                        </summary>
                        <JsonPreview value={log.detail} className="mt-1 max-h-40" />
                      </details>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : null}
      </CardContent>
    </Card>
  );
}
