import { useMemo, useState, type FormEvent } from "react";
import { AlertTriangle, FileJson, Loader2 } from "lucide-react";
import { api, toApiError, type ApiError } from "../../lib/api";
import { parseJsonObject, prettyJson } from "../../lib/format";
import { keyStrategyLabels, freshnessLabels, providerAuthLabels, t, verificationLabels, implementationLabels } from "../../lib/i18n";
import type {
  Freshness,
  GenericProviderConfig,
  KeyStrategy,
  ProviderCatalogEntry,
  ProviderInput,
  ProviderSummary,
} from "../../lib/types";
import { Sheet } from "../../components/overlay";
import {
  Alert,
  Badge,
  Button,
  Field,
  Input,
  JsonPreview,
  Select,
  Switch,
  Textarea,
} from "../../components/ui";

const keyStrategies: KeyStrategy[] = ["round_robin", "random", "weighted_random", "least_used", "failover"];
const freshnessOptions: Array<Freshness | ""> = ["", "day", "week", "month", "year", "all"];


const SAFE_PATH = /^[A-Za-z0-9_\-.[\]]{1,120}$/;

/** Mirrors packages/providers validateGenericConfig so a bad config never saves. */
function validateGenericLocal(config: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const method = config["method"];
  if (method !== undefined && method !== "GET" && method !== "POST") {
    problems.push(t("providers.form.genericMethod"));
  }
  const path = config["path"];
  if (path !== undefined && (typeof path !== "string" || !path.startsWith("/"))) {
    problems.push(t("providers.form.genericPath"));
  }
  for (const field of ["headers", "query"] as const) {
    const value = config[field];
    if (value === undefined) continue;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      problems.push(t("providers.form.genericObject", { field }));
      continue;
    }
    for (const entry of Object.values(value)) {
      if (typeof entry !== "string") problems.push(t("providers.form.genericStringValue", { field }));
    }
  }
  const keyInjection = config["keyInjection"];
  if (keyInjection !== undefined) {
    if (typeof keyInjection !== "object" || keyInjection === null) {
      problems.push(t("providers.form.genericKeyInjection"));
    } else {
      const injection = keyInjection as Record<string, unknown>;
      const where = injection["in"];
      const name = injection["name"];
      if (where !== "header" && where !== "query" && where !== "body") {
        problems.push(t("providers.form.genericKeyInjection"));
      }
      if (typeof name !== "string" || !name) {
        problems.push(t("providers.form.genericKeyInjection"));
      }
    }
  }
  const resultsPath = config["resultsPath"];
  if (resultsPath !== undefined && (typeof resultsPath !== "string" || !SAFE_PATH.test(resultsPath))) {
    problems.push(t("providers.form.genericResultsPath"));
  }
  const mapping = config["mapping"];
  if (mapping !== undefined) {
    if (typeof mapping !== "object" || mapping === null || Array.isArray(mapping)) {
      problems.push(t("providers.form.genericMapping"));
    } else {
      for (const [field, value] of Object.entries(mapping)) {
        if (typeof value !== "string" || !value || !SAFE_PATH.test(value)) {
          problems.push(t("providers.form.genericMappingValue", { field }));
        }
      }
    }
  }
  return problems;
}

const GENERIC_TEMPLATE: GenericProviderConfig = {
  method: "GET",
  path: "/search",
  headers: { Accept: "application/json" },
  query: { q: "{{query}}", limit: "{{limit}}", language: "{{language}}" },
  keyInjection: { in: "header", name: "Authorization", prefix: "Bearer " },
  resultsPath: "results",
  mapping: {
    title: "title",
    url: "link",
    snippet: "snippet",
    publishedAt: "date",
    score: "score",
  },
};

interface FormState {
  name: string;
  type: string;
  enabled: boolean;
  baseUrl: string;
  timeoutMs: string;
  maxConcurrency: string;
  priority: string;
  weight: string;
  maxRetries: string;
  language: string;
  freshness: string;
  resultsPerPage: string;
  rpmLimit: string;
  dailyQuota: string;
  keyStrategy: KeyStrategy;
  cooldownMs: string;
  breakerThreshold: string;
  breakerCooldownMs: string;
  config: string;
}

