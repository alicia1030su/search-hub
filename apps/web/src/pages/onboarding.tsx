import { useEffect, useMemo, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { Search } from "lucide-react";
import { api, toApiError } from "../lib/api";
import { formatDateTime, formatMs, formatNumber } from "../lib/format";
import { useAsyncData, useDocumentTitle } from "../lib/hooks";
import { categoryLabel, providerAuthLabel, t, verificationLabel } from "../lib/i18n";
import type {
  HealthCheckResult,
  HealthOverview,
  OnboardingStatus,
  ProviderCatalogEntry,
  ProviderSummary,
  RuntimeHealthValue,
  SearchResponse,
} from "../lib/types";
import { Dialog } from "../components/overlay";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Skeleton,
} from "../components/ui";

type Step = 1 | 2 | 3;
type ProbeState = { result?: HealthCheckResult; skipped?: string };

function runtimeLabel(runtime: RuntimeHealthValue): string {
  const labels: Record<RuntimeHealthValue, string> = {
    unknown: t("providers.health.runtime.unknown"),
    healthy: t("providers.health.runtime.healthy"),
    degraded: t("providers.health.runtime.degraded"),
    unhealthy: t("providers.health.runtime.unhealthy"),
    rate_limited: t("providers.health.runtime.rate_limited"),
    quota_exceeded: t("providers.health.runtime.quota_exceeded"),
    invalid_credentials: t("providers.health.runtime.invalid_credentials"),
    permission_denied: t("providers.health.runtime.permission_denied"),
    cooldown: t("providers.health.runtime.cooldown"),
    unverified: t("providers.health.runtime.unverified"),
    disabled: t("providers.health.runtime.disabled"),
  };
  return labels[runtime];
}

function probeCauseLabel(cause: string): string {
  const labels: Record<string, string> = {
    ok: t("onboarding.status.ok"),
    config_incomplete: t("onboarding.status.config_incomplete"),
    no_credential: t("onboarding.status.no_credential"),
    network: t("onboarding.status.network"),
    dns: t("onboarding.status.dns"),
    tls: t("onboarding.status.tls"),
    auth_invalid: t("onboarding.status.auth_invalid"),
    rate_limited: t("onboarding.status.rate_limited"),
    quota_exceeded: t("onboarding.status.quota_exceeded"),
    empty_results: t("onboarding.status.empty_results"),
    forbidden: t("onboarding.status.forbidden"),
    timeout: t("onboarding.status.timeout"),
    server_error: t("onboarding.status.server_error"),
    bad_response: t("onboarding.status.bad_response"),
    cancelled: t("onboarding.status.cancelled"),
  };
  return labels[cause] ?? t("onboarding.status.unknown");
}

function providerGroup(entry: ProviderCatalogEntry): "public" | "keyed" | "self" {
  if (entry.type === "mock" || entry.implementation !== "builtin" || entry.category === "compat" || entry.category === "custom") {
    return "self";
  }
  return entry.authType === "none" ? "public" : "keyed";
}

