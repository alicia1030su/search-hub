import { useMemo, useState, type FormEvent } from "react";
import { AlertTriangle, FileJson, Loader2 } from "lucide-react";
import { api, toApiError, type ApiError } from "../../lib/api";
import { parseJsonObject, prettyJson } from "../../lib/format";
import { keyStrategyLabels, freshnessLabels, providerAuthLabels, t, verificationLabels, implementationLabels } from "../../lib/i18n";
import type {
  Freshness,
  GenericProviderConfig,
  KeyStrategy,
  ProviderCatalogField,
  ProviderCatalogEntry,
  ProviderManifest,
  ProviderInput,
  ProviderSummary,
} from "../../lib/types";
import { ConfirmDialog, Sheet } from "../../components/overlay";
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
  /** Platform-level search parameters (targetResults, maxPages, safeSearch…). */
  searchConfig: string;
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
      searchConfig: prettyJson(provider.searchConfig ?? {}),
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
    searchConfig: "{}",
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

function readJsonValue(json: string, key: string): unknown {
  try {
    const parsed = JSON.parse(json || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return (parsed as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function writeJsonValue(json: string, key: string, value: unknown): string {
  let parsed: Record<string, unknown> = {};
  try {
    const candidate = JSON.parse(json || "{}");
    parsed = candidate && typeof candidate === "object" && !Array.isArray(candidate) ? candidate : {};
  } catch {
    parsed = {};
  }
  if (value === "" || value === undefined || value === null) delete parsed[key];
  else parsed[key] = value;
  return prettyJson(parsed);
}

function readConfigValue(config: string, key: string): unknown {
  try {
    const parsed = JSON.parse(config || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return (parsed as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/**
 * Tencent-style providers need a credential *pair*. The pair is stored as one
 * JSON string so the key scheduler rotates both halves atomically; two
 * unrelated halves can never be combined.
 */
function buildCredentialValue(
  fields: ProviderCatalogField[],
  values: Record<string, string>,
  kind: "single" | "pair" | undefined,
): string | null {
  if (fields.length === 0) return null;
  const filled = fields
    .map((field) => ({ key: field.key, value: (values[field.key] ?? "").trim() }))
    .filter((entry) => entry.value.length > 0);
  if (filled.length === 0) return null;
  if (kind === "pair") {
    const missing = fields.some((field) => field.required && !(values[field.key] ?? "").trim());
    if (missing) return null;
    return JSON.stringify(Object.fromEntries(filled.map((entry) => [entry.key, entry.value])));
  }
  return filled.length === 1 ? filled[0]!.value : JSON.stringify(Object.fromEntries(filled.map((entry) => [entry.key, entry.value])));
}

export interface ProviderFormProps {
  open: boolean;
  onClose: () => void;
  provider: ProviderSummary | null;
  preset: ProviderCatalogEntry | null;
  catalog: ProviderCatalogEntry[];
  adapters: string[];
  /** All manifests from the server; the form picks the one for the selected type. */
  manifests?: ProviderManifest[];
  onSaved: () => void;
}

export function ProviderForm({
  open,
  onClose,
  provider,
  preset,
  catalog,
  adapters,
  manifests,
  onSaved,
}: ProviderFormProps) {
  const [state, setState] = useState<FormState>(() => toState(provider, preset));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  // Edit mode defaults to "do not touch the stored credential". Filling the
  // fields without choosing an action was the silent no-op this fixes.
  const [credentialMode, setCredentialMode] = useState<"none" | "add">("none");
  const [pendingType, setPendingType] = useState<string | null>(null);
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

  // Derived from the *current* type so switching providers in the sheet swaps
  // the capability contract immediately instead of keeping the opened preset's.
  const manifest = useMemo(
    () => (manifests ?? []).find((entry) => entry.providerId === state.type) ?? null,
    [manifests, state.type],
  );

  // A provider that needs a key but does not declare explicit credential
  // fields still needs a place to type it. Without this the create form had no
  // credential input at all for DeepSeek/Doubao/Qianfan, so the only way to add
  // a key was to save first and then open Key management.
  const credentialFields = useMemo<ProviderCatalogField[]>(() => {
    const declared = (selectedCatalog?.fields ?? []).filter(
      (field) => (field.target ?? "config") === "credential",
    );
    if (declared.length > 0) return declared;
    if (!selectedCatalog || selectedCatalog.authType === "none") return [];
    return [
      {
        key: "apiKey",
        label: selectedCatalog.credentialKind === "pair" ? "API Key" : "API Key",
        type: "password",
        required: false,
        target: "credential",
        placeholder: "留空表示稍后在 Key 管理中添加",
      },
    ];
  }, [selectedCatalog]);

  const hasConfigFields = (selectedCatalog?.fields ?? []).some(
    (field) => (field.target ?? "config") !== "credential",
  );

  const setConfigField = (fieldKey: string, value: unknown) => {
    setState((current) => {
      let parsed: Record<string, unknown> = {};
      try {
        const candidate = JSON.parse(current.config || "{}");
        parsed = candidate && typeof candidate === "object" && !Array.isArray(candidate) ? candidate : {};
      } catch {
        parsed = {};
      }
      if (value === "" || value === undefined) delete parsed[fieldKey];
      else parsed[fieldKey] = value;
      return { ...current, config: prettyJson(parsed) };
    });
    setConfigCheck(null);
  };

  const applyType = (type: string) => {
    const entry = catalog.find((item) => item.type === type) ?? null;
    setState((current) => ({
      ...current,
      type,
      // Reset instead of inheriting the previous provider's endpoint/config:
      // keeping them produced a provider that pointed at the wrong host.
      baseUrl: entry?.defaultBaseUrl ?? "",
      config: type === "generic-http" ? prettyJson(GENERIC_TEMPLATE) : "{}",
      name: current.name && current.name !== (selectedCatalog?.name ?? "") ? current.name : (entry?.name ?? ""),
    }));
    setCredentials({});
    setCredentialMode("none");
    setConfigCheck(null);
    setPendingType(null);
  };

  const typeHasUnsavedInput = () =>
    Object.values(credentials).some((value) => value.trim().length > 0) ||
    (state.baseUrl ?? "") !== (selectedCatalog?.defaultBaseUrl ?? "") ||
    state.config.trim() !== (isGeneric ? prettyJson(GENERIC_TEMPLATE) : "{}").trim();

  const requestTypeChange = (type: string) => {
    if (type === state.type) return;
    if (typeHasUnsavedInput()) setPendingType(type);
    else applyType(type);
  };

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
    if (!parseJsonObject(state.searchConfig).ok) {
      errors.push(t("providers.form.searchConfigInvalid"));
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
      searchConfig: (parseJsonObject(state.searchConfig).value ?? {}) as Record<string, unknown>,
    };

    const credentialValue = buildCredentialValue(credentialFields, credentials, selectedCatalog?.credentialKind);
    if (!isEdit && credentialFields.some((field) => field.required) && credentialValue === null) {
      errors.push(t("providers.form.credentialRequired"));
    }

    setFormErrors(errors);
    if (errors.length > 0) return;

    setSaving(true);
    try {
      if (provider) {
        const patch: Partial<ProviderInput> = { ...payload };
        delete patch.type;
        await api.updateProvider(provider.id, patch);
        if (credentialMode === "add" && credentialValue !== null) {
          // An explicit action, recorded as its own key row. Editing never
          // overwrites an existing key silently.
          await api.createKey(provider.id, {
            label: t("providers.form.rotatedCredential"),
            key: credentialValue,
            weight: 100,
            enabled: true,
          });
        }
      } else {
        // The credential travels with the provider create request so the server
        // can roll both back together; a separate second call could leave a
        // provider saved with no working credential.
        await api.createProvider({
          ...payload,
          ...(credentialValue === null
            ? {}
            : {
                credential: {
                  label: t("providers.form.primaryCredential"),
                  key: credentialValue,
                  weight: 100,
                  enabled: true,
                },
              }),
        });
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
                  onChange={(event) => requestTypeChange(event.target.value)}
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

          {selectedCatalog && (hasConfigFields || credentialFields.length > 0) ? (
            <div className="space-y-3 rounded-md border bg-card p-3">
              <div>
                <p className="text-xs font-semibold">{t("providers.form.providerFields")}</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {t("providers.form.providerFieldsHint")}
                </p>
              </div>
              {isEdit && credentialFields.length > 0 ? (
                <div className="space-y-1.5 rounded-md border bg-muted/25 p-2.5">
                  <p className="text-[11px] font-medium">{t("providers.form.credentialAction")}</p>
                  <div className="flex flex-wrap gap-3">
                    <label className="flex items-center gap-1.5 text-[11px]">
                      <input
                        type="radio"
                        name="credential-mode"
                        value="none"
                        checked={credentialMode === "none"}
                        onChange={() => {
                          setCredentialMode("none");
                          setCredentials({});
                        }}
                      />
                      {t("providers.form.credentialKeep")}
                    </label>
                    <label className="flex items-center gap-1.5 text-[11px]">
                      <input
                        type="radio"
                        name="credential-mode"
                        value="add"
                        checked={credentialMode === "add"}
                        onChange={() => setCredentialMode("add")}
                      />
                      {t("providers.form.credentialAdd")}
                    </label>
                  </div>
                  <p className="text-[10px] text-muted-foreground">{t("providers.form.credentialActionHint")}</p>
                </div>
              ) : null}
              <div className="grid gap-3 sm:grid-cols-2">
                {[
                  ...(selectedCatalog.fields ?? []).filter(
                    (field) => (field.target ?? "config") !== "credential",
                  ),
                  ...credentialFields,
                ].map((field) => {
                  const target = field.target ?? "config";
                  if (target === "credential") {
                    const disabled = isEdit && credentialMode === "none";
                    return (
                      <Field
                        key={field.key}
                        label={field.label}
                        htmlFor={`field-${field.key}`}
                        required={field.required && !isEdit}
                        hint={field.help}
                      >
                        <Input
                          id={`field-${field.key}`}
                          type={field.type === "password" ? "password" : "text"}
                          disabled={disabled}
                          value={credentials[field.key] ?? ""}
                          onChange={(event) =>
                            setCredentials((current) => ({
                              ...current,
                              [field.key]: event.target.value,
                            }))
                          }
                          placeholder={field.placeholder}
                          autoComplete="off"
                          spellCheck={false}
                        />
                      </Field>
                    );
                  }
                  if (target === "baseUrl") {
                    return (
                      <Field key={field.key} label={field.label} htmlFor={`field-${field.key}`} required={field.required} hint={field.help}>
                        <Input
                          id={`field-${field.key}`}
                          value={state.baseUrl}
                          onChange={(event) => update("baseUrl", event.target.value)}
                          placeholder={field.placeholder}
                          spellCheck={false}
                        />
                      </Field>
                    );
                  }
                  if (target === "model") {
                    return (
                      <Field key={field.key} label={field.label} htmlFor={`field-${field.key}`} required={field.required} hint={field.help}>
                        <Input
                          id={`field-${field.key}`}
                          value={String(readConfigValue(state.config, field.key) ?? field.default ?? "")}
                          onChange={(event) => setConfigField(field.key, event.target.value)}
                          placeholder={field.placeholder}
                          spellCheck={false}
                        />
                      </Field>
                    );
                  }
                  if (field.type === "boolean") {
                    return (
                      <div
                        key={field.key}
                        className="flex items-center justify-between rounded-md border px-3 py-2.5"
                      >
                        <div>
                          <p className="text-xs font-medium">{field.label}</p>
                          {field.help ? (
                            <p className="text-[11px] text-muted-foreground">{field.help}</p>
                          ) : null}
                        </div>
                        <Switch
                          checked={Boolean(readConfigValue(state.config, field.key) ?? field.default)}
                          onChange={(value) => setConfigField(field.key, value)}
                          label={field.label}
                        />
                      </div>
                    );
                  }
                  if (field.type === "select") {
                    return (
                      <Field
                        key={field.key}
                        label={field.label}
                        htmlFor={`field-${field.key}`}
                        hint={field.help}
                      >
                        <Select
                          id={`field-${field.key}`}
                          value={String(readConfigValue(state.config, field.key) ?? field.default ?? "")}
                          onChange={(event) => setConfigField(field.key, event.target.value)}
                        >
                          {(field.options ?? []).map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </Select>
                      </Field>
                    );
                  }
                  return (
                    <Field
                      key={field.key}
                      label={field.label}
                      htmlFor={`field-${field.key}`}
                      hint={field.help}
                    >
                      <Input
                        id={`field-${field.key}`}
                        type={field.type === "number" ? "number" : "text"}
                        value={String(readConfigValue(state.config, field.key) ?? "")}
                        onChange={(event) =>
                          setConfigField(
                            field.key,
                            field.type === "number" && event.target.value !== ""
                              ? Number(event.target.value)
                              : event.target.value,
                          )
                        }
                        placeholder={field.placeholder}
                      />
                    </Field>
                  );
                })}
              </div>
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

        {manifest ? (
          <section className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t("providers.form.searchSection")}
            </h3>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {t("providers.form.searchHint")}
            </p>
            <p className="text-[11px] text-muted-foreground">
              {manifest.pagination.supported
                ? t("providers.form.paginationNote", {
                    pageSize: manifest.pagination.pageSize ?? 0,
                    maxPages: manifest.pagination.maxPages ?? 0,
                    maxResults: manifest.pagination.maxResults ?? 0,
                  })
                : t("providers.form.noPaginationNote", {
                    maxResults: manifest.parameters.limits.targetResults?.max ?? 0,
                  })}
            </p>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label={t("providers.form.targetResults")} htmlFor="provider-target" hint={t("providers.form.targetResultsHint")}>
                <Input
                  id="provider-target"
                  type="number"
                  min={manifest.parameters.limits.targetResults?.min ?? 1}
                  max={manifest.parameters.limits.targetResults?.max ?? 100}
                  value={String(readJsonValue(state.searchConfig, "targetResults") ?? "")}
                  onChange={(event) =>
                    update(
                      "searchConfig",
                      writeJsonValue(
                        state.searchConfig,
                        "targetResults",
                        event.target.value === "" ? "" : Number(event.target.value),
                      ),
                    )
                  }
                  placeholder={String(manifest.parameters.limits.targetResults?.default ?? 10)}
                />
              </Field>
              {manifest.pagination.supported ? (
                <>
                  <Field label={t("providers.form.maxPages")} htmlFor="provider-max-pages">
                    <Input
                      id="provider-max-pages"
                      type="number"
                      min={1}
                      max={manifest.pagination.maxPages ?? 10}
                      value={String(readJsonValue(state.searchConfig, "maxPages") ?? "")}
                      onChange={(event) =>
                        update(
                          "searchConfig",
                          writeJsonValue(
                            state.searchConfig,
                            "maxPages",
                            event.target.value === "" ? "" : Number(event.target.value),
                          ),
                        )
                      }
                      placeholder={String(manifest.pagination.maxPages ?? 3)}
                    />
                  </Field>
                  <Field label={t("providers.form.maxRequestsPerSearch")} htmlFor="provider-max-requests">
                    <Input
                      id="provider-max-requests"
                      type="number"
                      min={1}
                      max={20}
                      value={String(readJsonValue(state.searchConfig, "maxRequestsPerSearch") ?? "")}
                      onChange={(event) =>
                        update(
                          "searchConfig",
                          writeJsonValue(
                            state.searchConfig,
                            "maxRequestsPerSearch",
                            event.target.value === "" ? "" : Number(event.target.value),
                          ),
                        )
                      }
                      placeholder="3"
                    />
                  </Field>
                </>
              ) : null}
              {manifest.parameters.supported.includes("safeSearch") ? (
                <Field label={t("providers.form.safeSearch")} htmlFor="provider-safe-search">
                  <Select
                    id="provider-safe-search"
                    value={String(readJsonValue(state.searchConfig, "safeSearch") ?? "")}
                    onChange={(event) =>
                      update("searchConfig", writeJsonValue(state.searchConfig, "safeSearch", event.target.value))
                    }
                  >
                    <option value="">—</option>
                    <option value="off">{t("providers.form.safeSearch.off")}</option>
                    <option value="moderate">{t("providers.form.safeSearch.moderate")}</option>
                    <option value="strict">{t("providers.form.safeSearch.strict")}</option>
                  </Select>
                </Field>
              ) : null}
              {manifest.parameters.supported.includes("region") ? (
                <Field label={t("providers.form.region")} htmlFor="provider-region">
                  <Input
                    id="provider-region"
                    value={String(readJsonValue(state.searchConfig, "region") ?? "")}
                    onChange={(event) =>
                      update("searchConfig", writeJsonValue(state.searchConfig, "region", event.target.value))
                    }
                    placeholder="us / cn"
                  />
                </Field>
              ) : null}
              {manifest.parameters.supported.includes("sort") ? (
                <Field label={t("providers.form.sort")} htmlFor="provider-sort">
                  <Input
                    id="provider-sort"
                    value={String(readJsonValue(state.searchConfig, "sort") ?? "")}
                    onChange={(event) =>
                      update("searchConfig", writeJsonValue(state.searchConfig, "sort", event.target.value))
                    }
                    placeholder="relevance"
                  />
                </Field>
              ) : null}
              {manifest.parameters.supported.includes("includeDomains") ? (
                <Field label={t("providers.form.includeDomains")} htmlFor="provider-include-domains" hint={t("providers.form.domainsHint")}>
                  <Input
                    id="provider-include-domains"
                    value={String(readJsonValue(state.searchConfig, "includeDomains") ?? "")}
                    onChange={(event) =>
                      update("searchConfig", writeJsonValue(state.searchConfig, "includeDomains", event.target.value))
                    }
                    placeholder="a.com,b.com"
                  />
                </Field>
              ) : null}
              {manifest.parameters.supported.includes("excludeDomains") ? (
                <Field label={t("providers.form.excludeDomains")} htmlFor="provider-exclude-domains" hint={t("providers.form.domainsHint")}>
                  <Input
                    id="provider-exclude-domains"
                    value={String(readJsonValue(state.searchConfig, "excludeDomains") ?? "")}
                    onChange={(event) =>
                      update("searchConfig", writeJsonValue(state.searchConfig, "excludeDomains", event.target.value))
                    }
                    placeholder="spam.example"
                  />
                </Field>
              ) : null}
            </div>
            <div className="flex items-center justify-between rounded-md border px-3 py-2">
              <div>
                <p className="text-xs font-medium">{t("providers.form.lock")}</p>
                <p className="text-[11px] text-muted-foreground">{t("providers.form.lockHint")}</p>
              </div>
              <Switch
                checked={readJsonValue(state.searchConfig, "locked") === true}
                onChange={(value) => update("searchConfig", writeJsonValue(state.searchConfig, "locked", value))}
                label={t("providers.form.lock")}
              />
            </div>
          </section>
        ) : null}

        <section className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("providers.form.accountSection")}
          </h3>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {t("providers.form.accountHint")}
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t("providers.form.accountGroup")} htmlFor="provider-account-group" hint={t("providers.form.accountGroupHint")}>
              <Input
                id="provider-account-group"
                value={String(readConfigValue(state.config, "accountGroup") ?? "")}
                onChange={(event) => setConfigField("accountGroup", event.target.value)}
                placeholder="bailian-main"
                spellCheck={false}
              />
            </Field>
            <Field label={t("providers.form.accountRpmLimit")} htmlFor="provider-account-rpm" hint={t("providers.form.accountRpmHint")}>
              <Input
                id="provider-account-rpm"
                type="number"
                min={0}
                max={100000}
                value={String(readConfigValue(state.config, "accountRpmLimit") ?? "")}
                onChange={(event) =>
                  setConfigField(
                    "accountRpmLimit",
                    event.target.value === "" ? "" : Number(event.target.value),
                  )
                }
                placeholder="0"
              />
            </Field>
            <Field label={t("providers.form.accountDailyQuota")} htmlFor="provider-account-daily" hint={t("providers.form.accountDailyHint")}>
              <Input
                id="provider-account-daily"
                type="number"
                min={1}
                max={10000000}
                value={String(readConfigValue(state.config, "accountDailyQuota") ?? "")}
                onChange={(event) =>
                  setConfigField(
                    "accountDailyQuota",
                    event.target.value === "" ? "" : Number(event.target.value),
                  )
                }
                placeholder={t("providers.form.accountUnlimited")}
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

      <ConfirmDialog
        open={pendingType !== null}
        onClose={() => setPendingType(null)}
        onConfirm={() => {
          if (pendingType) applyType(pendingType);
        }}
        title={t("providers.form.switchTitle")}
        description={t("providers.form.switchDescription")}
        confirmLabel={t("providers.form.switchConfirm")}
        tone="default"
      />
    </Sheet>
  );
}