function toState(provider: ProviderSummary | null, preset: ProviderCatalogEntry | null): FormState {
  if (provider) {
    return {
      name: provider.name,
      type: provider.type,
      enabled: provider.enabled,
      baseUrl: provider.baseUrl ?? "",
      timeoutMs: String(provider.timeoutMs),
      maxConcurrency: String(provider.maxConcurrency),
      priority: String(provider.priority),
      weight: String(provider.weight),
      maxRetries: String(provider.maxRetries),
      language: provider.language ?? "",
      freshness: provider.freshness ?? "",
      resultsPerPage: String(provider.resultsPerPage),
      rpmLimit: String(provider.rpmLimit),
      dailyQuota: provider.dailyQuota === null ? "" : String(provider.dailyQuota),
      keyStrategy: provider.keyStrategy,
      cooldownMs: String(provider.cooldownMs),
      breakerThreshold: String(provider.breakerThreshold),
      breakerCooldownMs: String(provider.breakerCooldownMs),
      config: prettyJson(provider.config ?? {}),
    };
  }
  return {
    name: preset?.name ?? "",
    type: preset?.type ?? "",
    enabled: true,
    baseUrl: preset?.defaultBaseUrl ?? "",
    timeoutMs: "12000",
    maxConcurrency: "4",
    priority: "100",
    weight: "100",
    maxRetries: "1",
    language: "",
    freshness: "",
    resultsPerPage: "10",
    rpmLimit: "60",
    dailyQuota: "",
    keyStrategy: "round_robin",
    cooldownMs: "30000",
    breakerThreshold: "5",
    breakerCooldownMs: "60000",
    config: preset?.type === "generic-http" ? prettyJson(GENERIC_TEMPLATE) : "{}",
  };
}

function intValue(
  value: string,
  fallback: number,
  min: number,
  max: number,
  label: string,
  errors: string[],
): number {
  if (!value.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < min || parsed > max) {
    errors.push(t("providers.form.rangeError", { label, min, max }));
    return fallback;
  }
  return parsed;
}

export interface ProviderFormProps {
  open: boolean;
  onClose: () => void;
  provider: ProviderSummary | null;
  preset: ProviderCatalogEntry | null;
  catalog: ProviderCatalogEntry[];
  adapters: string[];
  onSaved: () => void;
}

