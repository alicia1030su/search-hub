import { useMemo, useState, type FormEvent } from "react";
import {
  Check,
  Clipboard,
  Download,
  FileCode2,
  Plug,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import { api, toApiError, type ApiError } from "../lib/api";
import { downloadText, formatDateTime, formatUptime } from "../lib/format";
import { useAsyncData, useCopy, useDocumentTitle } from "../lib/hooks";
import { t } from "../lib/i18n";
import type { AccessTokenSummary, SkillEntry } from "../lib/types";
import { ConfirmDialog, Dialog } from "../components/overlay";
import { Table, TBody, TD, TH, THead, TR } from "../components/table";
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
  SectionHeader,
  Skeleton,
  Switch,
} from "../components/ui";

const SCOPE_OPTIONS = [
  { value: "search", labelKey: "integrations.tokens.scope.search" as const },
  { value: "mcp:use", labelKey: "integrations.tokens.scope.mcp" as const },
  // GET /api/providers requires this scope; without it the MCP
  // get_search_sources tool returns a 403 for stdio clients.
  { value: "sources:read", labelKey: "integrations.tokens.scope.sources" as const },
];

function CodeBlock({
  code,
  language,
  onCopy,
}: {
  code: string;
  language?: string;
  onCopy?: () => void;
}) {
  return (
    <div className="relative rounded-md border bg-muted/35">
      <div className="flex items-center justify-between gap-2 border-b px-2.5 py-1.5">
        <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
          {language ?? "text"}
        </span>
        {onCopy ? (
          <button
            type="button"
            onClick={onCopy}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Clipboard className="size-3" aria-hidden />
            {t("common.copy")}
          </button>
        ) : null}
      </div>
      <pre className="max-h-64 overflow-auto p-3 font-mono text-[11px] leading-relaxed">{code}</pre>
    </div>
  );
}

