import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  AlertTriangle,
  ArrowUpRight,
  CircuitBoard,
  KeyRound,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import { api, toApiError, type ApiError } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import { useAsyncData, useDocumentTitle } from "../../lib/hooks";
import {
  categoryLabels,
  implementationLabels,
  keyStrategyLabels,
  providerAuthLabels,
  t,
  verificationLabels,
} from "../../lib/i18n";
import type {
  GroupInput,
  ProviderCatalogEntry,
  ProviderCategory,
  ProviderSummary,
  ProviderTestResult,
  SearchGroup,
} from "../../lib/types";
import { ConfirmDialog, Dialog, Sheet } from "../../components/overlay";
import { Table, TBody, TD, TH, THead, TR } from "../../components/table";
import { useToast } from "../../components/toast";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  Field,
  Input,
  PageHeader,
  SectionHeader,
  Skeleton,
  Switch,
  Textarea,
} from "../../components/ui";
import { ProviderForm } from "./form";
import { ProviderKeysPanel, TestResultDialog } from "./keys-panel";

const categoryOrder: ProviderCategory[] = ["general", "ai", "compat", "custom"];

const categoryTone: Record<ProviderCategory, "default" | "info" | "warning" | "muted"> = {
  general: "default",
  ai: "info",
  compat: "warning",
  custom: "muted",
};

const implementationTone = {
  builtin: "success",
  generic: "info",
  planned: "muted",
  unavailable: "muted",
} as const;