export function OnboardingPage() {
  useDocumentTitle(t("onboarding.title"));
  const navigate = useNavigate();
  const status = useAsyncData((signal) => api.onboardingStatus(signal), []);
  const providers = useAsyncData((signal) => api.providers(signal), []);
  const health = useAsyncData((signal) => api.healthOverview(signal), []);
  const [step, setStep] = useState<Step>(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [searching, setSearching] = useState(false);
  const [busyProviderId, setBusyProviderId] = useState<string | null>(null);
  const [confirmProbe, setConfirmProbe] = useState<{ providerId: string; name: string } | null>(null);
  const [probeResults, setProbeResults] = useState<Record<string, ProbeState>>({});
  const [query, setQuery] = useState("");
  const [searchResponse, setSearchResponse] = useState<SearchResponse | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (status.data?.step === 3) setStep(3);
  }, [status.data?.step]);

  const catalog = providers.data?.catalog ?? [];
  const installedTypes = useMemo(
    () => new Set((providers.data?.providers ?? []).map((provider) => provider.type)),
    [providers.data?.providers],
  );
  const recommendedTypes = useMemo(
    () => new Set((status.data?.recommendedProviders ?? []).map((provider) => provider.type)),
    [status.data?.recommendedProviders],
  );
  const groups = useMemo(() => {
    const publicEntries = catalog
      .filter((entry) => providerGroup(entry) === "public")
      .sort((left, right) => {
        const leftRecommended = recommendedTypes.has(left.type) ? 0 : 1;
        const rightRecommended = recommendedTypes.has(right.type) ? 0 : 1;
        return leftRecommended - rightRecommended || left.name.localeCompare(right.name);
      });
    return {
      public: publicEntries,
      keyed: catalog.filter((entry) => providerGroup(entry) === "keyed"),
      self: catalog.filter((entry) => providerGroup(entry) === "self"),
    };
  }, [catalog, recommendedTypes]);

  const enabledProviders = useMemo(
    () => (providers.data?.providers ?? []).filter((provider) => provider.enabled),
    [providers.data?.providers],
  );
  const readyProviders = useMemo(
    () => enabledProviders.filter((provider) => provider.ready),
    [enabledProviders],
  );
  const healthRows = useMemo(() => {
    const rows = new Map<string, HealthOverview["providers"][number]>();
    for (const row of health.data?.providers ?? []) rows.set(row.providerId, row);
    return rows;
  }, [health.data?.providers]);
  const hasGeneralWeb = useMemo(
    () => readyProviders.some((provider) => {
      const entry = catalog.find((candidate) => candidate.type === provider.type);
      return entry?.category === "general" && !["mock", "hackernews", "duckduckgo"].includes(entry.type);
    }),
    [catalog, readyProviders],
  );

  if (status.loading && !status.data) {
    return (
      <div className="mx-auto max-w-5xl space-y-4 p-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64" />
      </div>
    );
  }
  if (status.error || !status.data) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <Alert tone="error" title={t("onboarding.error")}>
          <p>{status.error?.message ?? t("states.errorTitle")}</p>
        </Alert>
      </div>
    );
  }
  if (status.data.completed || status.data.dismissed) return <Navigate to="/" replace />;

  const toggleSelected = (type: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  const addSelected = async () => {
    if (selected.size === 0) {
      setNotice(t("onboarding.noneSelected"));
      return;
    }
    setAdding(true);
    setError(null);
    setNotice(null);
    try {
      const items = [...selected].map((type) => ({
        type,
        name: catalog.find((entry) => entry.type === type)?.name,
      }));
      const created = await api.batchCreateProviders(items);
      if (created.created.length > 0) {
        await api.batchSetProviders(created.created.map((provider) => provider.id), true);
      }
      await Promise.all([providers.reload(), status.reload()]);
      setSelected(new Set());
      setNotice(t("onboarding.added", { count: created.created.length }));
      setStep(2);
    } catch (caught) {
      setError(toApiError(caught).message);
    } finally {
      setAdding(false);
    }
  };

  const runProbe = async (provider: ProviderSummary, kind: "connect" | "search") => {
    setBusyProviderId(provider.id);
    setError(null);
    setNotice(null);
    try {
      const response = await api.healthCheck({ providerId: provider.id, kind });
      const result = response.results.find((item) => item.providerId === provider.id);
      const skipped = response.skipped.find((item) => item.providerId === provider.id)?.reason;
      setProbeResults((current) => ({ ...current, [provider.id]: { result, skipped } }));
      setNotice(result ? t("onboarding.probeDone", { status: probeCauseLabel(result.cause) }) : skipped ?? t("onboarding.status.unknown"));
      await Promise.all([health.reload(), providers.reload(), status.reload()]);
    } catch (caught) {
      setError(toApiError(caught).message);
    } finally {
      setBusyProviderId(null);
      setConfirmProbe(null);
    }
  };

  const requestSearchProbe = (provider: ProviderSummary) => {
    const entry = catalog.find((candidate) => candidate.type === provider.type);
    if (entry && (entry.authType !== "none" || entry.capability === "grounded_answer")) {
      setConfirmProbe({ providerId: provider.id, name: provider.name });
      return;
    }
    void runProbe(provider, "search");
  };

  const runSearch = async () => {
    if (!query.trim() || readyProviders.length === 0) return;
    setSearching(true);
    setError(null);
    setSearchResponse(null);
    try {
      const response = await api.search({
        query: query.trim(),
        mode: "basic",
        limit: 5,
        skipCache: true,
        providers: readyProviders.map((provider) => provider.id),
      });
      setSearchResponse(response);
    } catch (caught) {
      setError(toApiError(caught).message);
    } finally {
      setSearching(false);
    }
  };

  const skip = async () => {
    setSkipping(true);
    setError(null);
    try {
      await api.dismissOnboarding();
      navigate("/");
    } catch (caught) {
      setError(toApiError(caught).message);
      setSkipping(false);
    }
  };

  const complete = async () => {
    if (!searchResponse || searchResponse.results.length === 0) return;
    setCompleting(true);
    setError(null);
    try {
      await api.completeOnboarding();
      navigate("/");
    } catch (caught) {
      setError(toApiError(caught).message);
      setCompleting(false);
    }
  };

  const confirmProvider = confirmProbe
    ? enabledProviders.find((provider) => provider.id === confirmProbe.providerId)
    : null;
  const stepLabels: Record<Step, string> = {
    1: t("onboarding.step1"),
    2: t("onboarding.step2"),
    3: t("onboarding.step3"),
  };

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
      <PageHeader
        title={t("onboarding.title")}
        description={t("onboarding.subtitle")}
        actions={
          <Button variant="outline" size="sm" onClick={() => void skip()} loading={skipping}>
            {t("onboarding.skip")}
          </Button>
        }
      />

      <div className="grid gap-2 sm:grid-cols-3">
        {([1, 2, 3] as Step[]).map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => setStep(item)}
            className={`rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
              step === item ? "border-primary bg-primary/5" : "bg-card hover:bg-accent"
            }`}
          >
            <span className="mr-2 text-xs text-muted-foreground">{item}.</span>
            {stepLabels[item]}
          </button>
        ))}
      </div>

      {error ? <Alert tone="error" title={t("states.errorTitle")}><p>{error}</p></Alert> : null}
      {notice ? <Alert tone="success" title={notice} /> : null}

      {step === 1 ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("onboarding.step1.title")}</CardTitle>
            <CardDescription>{t("onboarding.step1.desc")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <Alert tone="warning" title={t("onboarding.verticalWarning")} />

            <section className="space-y-3">
              <div>
                <h3 className="text-sm font-semibold">{t("onboarding.public.title")}</h3>
                <p className="mt-1 text-xs text-muted-foreground">{t("onboarding.public.desc")}</p>
              </div>
              <div className="grid gap-2 md:grid-cols-2">
                {groups.public.map((entry) => {
                  const installed = installedTypes.has(entry.type);
                  return (
                    <label key={entry.type} className="flex cursor-pointer items-start gap-3 rounded-lg border bg-card p-3">
                      <Checkbox
                        className="mt-0.5"
                        checked={selected.has(entry.type)}
                        disabled={installed}
                        onChange={() => toggleSelected(entry.type)}
                      />
                      <span className="min-w-0 space-y-1">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className="text-sm font-medium">{entry.name}</span>
                          {recommendedTypes.has(entry.type) ? <Badge tone="success">{t("onboarding.recommended")}</Badge> : null}
                          {installed ? <Badge tone="muted">{t("onboarding.installed")}</Badge> : null}
                        </span>
                        <span className="block text-xs text-muted-foreground">{entry.description}</span>
                        <span className="flex flex-wrap gap-1.5">
                          <Badge tone="outline">{categoryLabel(entry.category)}</Badge>
                          <Badge tone="outline">{verificationLabel(entry.verification)}</Badge>
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
              <Button onClick={() => void addSelected()} loading={adding} disabled={selected.size === 0}>
                {t("onboarding.addSelected")}
              </Button>
            </section>

            <section className="space-y-3">
              <div>
                <h3 className="text-sm font-semibold">{t("onboarding.keyed.title")}</h3>
                <p className="mt-1 text-xs text-muted-foreground">{t("onboarding.keyed.desc")}</p>
              </div>
              <div className="grid gap-2 md:grid-cols-2">
                {groups.keyed.map((entry) => (
                  <div key={entry.type} className="flex items-start justify-between gap-3 rounded-lg border bg-card p-3">
                    <div className="min-w-0 space-y-1">
                      <p className="text-sm font-medium">{entry.name}</p>
                      <p className="text-xs text-muted-foreground">{entry.description}</p>
                      <div className="flex flex-wrap gap-1.5">
                        <Badge tone="outline">{providerAuthLabel(entry.authType)}</Badge>
                        <Badge tone="outline">{verificationLabel(entry.verification)}</Badge>
                      </div>
                    </div>
                    <Button variant="outline" size="sm" onClick={() => navigate("/providers")}>
                      {t("onboarding.configure")}
                    </Button>
                  </div>
                ))}
              </div>
            </section>

            <section className="space-y-3">
              <div>
                <h3 className="text-sm font-semibold">{t("onboarding.selfHosted.title")}</h3>
                <p className="mt-1 text-xs text-muted-foreground">{t("onboarding.selfHosted.desc")}</p>
              </div>
              <div className="grid gap-2 md:grid-cols-2">
                {groups.self.map((entry) => (
                  <div key={entry.type} className="flex items-start justify-between gap-3 rounded-lg border bg-card p-3">
                    <div className="min-w-0 space-y-1">
                      <p className="text-sm font-medium">{entry.name}</p>
                      <p className="text-xs text-muted-foreground">{entry.description}</p>
                      <Badge tone="outline">{verificationLabel(entry.verification)}</Badge>
                    </div>
                    <Button variant="outline" size="sm" onClick={() => navigate("/providers")}>
                      {t("onboarding.configure")}
                    </Button>
                  </div>
                ))}
              </div>
            </section>
          </CardContent>
        </Card>
      ) : null}

      {step === 2 ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("onboarding.step2.title")}</CardTitle>
            <CardDescription>{t("onboarding.step2.desc")}</CardDescription>
          </CardHeader>
          <CardContent>
            {enabledProviders.length === 0 ? (
              <EmptyState
                icon={Search}
                title={t("onboarding.noReady")}
                action={<Button size="sm" variant="outline" onClick={() => setStep(1)}>{t("onboarding.step1")}</Button>}
              />
            ) : (
              <div className="space-y-2">
                {enabledProviders.map((provider) => {
                  const entry = catalog.find((candidate) => candidate.type === provider.type);
                  const row = healthRows.get(provider.id);
                  const probe = probeResults[provider.id];
                  const configured = entry?.authType === "none" || provider.keyCount > 0;
                  const statusText = probe?.result
                    ? probeCauseLabel(probe.result.cause)
                    : probe?.skipped ?? (row ? runtimeLabel(row.runtime) : t("onboarding.never"));
                  return (
                    <div key={provider.id} className="rounded-lg border bg-card p-3" data-testid={`onboarding-provider-${provider.id}`}>
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-medium">{provider.name}</p>
                          <p className="text-xs text-muted-foreground">{entry?.name ?? provider.type}</p>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          <Badge tone={configured ? "success" : "destructive"}>{configured ? t("onboarding.configured") : t("onboarding.notConfigured")}</Badge>
                          <Badge tone={provider.ready ? "success" : "muted"}>{provider.ready ? t("onboarding.ready") : t("onboarding.notReady")}</Badge>
                          <Badge tone="outline">{statusText}</Badge>
                        </div>
                      </div>
                      <div className="mt-3 grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
                        <p>{t("onboarding.lastProbe")}: {row?.lastCheckedAt ? formatDateTime(row.lastCheckedAt) : t("onboarding.never")}</p>
                        <p>{t("onboarding.lastSearch")}: {row && row.searchCalls > 0 ? `${formatNumber(row.searchCalls)} · ${row.lastSuccessAt ? formatDateTime(row.lastSuccessAt) : t("onboarding.none")}` : t("onboarding.none")}</p>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button size="sm" variant="outline" loading={busyProviderId === provider.id} onClick={() => void runProbe(provider, "connect")}>
                          {t("onboarding.connectCheck")}
                        </Button>
                        <Button size="sm" variant="outline" loading={busyProviderId === provider.id} onClick={() => requestSearchProbe(provider)}>
                          {t("onboarding.searchCheck")}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      ) : null}

      {step === 3 ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("onboarding.step3.title")}</CardTitle>
            <CardDescription>{t("onboarding.step3.desc")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {readyProviders.length === 0 ? <Alert tone="warning" title={t("onboarding.noReady")} /> : null}
            {!hasGeneralWeb ? <Alert tone="warning" title={t("onboarding.noGeneralWarning")} /> : null}
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <Field label={t("onboarding.query")} htmlFor="onboarding-query" className="flex-1">
                <Input
                  id="onboarding-query"
                  value={query}
                  maxLength={500}
                  placeholder={t("onboarding.queryPlaceholder")}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void runSearch();
                  }}
                />
              </Field>
              <Button onClick={() => void runSearch()} loading={searching} disabled={!query.trim() || readyProviders.length === 0}>
                {t("onboarding.runSearch")}
              </Button>
            </div>

            {searchResponse ? (
              <div className="space-y-3 rounded-lg border bg-muted/20 p-3" data-testid="onboarding-search-result">
                <div className="grid gap-2 text-xs sm:grid-cols-3">
                  <p><span className="text-muted-foreground">{t("onboarding.results")}:</span> {formatNumber(searchResponse.results.length)}</p>
                  <p><span className="text-muted-foreground">{t("onboarding.duration")}:</span> {formatMs(searchResponse.stats.timing.totalMs)}</p>
                  <p><span className="text-muted-foreground">{searchResponse.stats.cached ? t("onboarding.cached") : t("onboarding.notCached")}</span></p>
                </div>
                <div>
                  <p className="text-xs font-medium text-muted-foreground">{t("onboarding.actualSources")}</p>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {searchResponse.stats.providers.map((provider) => (
                      <Badge key={provider.providerId} tone={provider.ok ? "success" : "destructive"}>
                        {provider.providerName} · {provider.ok ? formatNumber(provider.resultCount) : provider.errorCode ?? "error"}
                      </Badge>
                    ))}
                  </div>
                </div>
                {searchResponse.failedSources.length > 0 || searchResponse.errors.length > 0 ? (
                  <Alert tone="warning" title={t("onboarding.failedSources")}>
                    <p>{searchResponse.failedSources.map((source) => `${source.id}:${source.code}`).join(" · ")}</p>
                    <p>{searchResponse.errors.map((source) => `${source.providerName}:${source.code}`).join(" · ")}</p>
                  </Alert>
                ) : null}
                <Button onClick={() => void complete()} loading={completing} disabled={searchResponse.results.length === 0}>
                  {t("onboarding.complete")}
                </Button>
                {searchResponse.results.length === 0 ? <p className="text-xs text-muted-foreground">{t("onboarding.searchFirst")}</p> : null}
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <div className="flex items-center justify-between">
        <Button variant="outline" size="sm" disabled={step === 1} onClick={() => setStep((current) => (current === 3 ? 2 : 1))}>
          {t("onboarding.back")}
        </Button>
        {step < 3 ? (
          <Button size="sm" onClick={() => setStep((current) => (current === 1 ? 2 : 3))}>
            {t("onboarding.next")}
          </Button>
        ) : null}
      </div>

      <Dialog
        open={confirmProbe !== null}
        onClose={() => setConfirmProbe(null)}
        title={t("onboarding.confirmSearchTitle")}
        description={t("onboarding.confirmSearchDesc", { name: confirmProvider?.name ?? confirmProbe?.name ?? "" })}
        footer={
          <>
            <Button variant="outline" size="sm" onClick={() => setConfirmProbe(null)}>{t("common.cancel")}</Button>
            <Button
              size="sm"
              loading={busyProviderId === confirmProbe?.providerId}
              onClick={() => {
                if (confirmProvider) void runProbe(confirmProvider, "search");
              }}
            >
              {t("onboarding.confirmSearch")}
            </Button>
          </>
        }
      >
        <p className="text-xs text-muted-foreground">{t("providers.health.paidWarning")}</p>
      </Dialog>
    </div>
  );
}