export function IntegrationsPage() {
  useDocumentTitle(t("integrations.title"));
  const toast = useToast();
  const copy = useCopy();
  const health = useAsyncData((signal) => api.health(signal), []);
  const mcpInfo = useAsyncData((signal) => api.mcpInfo(signal), []);
  const tokens = useAsyncData((signal) => api.tokens(signal), []);
  const skills = useAsyncData((signal) => api.skills(signal), []);

  const [tokenDialog, setTokenDialog] = useState(false);
  const [revealed, setRevealed] = useState<{ token: string; name: string } | null>(null);
  const [revoking, setRevoking] = useState<AccessTokenSummary | null>(null);
  const [revokePending, setRevokePending] = useState(false);
  const [skillPreview, setSkillPreview] = useState<SkillEntry | null>(null);
  const [tokenFilter, setTokenFilter] = useState("");

  const endpoint = useMemo(() => {
    const reported = mcpInfo.data?.endpoint;
    if (reported) {
      try {
        return new URL(reported, window.location.origin).toString();
      } catch {
        // fall through to the browser origin
      }
    }
    return `${window.location.origin.replace(/\/+$/, "")}/mcp`;
  }, [mcpInfo.data]);

  const publicBase = window.location.origin;

  const visibleTokens = useMemo(() => {
    const list = tokens.data ?? [];
    if (!tokenFilter.trim()) return list;
    const needle = tokenFilter.trim().toLowerCase();
    return list.filter(
      (token) => token.name.toLowerCase().includes(needle) || token.prefix.toLowerCase().includes(needle),
    );
  }, [tokens.data, tokenFilter]);

  const revoke = async () => {
    if (!revoking) return;
    setRevokePending(true);
    try {
      await api.revokeToken(revoking.id);
      toast.success({ title: t("integrations.tokens.revokedToast") });
      setRevoking(null);
      tokens.reload();
    } catch (caught) {
      const apiError = toApiError(caught);
      toast.error({ title: apiError.message, description: apiError.code });
    } finally {
      setRevokePending(false);
    }
  };

  const claudeConfig = `{
  "mcpServers": {
    "search-hub": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "${endpoint}",
        "--header",
        "Authorization: Bearer <SEARCH_HUB_TOKEN>"
      ]
    }
  }
}`;

  const cursorConfig = `{
  "mcpServers": {
    "search-hub": {
      "url": "${endpoint}",
      "headers": {
        "Authorization": "Bearer <SEARCH_HUB_TOKEN>"
      }
    }
  }
}`;

  const httpExample = `curl -X POST "${endpoint}" \\
  -H "Content-Type: application/json" \\
  -H "Accept: application/json, text/event-stream" \\
  -H "Authorization: Bearer <SEARCH_HUB_TOKEN>" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`;

  const stdioCommand = `SEARCH_HUB_URL=${publicBase} \\
SEARCH_HUB_TOKEN=<SEARCH_HUB_TOKEN> \\
pnpm --filter @search-hub/mcp exec tsx src/stdio.ts`;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("integrations.title")}
        description={t("integrations.subtitle")}
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              health.reload();
              mcpInfo.reload();
              tokens.reload();
              skills.reload();
            }}
          >
            <RefreshCw aria-hidden />
            {t("common.refresh")}
          </Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="min-w-0">
              <CardTitle className="flex items-center gap-1.5">
                <Plug className="size-4" aria-hidden />
                {t("integrations.endpoint.title")}
              </CardTitle>
              <CardDescription>{t("integrations.endpoint.desc")}</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex items-center gap-1.5 rounded-md border bg-muted/30 px-2.5 py-2">
              <code className="min-w-0 flex-1 break-all font-mono text-[11px]">{endpoint}</code>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t("integrations.endpoint.copy")}
                onClick={() => {
                  void copy
                    .copy(endpoint)
                    .then((ok) => toast[ok ? "success" : "error"]({
                      title: ok ? t("integrations.copyEndpoint") : t("common.copyFailed"),
                    }));
                }}
              >
                {copy.copied ? <Check aria-hidden /> : <Clipboard aria-hidden />}
              </Button>
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {t("integrations.config.tokenPlaceholder")} · {window.location.origin}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle className="flex items-center gap-1.5">
                <Server className="size-4" aria-hidden />
                {t("integrations.status.title")}
              </CardTitle>
              <CardDescription>{t("integrations.status.desc")}</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-2.5">
            <div className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
              <div>
                <p className="text-xs font-medium">{t("integrations.status.health")}</p>
                {health.error ? (
                  <p className="text-[10px] text-destructive">{health.error.message}</p>
                ) : (
                  <p className="text-[10px] text-muted-foreground">
                    {health.data ? `v${health.data.version} · ${formatUptime(health.data.uptimeSeconds)}` : t("common.loading")}
                  </p>
                )}
              </div>
              {health.data ? (
                <Badge tone="success">
                  <Check className="size-3" aria-hidden />
                  {t("integrations.status.ok")}
                </Badge>
              ) : health.error ? (
                <Badge tone="destructive">
                  <X className="size-3" aria-hidden />
                  {t("integrations.status.fail")}
                </Badge>
              ) : (
                <Skeleton className="h-5 w-14" />
              )}
            </div>

            <div className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
              <div>
                <p className="text-xs font-medium">{t("integrations.status.mcp")}</p>
                {mcpInfo.error ? (
                  <p className="text-[10px] text-destructive">{mcpInfo.error.message}</p>
                ) : (
                  <p className="text-[10px] text-muted-foreground">
                    {mcpInfo.data ? `${mcpInfo.data.tools.length} tools` : t("common.loading")}
                  </p>
                )}
              </div>
              {mcpInfo.data ? (
                <Badge tone="success">
                  <Check className="size-3" aria-hidden />
                  {t("integrations.status.ok")}
                </Badge>
              ) : mcpInfo.error ? (
                <Badge tone="destructive">
                  <X className="size-3" aria-hidden />
                  {t("integrations.status.fail")}
                </Badge>
              ) : (
                <Skeleton className="h-5 w-14" />
              )}
            </div>

            {health.data ? (
              <div className="grid grid-cols-2 gap-1.5 text-[11px] text-muted-foreground">
                <span>{t("integrations.status.version")}: <span className="font-mono text-foreground">{health.data.version}</span></span>
                <span>
                  {t("integrations.status.providers")}:{" "}
                  <span className="font-mono text-foreground">
                    {health.data.providers.enabled} / {health.data.providers.total}
                  </span>
                </span>
                {health.data.database ? (
                  <span>
                    DB: <span className="font-mono text-foreground">{health.data.database.driver}</span>
                  </span>
                ) : null}
                {health.data.encryption ? (
                  <span>
                    Encryption: <span className="font-mono text-foreground">{health.data.encryption.source}</span>
                  </span>
                ) : null}
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <section className="space-y-3">
        <SectionHeader
          title={t("integrations.tokens.title")}
          description={t("integrations.tokens.desc")}
          actions={
            <>
              <Input
                value={tokenFilter}
                onChange={(event) => setTokenFilter(event.target.value)}
                placeholder={t("integrations.tokens.name")}
                className="h-8 w-40 text-xs"
                aria-label={t("integrations.tokens.name")}
              />
              <Button size="sm" onClick={() => setTokenDialog(true)}>
                <Plus aria-hidden />
                {t("integrations.tokens.create")}
              </Button>
            </>
          }
        />

        {tokens.error ? (
          <Alert
            tone="error"
            title={`${tokens.error.code}: ${tokens.error.message}`}
            action={<Button size="sm" variant="outline" onClick={tokens.reload}>{t("common.retry")}</Button>}
          />
        ) : tokens.loading && !tokens.data ? (
          <Skeleton className="h-32" />
        ) : visibleTokens.length === 0 ? (
          <EmptyState
            icon={ShieldCheck}
            title={t("integrations.tokens.empty")}
            description={t("integrations.tokens.emptyDesc")}
            action={
              <Button size="sm" onClick={() => setTokenDialog(true)}>
                <Plus aria-hidden />
                {t("integrations.tokens.create")}
              </Button>
            }
          />
        ) : (
          <Table minWidth="min-w-[860px]" caption={t("integrations.tokens.title")}>
            <THead>
              <tr>
                <TH>{t("integrations.tokens.name")}</TH>
                <TH>{t("integrations.tokens.prefix")}</TH>
                <TH>{t("integrations.tokens.scopesCol")}</TH>
                <TH className="text-right">{t("integrations.tokens.rateLimit")}</TH>
                <TH>{t("integrations.tokens.expiresAt")}</TH>
                <TH>{t("integrations.tokens.lastUsed")}</TH>
                <TH>{t("common.status")}</TH>
                <TH className="text-right">{t("common.actions")}</TH>
              </tr>
            </THead>
            <TBody>
              {visibleTokens.map((token) => (
                <TR key={token.id} selected={token.revokedAt !== null}>
                  <TD>
                    <p className="font-medium">{token.name}</p>
                    <p className="text-[10px] text-muted-foreground">{formatDateTime(token.createdAt)}</p>
                  </TD>
                  <TD className="font-mono text-xs text-muted-foreground">{token.prefix}…</TD>
                  <TD>
                    <div className="flex flex-wrap gap-1">
                      {token.scopes.length === 0 ? (
                        <Badge tone="muted">—</Badge>
                      ) : (
                        token.scopes.map((scope) => (
                          <Badge key={scope} tone="outline">
                            {scope}
                          </Badge>
                        ))
                      )}
                    </div>
                  </TD>
                  <TD className="text-right font-mono text-xs tabular-nums">{token.rateLimitPerMin}</TD>
                  <TD className="whitespace-nowrap text-[11px]">
                    {token.expiresAt ? formatDateTime(token.expiresAt) : t("common.never")}
                  </TD>
                  <TD className="whitespace-nowrap text-[11px]">
                    {token.lastUsedAt ? formatDateTime(token.lastUsedAt) : t("common.never")}
                  </TD>
                  <TD>
                    {token.revokedAt ? (
                      <Badge tone="destructive">{t("integrations.tokens.revoked")}</Badge>
                    ) : (
                      <Badge tone="success">{t("integrations.tokens.active")}</Badge>
                    )}
                  </TD>
                  <TD>
                    <div className="flex justify-end">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:text-destructive"
                        disabled={token.revokedAt !== null}
                        onClick={() => setRevoking(token)}
                      >
                        <Trash2 aria-hidden />
                        {t("integrations.tokens.revoke")}
                      </Button>
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </section>

      <section className="space-y-3">
        <SectionHeader
          title={t("integrations.tools.title")}
          description={mcpInfo.data ? t("integrations.tools.desc", { count: mcpInfo.data.tools.length }) : undefined}
        />
        {mcpInfo.error ? (
          <Alert
            tone="warning"
            title={t("integrations.tools.unavailable")}
            action={<Button size="sm" variant="outline" onClick={mcpInfo.reload}>{t("common.retry")}</Button>}
          >
            <p className="font-mono">{mcpInfo.error.code}</p>
            <p>{mcpInfo.error.message}</p>
          </Alert>
        ) : mcpInfo.data ? (
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {mcpInfo.data.tools.map((tool) => (
              <Card key={tool.name}>
                <CardContent className="space-y-1 p-3.5">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate font-mono text-xs font-medium">{tool.name}</p>
                  </div>
                  <p className="text-xs font-medium">{tool.title}</p>
                  <p className="line-clamp-3 text-[11px] leading-relaxed text-muted-foreground">
                    {tool.description}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <Skeleton className="h-32" />
        )}
      </section>

      <section className="space-y-3">
        <SectionHeader title={t("integrations.config.title")} description={t("integrations.config.desc")} />
        <div className="grid gap-3 xl:grid-cols-2">
          <Card>
            <CardHeader>
              <div>
                <CardTitle>{t("integrations.config.claude")}</CardTitle>
                <CardDescription>{t("integrations.config.claudeNote")}</CardDescription>
              </div>
            </CardHeader>
            <CardContent>
              <CodeBlock
                code={claudeConfig}
                language="json"
                onCopy={() => {
                  void copy.copy(claudeConfig).then((ok) =>
                    toast[ok ? "success" : "error"]({ title: ok ? t("common.copied") : t("common.copyFailed") }),
                  );
                }}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div>
                <CardTitle>{t("integrations.config.cursor")}</CardTitle>
                <CardDescription>{t("integrations.config.cursorNote")}</CardDescription>
              </div>
            </CardHeader>
            <CardContent>
              <CodeBlock
                code={cursorConfig}
                language="json"
                onCopy={() => {
                  void copy.copy(cursorConfig).then((ok) =>
                    toast[ok ? "success" : "error"]({ title: ok ? t("common.copied") : t("common.copyFailed") }),
                  );
                }}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div>
                <CardTitle>{t("integrations.config.http")}</CardTitle>
                <CardDescription>{t("integrations.config.httpNote")}</CardDescription>
              </div>
            </CardHeader>
            <CardContent>
              <CodeBlock
                code={httpExample}
                language="shell"
                onCopy={() => {
                  void copy.copy(httpExample).then((ok) =>
                    toast[ok ? "success" : "error"]({ title: ok ? t("common.copied") : t("common.copyFailed") }),
                  );
                }}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div>
                <CardTitle className="flex items-center gap-1.5">
                  <Terminal className="size-4" aria-hidden />
                  {t("integrations.stdio.title")}
                </CardTitle>
                <CardDescription>{t("integrations.stdio.desc")}</CardDescription>
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              <CodeBlock
                code={stdioCommand}
                language="shell"
                onCopy={() => {
                  void copy.copy(stdioCommand).then((ok) =>
                    toast[ok ? "success" : "error"]({ title: ok ? t("common.copied") : t("common.copyFailed") }),
                  );
                }}
              />
              <p className="text-[11px] text-muted-foreground">{t("integrations.stdio.note")}</p>
            </CardContent>
          </Card>
        </div>
      </section>

      <section className="space-y-3">
        <SectionHeader title={t("integrations.skills.title")} description={t("integrations.skills.desc")} />
        {skills.error ? (
          <Alert
            tone="warning"
            title={t("integrations.skills.unavailable")}
            action={<Button size="sm" variant="outline" onClick={skills.reload}>{t("common.retry")}</Button>}
          >
            <p className="font-mono">{skills.error.code}</p>
            <p>{skills.error.message}</p>
          </Alert>
        ) : skills.loading && !skills.data ? (
          <Skeleton className="h-28" />
        ) : skills.data && skills.data.skills.length === 0 ? (
          <EmptyState icon={FileCode2} title={t("integrations.skills.empty")} />
        ) : skills.data ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {skills.data.skills.map((skill) => (
              <Card key={skill.name}>
                <CardContent className="flex h-full flex-col gap-2 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <p className="min-w-0 truncate font-mono text-sm font-medium">{skill.name}</p>
                    <Badge tone="outline">SKILL.md</Badge>
                  </div>
                  <p className="line-clamp-3 text-[11px] leading-relaxed text-muted-foreground">{skill.description}</p>
                  <p className="truncate font-mono text-[10px] text-muted-foreground">{skill.installPath}</p>
                  {skill.content === null ? (
                    <p className="text-[10px] text-warning">{t("integrations.skills.missingContent")}</p>
                  ) : null}
                  <div className="mt-auto flex flex-wrap gap-1.5 pt-1">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={skill.content === null}
                      onClick={() => setSkillPreview(skill)}
                    >
                      {t("integrations.skills.view")}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={skill.content === null}
                      onClick={() => {
                        if (skill.content === null) return;
                        downloadText(`${skill.name}.md`, skill.content, "text/markdown");
                        toast.success({ title: t("integrations.skills.downloaded", { name: skill.name }) });
                      }}
                    >
                      <Download aria-hidden />
                      {t("integrations.skills.download")}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : null}
      </section>

      <CreateTokenDialog
        open={tokenDialog}
        onClose={() => setTokenDialog(false)}
        onCreated={(created) => {
          setTokenDialog(false);
          setRevealed(created);
          tokens.reload();
        }}
      />

      <Dialog
        open={revealed !== null}
        onClose={() => setRevealed(null)}
        title={t("integrations.tokens.revealTitle")}
        description={t("integrations.tokens.revealDesc")}
        size="md"
        footer={
          <Button
            size="sm"
            onClick={() => {
              if (revealed) {
                void copy.copy(revealed.token).then((ok) =>
                  toast[ok ? "success" : "error"]({ title: ok ? t("common.copied") : t("common.copyFailed") }),
                );
              }
              setRevealed(null);
            }}
          >
            <Clipboard aria-hidden />
            {t("integrations.tokens.done")}
          </Button>
        }
      >
        {revealed ? (
          <div className="space-y-3">
            <Alert tone="warning" title={t("integrations.tokens.revealWarning")} />
            <div className="rounded-md border bg-muted/30 p-3">
              <p className="text-[11px] text-muted-foreground">{revealed.name}</p>
              <p className="mt-1 break-all font-mono text-xs">{revealed.token}</p>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void copy.copy(revealed.token).then((ok) =>
                  toast[ok ? "success" : "error"]({ title: ok ? t("integrations.tokens.copyToken") : t("common.copyFailed") }),
                );
              }}
            >
              <Clipboard aria-hidden />
              {t("integrations.tokens.copyToken")}
            </Button>
          </div>
        ) : null}
      </Dialog>

      <ConfirmDialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        onConfirm={revoke}
        title={t("integrations.tokens.revoke")}
        description={`${revoking?.name ?? ""} — ${t("integrations.tokens.revokeConfirm")}`}
        confirmLabel={t("integrations.tokens.revoke")}
        loading={revokePending}
      />

      <Dialog
        open={skillPreview !== null}
        onClose={() => setSkillPreview(null)}
        title={t("integrations.skills.previewTitle", { name: skillPreview?.name ?? "" })}
        description={skillPreview?.installPath}
        size="lg"
        footer={
          skillPreview && skillPreview.content !== null ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                if (!skillPreview.content) return;
                downloadText(`${skillPreview.name}.md`, skillPreview.content, "text/markdown");
                toast.success({ title: t("integrations.skills.downloaded", { name: skillPreview.name }) });
              }}
            >
              <Download aria-hidden />
              {t("integrations.skills.download")}
            </Button>
          ) : null
        }
      >
        {skillPreview ? (
          skillPreview.content === null ? (
            <Alert tone="warning" title={t("integrations.skills.missingContent")} />
          ) : (
            <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-md border bg-muted/25 p-3 font-mono text-[11px] leading-relaxed">
              {skillPreview.content ?? ""}
            </pre>
          )
        ) : null}
      </Dialog>
    </div>
  );
}

function CreateTokenDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (payload: { token: string; name: string }) => void;
}) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["search", "mcp:use", "sources:read"]);
  const [customScope, setCustomScope] = useState("");
  const [rateLimit, setRateLimit] = useState("120");
  const [expiresAt, setExpiresAt] = useState("");
  const [noExpiry, setNoExpiry] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [validation, setValidation] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!name.trim()) {
      setValidation(t("integrations.tokens.nameRequired"));
      return;
    }
    if (scopes.length === 0) {
      setValidation(t("integrations.tokens.scopesRequired"));
      return;
    }
    const limit = Number(rateLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100000) {
      setValidation(t("providers.form.rangeError", { label: t("integrations.tokens.rateLimit"), min: 1, max: 100000 }));
      return;
    }
    setValidation(null);

    let expiry: string | null = null;
    if (!noExpiry && expiresAt) {
      const date = new Date(expiresAt);
      if (Number.isNaN(date.getTime())) {
        setValidation(t("integrations.tokens.expiresAtInvalid"));
        return;
      }
      expiry = date.toISOString();
    }

    setSaving(true);
    try {
      const result = await api.createToken({
        name: name.trim(),
        scopes,
        rateLimitPerMin: limit,
        ...(expiry ? { expiresAt: expiry } : {}),
      });
      toast.success({ title: t("integrations.tokens.created") });
      onCreated({ token: result.token, name: result.record.name });
      setName("");
      setScopes(["search", "mcp:use", "sources:read"]);
      setCustomScope("");
      setRateLimit("120");
      setExpiresAt("");
      setNoExpiry(true);
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
      title={t("integrations.tokens.create")}
      description={t("integrations.tokens.desc")}
      size="md"
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" form="token-form" size="sm" loading={saving}>
            {saving ? t("common.saving") : t("common.save")}
          </Button>
        </>
      }
    >
      <form id="token-form" onSubmit={(event) => void submit(event)} className="space-y-3">
        {error ? (
          <Alert tone="error" title={`${error.code}: ${error.message}`}>
            {error.details ? <JsonPreview value={error.details} /> : null}
          </Alert>
        ) : null}
        {validation ? <Alert tone="warning" title={validation} /> : null}

        <Field label={t("integrations.tokens.name")} htmlFor="token-name" required>
          <Input
            id="token-name"
            required
            maxLength={80}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t("integrations.tokens.namePlaceholder")}
          />
        </Field>

        <Field
          label={t("integrations.tokens.scopes")}
          hint={t("integrations.tokens.scopeHint")}
          required
        >
          <div className="space-y-1.5 rounded-md border p-2">
            {SCOPE_OPTIONS.map((option) => (
              <label key={option.value} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4 rounded border-input accent-primary"
                  checked={scopes.includes(option.value)}
                  onChange={(event) =>
                    setScopes((current) =>
                      event.target.checked
                        ? [...current, option.value]
                        : current.filter((scope) => scope !== option.value),
                    )
                  }
                />
                <span>{t(option.labelKey)}</span>
                <code className="ml-auto font-mono text-[10px] text-muted-foreground">{option.value}</code>
              </label>
            ))}
            <div className="flex items-center gap-1.5 border-t pt-1.5">
              <Input
                value={customScope}
                onChange={(event) => setCustomScope(event.target.value)}
                placeholder={t("integrations.tokens.customScope")}
                className="h-7 text-xs"
                aria-label={t("integrations.tokens.customScope")}
              />
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  const value = customScope.trim();
                  if (!value) return;
                  setScopes((current) => (current.includes(value) ? current : [...current, value]));
                  setCustomScope("");
                }}
              >
                <Plus aria-hidden />
                {t("common.add")}
              </Button>
            </div>
            {scopes.filter((scope) => !SCOPE_OPTIONS.some((option) => option.value === scope)).length > 0 ? (
              <div className="flex flex-wrap gap-1 pt-1">
                {scopes
                  .filter((scope) => !SCOPE_OPTIONS.some((option) => option.value === scope))
                  .map((scope) => (
                    <Badge key={scope} tone="outline">
                      {scope}
                      <button
                        type="button"
                        onClick={() => setScopes((current) => current.filter((item) => item !== scope))}
                        className="ml-0.5 hover:text-destructive"
                        aria-label={t("common.delete")}
                      >
                        <X className="size-3" aria-hidden />
                      </button>
                    </Badge>
                  ))}
              </div>
            ) : null}
          </div>
        </Field>

        <Field label={t("integrations.tokens.rateLimit")} htmlFor="token-limit">
          <Input
            id="token-limit"
            type="number"
            min={1}
            max={100000}
            value={rateLimit}
            onChange={(event) => setRateLimit(event.target.value)}
          />
        </Field>

        <div className="flex items-center justify-between rounded-md border bg-muted/20 px-3 py-2">
          <span className="text-xs">{t("integrations.tokens.expiresHint")}</span>
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-muted-foreground">{t("common.never")}</span>
            <Switch checked={noExpiry} onChange={setNoExpiry} label={t("integrations.tokens.expiresAt")} />
          </div>
        </div>

        {!noExpiry ? (
          <Field label={t("integrations.tokens.expiresAt")} htmlFor="token-expiry" required>
            <Input
              id="token-expiry"
              type="datetime-local"
              value={expiresAt}
              onChange={(event) => setExpiresAt(event.target.value)}
            />
          </Field>
        ) : null}
      </form>
    </Dialog>
  );
}
