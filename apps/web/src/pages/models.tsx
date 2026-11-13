import { useMemo, useState, type FormEvent } from "react";
import {
  CheckCircle2,
  Cpu,
  KeyRound,
  Pencil,
  Plus,
  RefreshCw,
  Star,
  Trash2,
  XCircle,
} from "lucide-react";
import { api, toApiError, type ApiError } from "../lib/api";
import { formatDateTime, formatMs, prettyJson } from "../lib/format";
import { useAsyncData, useDocumentTitle } from "../lib/hooks";
import { modelKindLabels, modelProviderTypeLabels, t } from "../lib/i18n";
import type { ModelConfig, ModelInput, ModelKind, ModelProviderType } from "../lib/types";
import { ConfirmDialog, Dialog } from "../components/overlay";
import { Tabs } from "../components/tabs";
import { useToast } from "../components/toast";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
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

const kinds: ModelKind[] = ["chat", "embedding", "rerank"];
const providerTypes: ModelProviderType[] = [
  "openai-compatible",
  "anthropic",
  "gemini",
  "cohere",
  "jina",
  "custom-http",
];

interface ModelFormState {
  kind: ModelKind;
  name: string;
  providerType: ModelProviderType;
  baseUrl: string;
  apiKey: string;
  modelId: string;
  dimensions: string;
  batchSize: string;
  timeoutMs: string;
  maxConcurrency: string;
  params: string;
  enabled: boolean;
  isDefault: boolean;
}

function emptyState(kind: ModelKind): ModelFormState {
  return {
    kind,
    name: "",
    providerType: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    modelId: "",
    dimensions: "",
    batchSize: "32",
    timeoutMs: "30000",
    maxConcurrency: "4",
    params: "{}",
    enabled: true,
    isDefault: false,
  };
}

function fromModel(model: ModelConfig): ModelFormState {
  return {
    kind: model.kind,
    name: model.name,
    providerType: model.providerType,
    baseUrl: model.baseUrl,
    apiKey: "",
    modelId: model.modelId,
    dimensions: model.dimensions === null ? "" : String(model.dimensions),
    batchSize: String(model.batchSize),
    timeoutMs: String(model.timeoutMs),
    maxConcurrency: String(model.maxConcurrency),
    params: prettyJson(model.params ?? {}),
    enabled: model.enabled,
    isDefault: model.isDefault,
  };
}