export function ProviderForm({
  open,
  onClose,
  provider,
  preset,
  catalog,
  adapters,
  onSaved,
}: ProviderFormProps) {
  const [state, setState] = useState<FormState>(() => toState(provider, preset));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [configCheck, setConfigCheck] = useState<{
    ok: boolean;
    message: string;
    errors?: string[];
    remote: boolean;
  } | null>(null);
  const [validating, setValidating] = useState(false);

  const isEdit = provider !== null;
  const isGeneric = state.type === "generic-http";
  const isLegacy = state.type === "search-hub-legacy";

  const createTypes = useMemo(() => {
    const implemented = adapters.length > 0 ? new Set(adapters) : null;
    return catalog.filter((entry) => (implemented ? implemented.has(entry.type) : entry.implementation === "builtin"));
  }, [catalog, adapters]);

  const selectedCatalog = useMemo(
    () => catalog.find((entry) => entry.type === state.type) ?? null,
    [catalog, state.type],
  );

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setState((current) => ({ ...current, [key]: value }));
    setConfigCheck(null);
  };

  const configJson = parseJsonObject(state.config);

  const localConfigError = !configJson.ok
    ? configJson.error ?? t("common.invalidJson")
    : null;

  const validateConfig = async () => {
    if (!configJson.ok) {
      setConfigCheck({ ok: false, message: localConfigError ?? t("common.invalidJson"), remote: false });
      return;
    }
    setValidating(true);
    try {
      const result = await api.validateGeneric(configJson.value as unknown as GenericProviderConfig);
      setConfigCheck({
        ok: result.valid,
        message: result.valid ? t("providers.form.configValid") : t("providers.form.configInvalid"),
        errors: result.errors,
        remote: true,
      });
    } catch (caught) {
      const apiError = toApiError(caught);
      if (apiError.isNotFound) {
        setConfigCheck({
          ok: true,
          message: t("providers.form.configValidLocal"),
          remote: false,
        });
      } else {
        setConfigCheck({
          ok: false,
          message: apiError.message,
          errors: [apiError.code],
          remote: true,
        });
      }
    } finally {
      setValidating(false);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const errors: string[] = [];

    if (!state.name.trim()) errors.push(t("providers.form.nameRequired"));
    if (!state.type) errors.push(t("providers.form.type"));
    if (isGeneric && !state.baseUrl.trim()) errors.push(t("providers.form.baseUrlRequired"));
    if (state.baseUrl.trim()) {
      try {
        const url = new URL(state.baseUrl.trim());
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          errors.push(t("providers.form.baseUrlScheme"));
        }
      } catch {
        errors.push(t("providers.form.baseUrlInvalid"));
      }
    }
    if (!configJson.ok) {
      errors.push(t("providers.form.configNotObject"));
    } else if (isGeneric) {
      errors.push(...validateGenericLocal(configJson.value ?? {}));
    }

    const payload: ProviderInput = {
      name: state.name.trim(),
      type: state.type,
      enabled: state.enabled,
      baseUrl: state.baseUrl.trim() || null,
      timeoutMs: intValue(state.timeoutMs, 12000, 500, 120000, t("providers.form.timeoutMs"), errors),
      maxConcurrency: intValue(state.maxConcurrency, 4, 1, 64, t("providers.form.maxConcurrency"), errors),
      priority: intValue(state.priority, 100, 0, 1000, t("providers.form.priority"), errors),
      weight: intValue(state.weight, 100, 1, 1000, t("providers.form.weight"), errors),
      maxRetries: intValue(state.maxRetries, 1, 0, 5, t("providers.form.maxRetries"), errors),
      language: state.language.trim() || null,
      freshness: state.freshness ? (state.freshness as Freshness) : null,
      resultsPerPage: intValue(
        state.resultsPerPage,
        10,
        1,
        50,
        t("providers.form.resultsPerPage"),
        errors,
      ),
      rpmLimit: intValue(state.rpmLimit, 60, 1, 100000, t("providers.form.rpmLimit"), errors),
      dailyQuota: state.dailyQuota.trim()
        ? intValue(state.dailyQuota, 0, 1, 10_000_000, t("providers.form.dailyQuota"), errors)
        : null,
      keyStrategy: state.keyStrategy,
      cooldownMs: intValue(state.cooldownMs, 30000, 1000, 3_600_000, t("providers.form.cooldownMs"), errors),
      breakerThreshold: intValue(
        state.breakerThreshold,
        5,
        1,
        100,
        t("providers.form.breakerThreshold"),
        errors,
      ),
      breakerCooldownMs: intValue(
        state.breakerCooldownMs,
        60000,
        1000,
        3_600_000,
        t("providers.form.breakerCooldownMs"),
        errors,
      ),
      config: (configJson.value ?? {}) as Record<string, unknown>,
    };

    setFormErrors(errors);
    if (errors.length > 0) return;

    setSaving(true);
    try {
      if (provider) {
        const patch: Partial<ProviderInput> = { ...payload };
        delete patch.type;
        await api.updateProvider(provider.id, patch);
      } else {
        await api.createProvider(payload);
      }
      onSaved();
      onClose();
    } catch (caught) {
      setError(toApiError(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      size="lg"
      title={isEdit ? t("providers.form.editTitle", { name: provider?.name ?? "" }) : t("providers.form.createTitle")}
      description={isEdit ? t("providers.form.editHint") : t("providers.form.typeHint")}
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" form="provider-form" size="sm" loading={saving}>
            {saving ? t("common.saving") : t("common.save")}
          </Button>
        </>
      }
    >
      <form onSubmit={(event) => void submit(event)} className="space-y-5" id="provider-form">
        {error ? (
          <Alert tone="error" title={`${error.code}: ${error.message}`}>
            {error.details ? <JsonPreview value={error.details} /> : null}
          </Alert>
        ) : null}

        {formErrors.length > 0 ? (
          <Alert tone="warning" title={t("settings.formInvalid")}>
            <ul className="list-disc pl-4">
              {formErrors.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          </Alert>
        ) : null}

        <section className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("providers.form.basicInfo")}</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("providers.form.name")} htmlFor="provider-name" required>
              <Input
                id="provider-name"
                required
                maxLength={80}
                value={state.name}
                onChange={(event) => update("name", event.target.value)}
                placeholder={t("providers.form.namePlaceholder")}
              />
            </Field>

            <Field label={t("providers.form.type")} htmlFor="provider-type" required>
              {isEdit ? (
                <div className="flex h-9 items-center gap-2 rounded-md border bg-muted/40 px-3 text-sm">
                  <span className="font-mono text-xs">{state.type}</span>
                  <Badge tone="outline">
                    {implementationLabels[(selectedCatalog?.implementation ?? "builtin") as keyof typeof implementationLabels]}
                  </Badge>
                </div>
              ) : (
                <Select
                  id="provider-type"
                  required
                  value={state.type}
                  onChange={(event) => {
                    const entry = catalog.find((item) => item.type === event.target.value);
                    setState((current) => ({
                      ...current,
                      type: event.target.value,
                      baseUrl: current.baseUrl || entry?.defaultBaseUrl || "",
                      name: current.name || entry?.name || "",
                      config:
                        event.target.value === "generic-http" && current.config.trim() === "{}"
                          ? prettyJson(GENERIC_TEMPLATE)
                          : current.config,
                    }));
                    setConfigCheck(null);
                  }}
                >
                  <option value="">{t("providers.form.type")}</option>
                  {createTypes.map((entry) => (
                    <option key={entry.type} value={entry.type}>
                      {entry.name} · {implementationLabels[entry.implementation]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>

          {selectedCatalog ? (
            <div className="rounded-md border bg-muted/25 p-3 text-[11px] leading-relaxed text-muted-foreground">
              <p className="text-foreground">{selectedCatalog.description}</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <Badge tone="outline">{providerAuthLabels[selectedCatalog.authType]}</Badge>
                <Badge tone={selectedCatalog.verification === "live_tested" ? "success" : "muted"}>
                  {verificationLabels[selectedCatalog.verification]}
                </Badge>
                {selectedCatalog.docsUrl ? (
                  <a
                    href={selectedCatalog.docsUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="underline underline-offset-2 hover:text-foreground"
                  >
                    {t("providers.catalog.docs")}
                  </a>
                ) : null}
              </div>
              {selectedCatalog.notes ? <p className="mt-1.5">{selectedCatalog.notes}</p> : null}
            </div>
          ) : null}

          <Field
            label={t("providers.form.baseUrl")}
            htmlFor="provider-base"
            hint={
              isLegacy
                ? t("providers.form.baseUrlHintLegacy")
                : t("providers.form.baseUrlHint")
            }
            required={isGeneric}
          >
            <Input
              id="provider-base"
              value={state.baseUrl}
              onChange={(event) => update("baseUrl", event.target.value)}
              placeholder={isLegacy ? "http://host.docker.internal:44475" : "https://api.example.com"}
              spellCheck={false}
            />
          </Field>

          <div className="flex items-center justify-between rounded-md border bg-card px-3 py-2.5">
            <div>
              <p className="text-xs font-medium">{t("providers.form.enabled")}</p>
              <p className="text-[11px] text-muted-foreground">{t("providers.form.enabledHint")}</p>
            </div>
            <Switch checked={state.enabled} onChange={(value) => update("enabled", value)} label={t("providers.form.enabled")} />
          </div>
        </section>

        <section className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("providers.form.requestSection")}</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("providers.form.timeoutMs")} htmlFor="provider-timeout">
              <Input
                id="provider-timeout"
                type="number"
                min={500}
                max={120000}
                value={state.timeoutMs}
                onChange={(event) => update("timeoutMs", event.target.value)}
              />
            </Field>
            <Field label={t("providers.form.resultsPerPage")} htmlFor="provider-ipp">
              <Input
                id="provider-ipp"
                type="number"
                min={1}
                max={50}
                value={state.resultsPerPage}
                onChange={(event) => update("resultsPerPage", event.target.value)}
              />
            </Field>
            <Field label={t("providers.form.language")} htmlFor="provider-language" hint={t("providers.form.languageHint")}>
              <Input
                id="provider-language"
                value={state.language}
                onChange={(event) => update("language", event.target.value)}
                maxLength={24}
                placeholder="zh"
              />
            </Field>
            <Field label={t("providers.form.freshness")} htmlFor="provider-freshness">
              <Select
                id="provider-freshness"
                value={state.freshness}
                onChange={(event) => update("freshness", event.target.value)}
              >
                {freshnessOptions.map((option) => (
                  <option key={option || "none"} value={option}>
                    {option === "" ? t("providers.freshness.null") : freshnessLabels[option as Freshness]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </section>

        <section className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("providers.form.schedulingSection")}</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("providers.form.maxConcurrency")} htmlFor="provider-conc">
              <Input
                id="provider-conc"
                type="number"
                min={1}
                max={64}
                value={state.maxConcurrency}
                onChange={(event) => update("maxConcurrency", event.target.value)}
              />
            </Field>
            <Field label={t("providers.form.maxRetries")} htmlFor="provider-retries">
              <Input
                id="provider-retries"
                type="number"
                min={0}
                max={5}
                value={state.maxRetries}
                onChange={(event) => update("maxRetries", event.target.value)}
              />
            </Field>
            <Field label={t("providers.form.priority")} htmlFor="provider-priority">
              <Input
                id="provider-priority"
                type="number"
                min={0}
                max={1000}
                value={state.priority}
                onChange={(event) => update("priority", event.target.value)}
              />
            </Field>
            <Field label={t("providers.form.weight")} htmlFor="provider-weight">
              <Input
                id="provider-weight"
                type="number"
                min={1}
                max={1000}
                value={state.weight}
                onChange={(event) => update("weight", event.target.value)}
              />
            </Field>
            <Field label={t("providers.form.rpmLimit")} htmlFor="provider-rpm">
              <Input
                id="provider-rpm"
                type="number"
                min={1}
                max={100000}
                value={state.rpmLimit}
                onChange={(event) => update("rpmLimit", event.target.value)}
              />
            </Field>
            <Field label={t("providers.form.dailyQuota")} htmlFor="provider-quota" hint={t("providers.form.dailyQuotaHint")}>
              <Input
                id="provider-quota"
                type="number"
                min={1}
                max={10000000}
                value={state.dailyQuota}
                onChange={(event) => update("dailyQuota", event.target.value)}
                placeholder="—"
              />
            </Field>
            <Field label={t("providers.form.keyStrategy")} htmlFor="provider-strategy">
              <Select
                id="provider-strategy"
                value={state.keyStrategy}
                onChange={(event) => update("keyStrategy", event.target.value as KeyStrategy)}
              >
                {keyStrategies.map((strategy) => (
                  <option key={strategy} value={strategy}>
                    {keyStrategyLabels[strategy]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t("providers.form.cooldownMs")} htmlFor="provider-cooldown">
              <Input
                id="provider-cooldown"
                type="number"
                min={1000}
                max={3600000}
                value={state.cooldownMs}
                onChange={(event) => update("cooldownMs", event.target.value)}
              />
            </Field>
          </div>
        </section>

        <section className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("providers.form.breakerSection")}</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("providers.form.breakerThreshold")} htmlFor="provider-breaker">
              <Input
                id="provider-breaker"
                type="number"
                min={1}
                max={100}
                value={state.breakerThreshold}
                onChange={(event) => update("breakerThreshold", event.target.value)}
              />
            </Field>
            <Field label={t("providers.form.breakerCooldownMs")} htmlFor="provider-breaker-cooldown">
              <Input
                id="provider-breaker-cooldown"
                type="number"
                min={1000}
                max={3600000}
                value={state.breakerCooldownMs}
                onChange={(event) => update("breakerCooldownMs", event.target.value)}
              />
            </Field>
          </div>
        </section>

        <section className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <FileJson className="size-3.5" aria-hidden />
              {isGeneric ? t("providers.form.genericConfig") : t("providers.form.config")}
            </h3>
            {isGeneric ? (
              <div className="flex items-center gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    update("config", prettyJson(GENERIC_TEMPLATE));
                  }}
                >
                  {t("providers.form.template")}
                </Button>
                <Button size="sm" variant="outline" onClick={() => void validateConfig()} disabled={validating}>
                  {validating ? (
                    <>
                      <Loader2 className="animate-spin" aria-hidden />
                      {t("providers.form.validating")}
                    </>
                  ) : (
                    t("providers.form.validateConfig")
                  )}
                </Button>
              </div>
            ) : null}
          </div>

          {isGeneric ? <p className="text-[11px] leading-relaxed text-muted-foreground">{t("providers.form.genericHint")}</p> : null}
          {!isGeneric ? <p className="text-[11px] text-muted-foreground">{t("providers.form.configHint")}</p> : null}

          <Textarea
            value={state.config}
            onChange={(event) => update("config", event.target.value)}
            rows={isGeneric ? 14 : 4}
            spellCheck={false}
            className="font-mono text-[12px]"
            aria-invalid={!configJson.ok}
            aria-label={t("providers.form.config")}
          />

          {!configJson.ok ? (
            <Alert tone="warning" title={t("common.invalidJson")}>
              {localConfigError}
            </Alert>
          ) : configCheck ? (
            configCheck.ok ? (
              <Alert tone="success" title={configCheck.message}>
                {configCheck.errors && configCheck.errors.length > 0 ? (
                  <ul className="list-disc pl-4">
                    {configCheck.errors.map((message) => (
                      <li key={message}>{message}</li>
                    ))}
                  </ul>
                ) : null}
                <span className="text-[10px] opacity-70">
                  {configCheck.remote ? t("providers.form.validationRemote") : t("providers.form.validationLocal")}
                </span>
              </Alert>
            ) : (
              <Alert tone="error" title={configCheck.message}>
                {configCheck.errors && configCheck.errors.length > 0 ? (
                  <ul className="list-disc pl-4">
                    {configCheck.errors.map((message) => (
                      <li key={message}>{message}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="inline-flex items-center gap-1">
                    <AlertTriangle className="size-3" aria-hidden />
                    {t("providers.form.configInvalid")}
                  </p>
                )}
              </Alert>
            )
          ) : null}
        </section>
      </form>
    </Sheet>
  );
}