export function ProvidersPage() {
  useDocumentTitle(t("providers.title"));
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const focusId = searchParams.get("focus");
  const [filter, setFilter] = useState("");
  const [formState, setFormState] = useState<{
    provider: ProviderSummary | null;
    preset: ProviderCatalogEntry | null;
  } | null>(null);
  const [keyProvider, setKeyProvider] = useState<ProviderSummary | null>(null);
  const [testState, setTestState] = useState<{ title: string; result: ProviderTestResult } | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ProviderSummary | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [groupForm, setGroupForm] = useState<SearchGroup | "new" | null>(null);
  const [deletingGroup, setDeletingGroup] = useState<SearchGroup | null>(null);
  const [groupDeletePending, setGroupDeletePending] = useState(false);

  const providers = useAsyncData((signal) => api.providers(signal), []);
  const groups = useAsyncData((signal) => api.groups(signal), []);

  const configuredByType = useMemo(() => {
    const map = new Map<string, number>();
    for (const provider of providers.data?.providers ?? []) {
      map.set(provider.type, (map.get(provider.type) ?? 0) + 1);
    }
    return map;
  }, [providers.data]);

  const catalogGroups = useMemo(() => {
    const filtered = (providers.data?.catalog ?? []).filter((entry) => {
      if (!filter.trim()) return true;
      const needle = filter.trim().toLowerCase();
      return (
        entry.name.toLowerCase().includes(needle) ||
        entry.type.toLowerCase().includes(needle) ||
        entry.description.toLowerCase().includes(needle)
      );
    });
    return categoryOrder
      .map((category) => ({
        category,
        entries: filtered.filter((entry) => entry.category === category),
      }))
      .filter((group) => group.entries.length > 0);
  }, [providers.data, filter]);

  const runtimeById = useMemo(() => {
    const map = new Map<string, NonNullable<typeof providers.data>["status"][number]>();
    for (const snapshot of providers.data?.status ?? []) map.set(snapshot.providerId, snapshot);
    return map;
  }, [providers.data]);

  useEffect(() => {
    if (!focusId || !providers.data) return;
    const element = document.getElementById(`provider-${focusId}`);
    if (element) {
      element.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [focusId, providers.data]);

  const adapters = providers.data?.adapters ?? [];

  const canAdd = (entry: ProviderCatalogEntry): boolean => {
    if (entry.implementation === "planned" || entry.implementation === "unavailable") return false;
    if (adapters.length > 0) return adapters.includes(entry.type);
    return entry.implementation === "builtin";
  };

  const runTest = async (provider: ProviderSummary) => {
    setTestingId(provider.id);
    try {
      const result = await api.testProvider(provider.id);
      setTestState({ title: t("providers.test.title", { name: provider.name }), result });
      providers.reload();
    } catch (caught) {
      const apiError = toApiError(caught);
      toast.error({ title: apiError.message, description: apiError.code });
    } finally {
      setTestingId(null);
    }
  };

  const toggleEnabled = async (provider: ProviderSummary, enabled: boolean) => {
    setTogglingId(provider.id);
    try {
      await api.updateProvider(provider.id, { enabled });
      toast.success({ title: `${provider.name} · ${enabled ? t("common.enabled") : t("common.disabled")}` });
      providers.reload();
    } catch (caught) {
      const apiError = toApiError(caught);
      toast.error({ title: apiError.message, description: apiError.code });
    } finally {
      setTogglingId(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setDeletePending(true);
    try {
      await api.deleteProvider(deleting.id);
      toast.success({ title: t("providers.form.deleted") });
      setDeleting(null);
      providers.reload();
    } catch (caught) {
      const apiError = toApiError(caught);
      toast.error({ title: apiError.message, description: apiError.code });
    } finally {
      setDeletePending(false);
    }
  };

  const clearFocus = () => {
    const next = new URLSearchParams(searchParams);
    next.delete("focus");
    setSearchParams(next, { replace: true });
  };

  return (
    <div className="space-y-7">
      <PageHeader
        title={t("providers.title")}
        description={t("providers.subtitle")}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={providers.reload} disabled={providers.loading}>
              <RefreshCw className={providers.loading ? "animate-spin" : undefined} aria-hidden />
              {t("common.refresh")}
            </Button>
            <Button size="sm" onClick={() => setFormState({ provider: null, preset: null })}>
              <Plus aria-hidden />
              {t("providers.add")}
            </Button>
          </>
        }
      />

      {providers.error ? (
        <Alert
          tone="error"
          title={t("states.errorTitle")}
          action={
            <Button size="sm" variant="outline" onClick={providers.reload}>
              {t("common.retry")}
            </Button>
          }
        >
          <p className="font-mono">{providers.error.code}</p>
          <p>{providers.error.message}</p>
        </Alert>
      ) : null}

      {providers.loading && !providers.data ? (
        <div className="space-y-3">
          <Skeleton className="h-6 w-40" />
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }).map((_, index) => (
              <Skeleton key={index} className="h-40" />
            ))}
          </div>
        </div>
      ) : null}

      {providers.data ? (
        <>
          <section className="space-y-3">
            <SectionHeader
              title={t("providers.catalog.title")}
              description={t("providers.catalog.desc")}
              actions={
                <Input
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder={t("providers.catalog.searchPlaceholder")}
                  className="h-8 w-48 text-xs"
                  aria-label={t("providers.catalog.searchPlaceholder")}
                />
              }
            />

            {catalogGroups.length === 0 ? (
              <EmptyState title={t("common.empty")} description={t("states.emptyDesc")} />
            ) : (
              catalogGroups.map(({ category, entries }) => (
                <div key={category} className="space-y-2">
                  <div className="flex items-center gap-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {categoryLabels[category]}
                    </h3>
                    <Badge tone="outline">{entries.length}</Badge>
                  </div>
                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {entries.map((entry) => {
                      const configured = configuredByType.get(entry.type) ?? 0;
                      const addable = canAdd(entry);
                      return (
                        <Card key={entry.type} className="flex flex-col">
                          <CardContent className="flex h-full flex-col gap-2.5 p-4">
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <p className="truncate text-sm font-medium">{entry.name}</p>
                                <p className="truncate font-mono text-[10px] text-muted-foreground">{entry.type}</p>
                              </div>
                              <Badge tone={categoryTone[entry.category]}>{categoryLabels[entry.category]}</Badge>
                            </div>
                            <p className="line-clamp-3 text-[11px] leading-relaxed text-muted-foreground">
                              {entry.description}
                            </p>
                            {entry.notes ? (
                              <p className="line-clamp-2 text-[10px] leading-relaxed text-muted-foreground/80">
                                {entry.notes}
                              </p>
                            ) : null}
                            <div className="flex flex-wrap items-center gap-1">
                              <Badge tone={implementationTone[entry.implementation]}>
                                {implementationLabels[entry.implementation]}
                              </Badge>
                              <Badge tone={entry.verification === "live_tested" ? "success" : "outline"}>
                                {verificationLabels[entry.verification]}
                              </Badge>
                              <Badge tone="muted">{providerAuthLabels[entry.authType]}</Badge>
                              <Badge tone="outline">
                                {entry.capability === "grounded_answer"
                                  ? t("lab.capability.grounded")
                                  : t("lab.capability.raw")}
                              </Badge>
                              {entry.credentialKind === "pair" ? (
                                <Badge tone="outline">{t("providers.catalog.pairCredential")}</Badge>
                              ) : null}
                              {entry.authType === "none" ? (
                                <Badge tone="success">{t("providers.catalog.keyless")}</Badge>
                              ) : null}
                              {configured > 0 ? (
                                <Badge tone="info">{t("providers.catalog.configured", { count: configured })}</Badge>
                              ) : null}
                              {entry.capability === "grounded_answer" ? (
                                <Badge tone="outline">{t("lab.capability.grounded")}</Badge>
                              ) : null}
                            </div>
                            <div className="mt-auto flex items-center justify-between gap-2 pt-1">
                              {entry.docsUrl ? (
                                <a
                                  href={entry.docsUrl}
                                  target="_blank"
                                  rel="noreferrer noopener"
                                  className="inline-flex items-center gap-0.5 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                                >
                                  {t("providers.catalog.docs")}
                                  <ArrowUpRight className="size-3" aria-hidden />
                                </a>
                              ) : (
                                <span />
                              )}
                              <Button
                                size="sm"
                                variant={addable ? "outline" : "ghost"}
                                disabled={!addable}
                                title={
                                  !addable
                                    ? entry.implementation === "unavailable"
                                      ? t("providers.catalog.unavailableHint")
                                      : t("providers.catalog.disabledHint")
                                    : undefined
                                }
                                onClick={() => setFormState({ provider: null, preset: entry })}
                              >
                                <Plus aria-hidden />
                                {t("providers.catalog.add")}
                              </Button>
                            </div>
                          </CardContent>
                        </Card>
                      );
                    })}
                  </div>
                </div>
              ))
            )}
          </section>

          <section className="space-y-3">
            <SectionHeader
              title={t("providers.list.title")}
              description={t("providers.list.desc")}
              actions={
                focusId ? (
                  <Button size="sm" variant="ghost" onClick={clearFocus}>
                    {t("common.close")}
                  </Button>
                ) : null
              }
            />

            {providers.data.providers.length === 0 ? (
              <EmptyState
                icon={Server}
                title={t("providers.list.empty")}
                description={t("providers.list.emptyDesc")}
                action={
                  <Button size="sm" onClick={() => setFormState({ provider: null, preset: null })}>
                    <Plus aria-hidden />
                    {t("providers.add")}
                  </Button>
                }
              />
            ) : (
              <>
                <div className="space-y-2 md:hidden">
                  {providers.data.providers.map((provider) => {
                    const snapshot = runtimeById.get(provider.id);
                    return (
                      <Card
                        key={provider.id}
                        id={`provider-mobile-${provider.id}`}
                        className={focusId === provider.id ? "border-foreground/40 shadow-md" : undefined}
                      >
                        <CardContent className="space-y-2.5 p-4">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="truncate font-medium">{provider.name}</p>
                              <p className="font-mono text-[10px] text-muted-foreground">{provider.type}</p>
                            </div>
                            <div className="flex items-center gap-2">
                              {provider.circuitOpen ? (
                                <Badge tone="warning">
                                  <AlertTriangle className="size-3" aria-hidden />
                                  {t("providers.list.circuitOpen")}
                                </Badge>
                              ) : null}
                              <Switch
                                checked={provider.enabled}
                                onChange={(value) => void toggleEnabled(provider, value)}
                                disabled={togglingId === provider.id}
                                label={t("common.enable")}
                              />
                            </div>
                          </div>
                          <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                            <Badge tone={provider.healthyKeyCount > 0 ? "success" : "muted"}>
                              <KeyRound className="size-3" aria-hidden />
                              {provider.healthyKeyCount}/{provider.keyCount}
                            </Badge>
                            <Badge tone="outline">{keyStrategyLabels[provider.keyStrategy]}</Badge>
                            <span>P{provider.priority}</span>
                            <span>W{provider.weight}</span>
                            {snapshot ? (
                              <span>
                                {snapshot.healthy ? t("common.success") : t("common.failed")}
                              </span>
                            ) : null}
                          </div>
                          <div className="flex flex-wrap gap-1.5">
                            <Button size="sm" variant="outline" onClick={() => setKeyProvider(provider)}>
                              <KeyRound aria-hidden />
                              {t("providers.list.keys")}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              loading={testingId === provider.id}
                              onClick={() => void runTest(provider)}
                            >
                              {t("providers.list.test")}
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setFormState({ provider, preset: null })}>
                              <Pencil aria-hidden />
                              {t("common.edit")}
                            </Button>
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>

                <div className="hidden md:block">
                  <Table minWidth="min-w-[960px]" caption={t("providers.list.title")}>
                    <THead>
                      <tr>
                        <TH>{t("common.name")}</TH>
                        <TH>{t("common.status")}</TH>
                        <TH>{t("providers.list.healthyKeys")}</TH>
                        <TH>{t("providers.form.keyStrategy")}</TH>
                        <TH>{t("common.priority")} / {t("common.weight")}</TH>
                        <TH>{t("providers.list.circuitClosed")}</TH>
                        <TH>{t("common.updatedAt")}</TH>
                        <TH className="text-right">{t("common.actions")}</TH>
                      </tr>
                    </THead>
                    <TBody>
                      {providers.data.providers.map((provider) => {
                        const snapshot = runtimeById.get(provider.id);
                        return (
                          <TR
                            key={provider.id}
                            id={`provider-${provider.id}`}
                            selected={focusId === provider.id}
                          >
                            <TD>
                              <div className="min-w-0">
                                <p className="truncate font-medium">{provider.name}</p>
                                <p className="font-mono text-[10px] text-muted-foreground">{provider.type}</p>
                                {provider.baseUrl ? (
                                  <p className="truncate text-[10px] text-muted-foreground">{provider.baseUrl}</p>
                                ) : null}
                              </div>
                            </TD>
                            <TD>
                              <div className="flex items-center gap-2">
                                <Switch
                                  checked={provider.enabled}
                                  onChange={(value) => void toggleEnabled(provider, value)}
                                  disabled={togglingId === provider.id}
                                  label={t("common.enable")}
                                />
                                <span className="text-[11px] text-muted-foreground">
                                  {provider.enabled ? t("common.enabled") : t("common.disabled")}
                                </span>
                              </div>
                            </TD>
                            <TD>
                              <Badge tone={provider.healthyKeyCount > 0 ? "success" : "muted"}>
                                {provider.healthyKeyCount}/{provider.keyCount}
                              </Badge>
                            </TD>
                            <TD className="text-xs">{keyStrategyLabels[provider.keyStrategy]}</TD>
                            <TD className="font-mono text-xs tabular-nums">
                              {provider.priority} / {provider.weight}
                            </TD>
                            <TD>
                              {snapshot?.circuitOpen ? (
                                <div className="space-y-0.5">
                                  <Badge tone="warning">
                                    <ShieldAlert className="size-3" aria-hidden />
                                    {t("providers.list.circuitOpen")}
                                  </Badge>
                                  {snapshot.circuitOpenUntil ? (
                                    <p className="text-[10px] text-muted-foreground">
                                      {formatDateTime(snapshot.circuitOpenUntil)}
                                    </p>
                                  ) : null}
                                </div>
                              ) : (
                                <Badge tone="success">{t("providers.list.circuitClosed")}</Badge>
                              )}
                            </TD>
                            <TD className="whitespace-nowrap text-[11px] text-muted-foreground">
                              {formatDateTime(provider.updatedAt)}
                            </TD>
                            <TD>
                              <div className="flex items-center justify-end gap-0.5">
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => setKeyProvider(provider)}
                                  title={t("providers.list.keys")}
                                >
                                  <KeyRound aria-hidden />
                                  Key
                                </Button>
                                <Button
                                  size="icon-sm"
                                  variant="ghost"
                                  title={t("providers.list.test")}
                                  aria-label={t("providers.list.test")}
                                  loading={testingId === provider.id}
                                  onClick={() => void runTest(provider)}
                                >
                                  {testingId === provider.id ? null : <CircuitBoard aria-hidden />}
                                </Button>
                                <Button
                                  size="icon-sm"
                                  variant="ghost"
                                  title={t("common.edit")}
                                  aria-label={t("common.edit")}
                                  onClick={() => setFormState({ provider, preset: null })}
                                >
                                  <Pencil aria-hidden />
                                </Button>
                                <Button
                                  size="icon-sm"
                                  variant="ghost"
                                  className="text-destructive hover:text-destructive"
                                  title={t("common.delete")}
                                  aria-label={t("common.delete")}
                                  onClick={() => setDeleting(provider)}
                                >
                                  <Trash2 aria-hidden />
                                </Button>
                              </div>
                            </TD>
                          </TR>
                        );
                      })}
                    </TBody>
                  </Table>
                </div>
              </>
            )}
          </section>

          <section className="space-y-3">
            <SectionHeader
              title={t("providers.groups.title")}
              description={t("providers.groups.desc")}
              actions={
                <Button size="sm" variant="outline" onClick={() => setGroupForm("new")}>
                  <Plus aria-hidden />
                  {t("providers.groups.add")}
                </Button>
              }
            />

            {groups.error ? (
              <Alert
                tone="warning"
                title={`${groups.error.code}: ${groups.error.message}`}
                action={
                  <Button size="sm" variant="outline" onClick={groups.reload}>
                    {t("common.retry")}
                  </Button>
                }
              />
            ) : groups.loading && !groups.data ? (
              <Skeleton className="h-24" />
            ) : groups.data && groups.data.length === 0 ? (
              <EmptyState title={t("providers.groups.empty")} description={t("states.emptyDesc")} />
            ) : groups.data ? (
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {groups.data.map((group) => (
                  <Card key={group.id}>
                    <CardContent className="space-y-2 p-4">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{group.name}</p>
                          <p className="text-[11px] text-muted-foreground">
                            {t("providers.groups.providerCount", { count: group.providerIds.length })}
                          </p>
                        </div>
                        <div className="flex gap-0.5">
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label={t("common.edit")}
                            onClick={() => setGroupForm(group)}
                          >
                            <Pencil aria-hidden />
                          </Button>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            className="text-destructive hover:text-destructive"
                            aria-label={t("common.delete")}
                            onClick={() => setDeletingGroup(group)}
                          >
                            <Trash2 aria-hidden />
                          </Button>
                        </div>
                      </div>
                      {group.description ? (
                        <p className="text-[11px] leading-relaxed text-muted-foreground">{group.description}</p>
                      ) : null}
                      <div className="flex flex-wrap gap-1">
                        {group.providerIds.length === 0 ? (
                          <span className="text-[11px] text-muted-foreground">{t("common.empty")}</span>
                        ) : (
                          group.providerIds.map((id) => {
                            const provider = providers.data?.providers.find((item) => item.id === id);
                            return (
                              <Badge key={id} tone="outline">
                                {provider?.name ?? id}
                              </Badge>
                            );
                          })
                        )}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            ) : null}
          </section>
        </>
      ) : null}

      {formState ? (
        <ProviderForm
          key={`${formState.provider?.id ?? "new"}-${formState.preset?.type ?? "none"}`}
          open
          onClose={() => setFormState(null)}
          provider={formState.provider}
          preset={formState.preset}
          catalog={providers.data?.catalog ?? []}
          adapters={adapters}
          onSaved={() => {
            toast.success({ title: t("providers.form.saved") });
            providers.reload();
          }}
        />
      ) : null}

      <Sheet
        open={keyProvider !== null}
        onClose={() => setKeyProvider(null)}
        title={t("providers.keys.title", { name: keyProvider?.name ?? "" })}
        description={t("providers.keys.desc")}
        size="xl"
      >
        {keyProvider ? (
          <div className="space-y-4">
            <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
              <div className="rounded-md border bg-muted/25 p-2.5">
                <p>{t("providers.form.type")}</p>
                <p className="font-mono text-foreground">{keyProvider.type}</p>
              </div>
              <div className="rounded-md border bg-muted/25 p-2.5">
                <p>{t("providers.list.healthyKeys")}</p>
                <p className="font-mono text-foreground">
                  {keyProvider.healthyKeyCount} / {keyProvider.keyCount}
                </p>
              </div>
              <div className="rounded-md border bg-muted/25 p-2.5">
                <p>{t("providers.form.keyStrategy")}</p>
                <p className="text-foreground">{keyStrategyLabels[keyProvider.keyStrategy]}</p>
              </div>
            </div>
            <ProviderKeysPanel providerId={keyProvider.id} providerName={keyProvider.name} />
          </div>
        ) : null}
      </Sheet>

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={confirmDelete}
        title={t("common.deleteConfirmTitle")}
        description={`${deleting?.name ?? ""} — ${t("providers.list.deleteConfirm")}`}
        confirmLabel={t("common.delete")}
        loading={deletePending}
      />

      <TestResultDialog
        open={testState !== null}
        onClose={() => setTestState(null)}
        title={testState?.title ?? ""}
        result={testState?.result ?? null}
      />

      <ConfirmDialog
        open={deletingGroup !== null}
        onClose={() => setDeletingGroup(null)}
        onConfirm={async () => {
          if (!deletingGroup) return;
          setGroupDeletePending(true);
          try {
            await api.deleteGroup(deletingGroup.id);
            toast.success({ title: t("providers.groups.deleted") });
            setDeletingGroup(null);
            groups.reload();
          } catch (caught) {
            const apiError = toApiError(caught);
            toast.error({ title: apiError.message, description: apiError.code });
          } finally {
            setGroupDeletePending(false);
          }
        }}
        title={t("common.deleteConfirmTitle")}
        description={`${deletingGroup?.name ?? ""} — ${t("providers.groups.deleteConfirm")}`}
        confirmLabel={t("common.delete")}
        loading={groupDeletePending}
      />

      {groupForm ? (
        <GroupDialog
          open
          onClose={() => setGroupForm(null)}
          group={groupForm === "new" ? null : groupForm}
          providers={providers.data?.providers ?? []}
          onSaved={() => {
            toast.success({ title: t("providers.groups.saved") });
            groups.reload();
            setGroupForm(null);
          }}
        />
      ) : null}
    </div>
  );
}

function GroupDialog({
  open,
  onClose,
  group,
  providers,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  group: SearchGroup | null;
  providers: ProviderSummary[];
  onSaved: () => void;
}) {
  const [name, setName] = useState(group?.name ?? "");
  const [description, setDescription] = useState(group?.description ?? "");
  const [selected, setSelected] = useState<string[]>(group?.providerIds ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if (!name.trim()) {
      setNameError(t("providers.groups.nameRequired"));
      return;
    }
    setNameError(null);
    setSaving(true);
    try {
      const payload: GroupInput = {
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        providerIds: selected,
      };
      if (group) {
        await api.updateGroup(group.id, payload);
      } else {
        await api.createGroup(payload);
      }
      onSaved();
    } catch (caught) {
      setError(toApiError(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={group ? t("common.edit") : t("providers.groups.add")}
      description={t("providers.groups.desc")}
      size="md"
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>
            {t("common.cancel")}
          </Button>
          <Button size="sm" loading={saving} onClick={() => void submit()}>
            {saving ? t("common.saving") : t("common.save")}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {error ? (
          <Alert tone="error" title={`${error.code}: ${error.message}`}>
            {error.details ? <span className="font-mono">{JSON.stringify(error.details)}</span> : null}
          </Alert>
        ) : null}
        <Field
          label={t("providers.groups.name")}
          htmlFor="group-name"
          required
          error={nameError ?? undefined}
        >
          <Input
            id="group-name"
            value={name}
            maxLength={80}
            onChange={(event) => setName(event.target.value)}
            placeholder="fast-search"
          />
        </Field>
        <Field label={t("providers.groups.description")} htmlFor="group-desc">
          <Textarea
            id="group-desc"
            rows={2}
            maxLength={300}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
        <Field label={t("providers.groups.members")} hint={t("providers.groups.providerCount", { count: selected.length })}>
          <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border p-2">
            {providers.length === 0 ? (
              <p className="p-2 text-xs text-muted-foreground">{t("providers.list.empty")}</p>
            ) : (
              providers.map((provider) => (
                <label
                  key={provider.id}
                  className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-accent/50"
                >
                  <input
                    type="checkbox"
                    className="size-4 rounded border-input accent-primary"
                    checked={selected.includes(provider.id)}
                    onChange={(event) =>
                      setSelected((current) =>
                        event.target.checked
                          ? [...current, provider.id]
                          : current.filter((id) => id !== provider.id),
                      )
                    }
                  />
                  <span className="min-w-0 flex-1 truncate">{provider.name}</span>
                  <span className="font-mono text-[10px] text-muted-foreground">{provider.type}</span>
                </label>
              ))
            )}
          </div>
        </Field>
      </div>
    </Dialog>
  );
}

// (helpers intentionally live in lib/format)