export function ModelsPage() {
  useDocumentTitle(t("models.title"));
  const toast = useToast();
  const [tab, setTab] = useState<ModelKind>("chat");
  const models = useAsyncData((signal) => api.models(signal), []);
  const [form, setForm] = useState<{ model: ModelConfig | null; kind: ModelKind } | null>(null);
  const [deleting, setDeleting] = useState<ModelConfig | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const counts = useMemo(() => {
    const map: Record<ModelKind, number> = { chat: 0, embedding: 0, rerank: 0 };
    for (const model of models.data ?? []) map[model.kind] += 1;
    return map;
  }, [models.data]);

  const visible = useMemo(
    () => (models.data ?? []).filter((model) => model.kind === tab),
    [models.data, tab],
  );

  const setDefault = async (model: ModelConfig) => {
    setBusyId(model.id);
    try {
      await api.updateModel(model.id, { isDefault: true });
      toast.success({ title: t("models.form.defaultSet") });
      models.reload();
    } catch (caught) {
      const apiError = toApiError(caught);
      toast.error({ title: apiError.message, description: apiError.code });
    } finally {
      setBusyId(null);
    }
  };

  const toggleEnabled = async (model: ModelConfig, enabled: boolean) => {
    setBusyId(model.id);
    try {
      await api.updateModel(model.id, { enabled });
      models.reload();
    } catch (caught) {
      const apiError = toApiError(caught);
      toast.error({ title: apiError.message, description: apiError.code });
    } finally {
      setBusyId(null);
    }
  };

  const runTest = async (model: ModelConfig) => {
    setBusyId(model.id);
    try {
      const result = await api.testModel(model.id);
      if (result.ok) {
        toast.success({
          title: t("models.form.testOk"),
          description: `${formatMs(result.latencyMs)} · ${result.message}`,
        });
      } else {
        toast.error({ title: t("models.form.testFail"), description: result.message });
      }
      models.reload();
    } catch (caught) {
      const apiError = toApiError(caught);
      toast.error({ title: apiError.message, description: apiError.code });
    } finally {
      setBusyId(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setDeletePending(true);
    try {
      await api.deleteModel(deleting.id);
      toast.success({ title: t("models.form.deleted") });
      setDeleting(null);
      models.reload();
    } catch (caught) {
      const apiError = toApiError(caught);
      toast.error({ title: apiError.message, description: apiError.code });
    } finally {
      setDeletePending(false);
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title={t("models.title")}
        description={t("models.subtitle")}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={models.reload} disabled={models.loading}>
              <RefreshCw className={models.loading ? "animate-spin" : undefined} aria-hidden />
              {t("common.refresh")}
            </Button>
            <Button size="sm" onClick={() => setForm({ model: null, kind: tab })}>
              <Plus aria-hidden />
              {t("models.add")}
            </Button>
          </>
        }
      />

      <Tabs
        items={kinds.map((kind) => ({
          value: kind,
          label: modelKindLabels[kind],
          count: counts[kind],
        }))}
        value={tab}
        onChange={setTab}
        ariaLabel={t("models.title")}
      />

      {models.error ? (
        <Alert
          tone="error"
          title={t("states.errorTitle")}
          action={
            <Button size="sm" variant="outline" onClick={models.reload}>
              {t("common.retry")}
            </Button>
          }
        >
          <p className="font-mono">{models.error.code}</p>
          <p>{models.error.message}</p>
        </Alert>
      ) : null}

      {models.loading && !models.data ? (
        <div className="grid gap-3 lg:grid-cols-2">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-44" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <EmptyState
          icon={Cpu}
          title={t("models.empty", { kind: modelKindLabels[tab] })}
          description={t("models.emptyDesc")}
          action={
            <Button size="sm" onClick={() => setForm({ model: null, kind: tab })}>
              <Plus aria-hidden />
              {t("models.add")}
            </Button>
          }
        />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {visible.map((model) => (
            <Card key={model.id}>
              <CardContent className="space-y-3 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <p className="truncate text-sm font-medium">{model.name}</p>
                      {model.isDefault ? (
                        <Badge tone="info">
                          <Star className="size-3" aria-hidden />
                          {t("models.form.defaultBadge")}
                        </Badge>
                      ) : null}
                      {!model.enabled ? <Badge tone="muted">{t("common.disabled")}</Badge> : null}
                    </div>
                    <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">{model.modelId}</p>
                    <p className="truncate text-[10px] text-muted-foreground">
                      {modelProviderTypeLabels[model.providerType]} · {model.baseUrl}
                    </p>
                  </div>
                  <Switch
                    checked={model.enabled}
                    onChange={(value) => void toggleEnabled(model, value)}
                    disabled={busyId === model.id}
                    label={t("models.form.enabled")}
                  />
                </div>

                <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                  <Badge tone={model.hasKey ? "success" : "muted"}>
                    <KeyRound className="size-3" aria-hidden />
                    {model.hasKey ? t("models.form.hasKey") : t("models.form.noKey")}
                  </Badge>
                  {model.dimensions !== null ? (
                    <Badge tone="outline">{t("models.dimensionValue", { value: model.dimensions })}</Badge>
                  ) : null}
                  <Badge tone="outline">
                    {t("common.timeout")} {formatMs(model.timeoutMs)}
                  </Badge>
                  <Badge tone="outline">
                    {t("common.concurrency")} {model.maxConcurrency}
                  </Badge>
                </div>

                <div className="rounded-md border bg-muted/20 px-2.5 py-2 text-[11px]">
                  <p className="text-muted-foreground">{t("models.form.lastTest")}</p>
                  {model.lastTestOk === null ? (
                    <p className="text-muted-foreground">{t("models.form.neverTested")}</p>
                  ) : (
                    <div className="mt-0.5 space-y-0.5">
                      <p
                        className={
                          model.lastTestOk
                            ? "inline-flex items-center gap-1 text-success"
                            : "inline-flex items-center gap-1 text-destructive"
                        }
                      >
                        {model.lastTestOk ? (
                          <CheckCircle2 className="size-3" aria-hidden />
                        ) : (
                          <XCircle className="size-3" aria-hidden />
                        )}
                        {model.lastTestOk ? t("common.success") : t("common.failed")}
                        <span className="text-muted-foreground">· {formatDateTime(model.lastTestAt)}</span>
                      </p>
                      {model.lastTestError ? (
                        <p className="line-clamp-2 text-[10px] text-destructive">{model.lastTestError}</p>
                      ) : null}
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap gap-1.5">
                  <Button
                    size="sm"
                    variant="outline"
                    loading={busyId === model.id}
                    onClick={() => void runTest(model)}
                  >
                    {t("models.form.test")}
                  </Button>
                  {!model.isDefault ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busyId === model.id}
                      onClick={() => void setDefault(model)}
                    >
                      <Star aria-hidden />
                      {t("models.form.setDefault")}
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setForm({ model, kind: model.kind })}
                  >
                    <Pencil aria-hidden />
                    {t("common.edit")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    onClick={() => setDeleting(model)}
                  >
                    <Trash2 aria-hidden />
                    {t("common.delete")}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {form ? (
        <ModelFormDialog
          key={form.model?.id ?? `new-${form.kind}`}
          open
          onClose={() => setForm(null)}
          model={form.model}
          defaultKind={form.kind}
          onSaved={() => {
            toast.success({ title: t("models.form.saved") });
            models.reload();
            setForm(null);
          }}
        />
      ) : null}

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={confirmDelete}
        title={t("common.deleteConfirmTitle")}
        description={`${deleting?.name ?? ""} — ${t("common.deleteConfirmDesc")}`}
        confirmLabel={t("common.delete")}
        loading={deletePending}
      />
    </div>
  );
}

function ModelFormDialog({
  open,
  onClose,
  model,
  defaultKind,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  model: ModelConfig | null;
  defaultKind: ModelKind;
  onSaved: () => void;
}) {
  const [state, setState] = useState<ModelFormState>(() =>
    model ? fromModel(model) : emptyState(defaultKind),
  );
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [apiError, setApiError] = useState<ApiError | null>(null);

  const update = <K extends keyof ModelFormState>(key: K, value: ModelFormState[K]) => {
    setState((current) => ({ ...current, [key]: value }));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setApiError(null);
    const problems: string[] = [];

    if (!state.name.trim()) problems.push(t("common.requiredField", { field: t("models.form.name") }));
    if (!state.baseUrl.trim()) problems.push(t("common.requiredField", { field: t("models.form.baseUrl") }));
    if (!state.modelId.trim()) problems.push(t("common.requiredField", { field: t("models.form.modelId") }));

    let params: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(state.params.trim() || "{}");
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        problems.push(t("models.form.paramsInvalid"));
      } else {
        params = parsed as Record<string, unknown>;
      }
    } catch {
      problems.push(t("models.form.paramsInvalid"));
    }

    const dimensions = state.dimensions.trim() ? Number(state.dimensions) : null;
    if (state.kind === "embedding" && (dimensions === null || !Number.isInteger(dimensions) || dimensions < 1)) {
      problems.push(t("models.form.dimensionsRequired"));
    }

    const batchSize = Number(state.batchSize);
    const timeoutMs = Number(state.timeoutMs);
    const maxConcurrency = Number(state.maxConcurrency);
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 512) {
      problems.push(t("providers.form.rangeError", { label: t("models.form.batchSize"), min: 1, max: 512 }));
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) {
      problems.push(t("providers.form.rangeError", { label: t("models.form.timeoutMs"), min: 1000, max: 120000 }));
    }
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 64) {
      problems.push(t("providers.form.rangeError", { label: t("models.form.maxConcurrency"), min: 1, max: 64 }));
    }

    setErrors(problems);
    if (problems.length > 0) return;

    const payload: ModelInput = {
      kind: state.kind,
      name: state.name.trim(),
      providerType: state.providerType,
      baseUrl: state.baseUrl.trim(),
      modelId: state.modelId.trim(),
      dimensions,
      batchSize,
      timeoutMs,
      maxConcurrency,
      params,
      enabled: state.enabled,
      isDefault: state.isDefault,
      ...(state.apiKey.trim() ? { apiKey: state.apiKey.trim() } : {}),
    };

    setSaving(true);
    try {
      if (model) {
        await api.updateModel(model.id, payload);
      } else {
        await api.createModel(payload);
      }
      onSaved();
    } catch (caught) {
      setApiError(toApiError(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={model ? t("models.form.editTitle", { name: model.name }) : t("models.form.createTitle")}
      description={t("models.subtitle")}
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" form="model-form" size="sm" loading={saving}>
            {saving ? t("common.saving") : t("common.save")}
          </Button>
        </>
      }
    >
      <form id="model-form" onSubmit={(event) => void submit(event)} className="space-y-3">
        {apiError ? (
          <Alert tone="error" title={`${apiError.code}: ${apiError.message}`}>
            {apiError.details ? <JsonPreview value={apiError.details} /> : null}
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

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("models.form.kind")} htmlFor="model-kind" required>
            <Select
              id="model-kind"
              value={state.kind}
              onChange={(event) => update("kind", event.target.value as ModelKind)}
            >
              {kinds.map((kind) => (
                <option key={kind} value={kind}>
                  {modelKindLabels[kind]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("models.form.providerType")} htmlFor="model-provider" required>
            <Select
              id="model-provider"
              value={state.providerType}
              onChange={(event) => update("providerType", event.target.value as ModelProviderType)}
            >
              {providerTypes.map((providerType) => (
                <option key={providerType} value={providerType}>
                  {modelProviderTypeLabels[providerType]}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field label={t("models.form.name")} htmlFor="model-name" required>
          <Input
            id="model-name"
            required
            maxLength={80}
            value={state.name}
            onChange={(event) => update("name", event.target.value)}
            placeholder={t("models.form.namePlaceholder")}
          />
        </Field>

        <Field label={t("models.form.baseUrl")} htmlFor="model-base" hint={t("models.form.baseUrlHint")} required>
          <Input
            id="model-base"
            required
            value={state.baseUrl}
            onChange={(event) => update("baseUrl", event.target.value)}
            spellCheck={false}
            placeholder="https://api.openai.com/v1"
          />
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label={t("models.form.modelId")}
            htmlFor="model-id"
            required
            hint={t("models.form.modelIdPlaceholder")}
          >
            <Input
              id="model-id"
              required
              value={state.modelId}
              onChange={(event) => update("modelId", event.target.value)}
              spellCheck={false}
            />
          </Field>
          <Field
            label={t("models.form.apiKey")}
            htmlFor="model-key"
            hint={model ? t("models.form.apiKeyEditHint") : t("models.form.apiKeyHint")}
          >
            <Input
              id="model-key"
              type="password"
              autoComplete="off"
              value={state.apiKey}
              onChange={(event) => update("apiKey", event.target.value)}
              placeholder={model?.apiKeyHint ?? "sk-…"}
            />
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field
            label={t("models.form.dimensions")}
            htmlFor="model-dimensions"
            required={state.kind === "embedding"}
            hint={state.kind === "embedding" ? t("models.form.dimensionsHint") : undefined}
          >
            <Input
              id="model-dimensions"
              type="number"
              min={1}
              max={16384}
              value={state.dimensions}
              onChange={(event) => update("dimensions", event.target.value)}
              placeholder="1536"
            />
          </Field>
          <Field label={t("models.form.batchSize")} htmlFor="model-batch">
            <Input
              id="model-batch"
              type="number"
              min={1}
              max={512}
              value={state.batchSize}
              onChange={(event) => update("batchSize", event.target.value)}
            />
          </Field>
          <Field label={t("models.form.maxConcurrency")} htmlFor="model-concurrency">
            <Input
              id="model-concurrency"
              type="number"
              min={1}
              max={64}
              value={state.maxConcurrency}
              onChange={(event) => update("maxConcurrency", event.target.value)}
            />
          </Field>
        </div>

        <Field label={t("models.form.timeoutMs")} htmlFor="model-timeout">
          <Input
            id="model-timeout"
            type="number"
            min={1000}
            max={120000}
            value={state.timeoutMs}
            onChange={(event) => update("timeoutMs", event.target.value)}
          />
        </Field>

        <Field label={t("models.form.params")} htmlFor="model-params" hint={t("models.form.paramsHint")}>
          <Textarea
            id="model-params"
            rows={4}
            spellCheck={false}
            className="font-mono text-[12px]"
            value={state.params}
            onChange={(event) => update("params", event.target.value)}
          />
        </Field>

        <div className="grid gap-2 sm:grid-cols-2">
          <div className="flex items-center justify-between rounded-md border bg-muted/20 px-3 py-2">
            <span className="text-xs">{t("models.form.enabled")}</span>
            <Switch checked={state.enabled} onChange={(value) => update("enabled", value)} label={t("models.form.enabled")} />
          </div>
          <div className="flex items-center justify-between rounded-md border bg-muted/20 px-3 py-2">
            <span className="text-xs">{t("models.form.isDefault")}</span>
            <Switch
              checked={state.isDefault}
              onChange={(value) => update("isDefault", value)}
              label={t("models.form.isDefault")}
            />
          </div>
        </div>
      </form>
    </Dialog>
  );
}
