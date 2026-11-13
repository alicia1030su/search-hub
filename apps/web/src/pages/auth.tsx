import { useState, type FormEvent } from "react";
import { KeyRound, Loader2, Search, ShieldCheck } from "lucide-react";
import { toApiError } from "../lib/api";
import { t } from "../lib/i18n";
import { useAuth } from "../lib/session";
import { Alert, Button, Card, CardContent, Field, Input } from "../components/ui";
import { useToast } from "../components/toast";

function AuthLayout({
  title,
  subtitle,
  children,
  footer,
  version,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  version?: string;
}) {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-10">
      <div className="sh-grid-bg pointer-events-none absolute inset-0 opacity-[0.35]" aria-hidden />
      <div className="relative w-full max-w-md">
        <div className="mb-6 flex items-center gap-2.5">
          <span className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Search className="size-4" aria-hidden />
          </span>
          <div>
            <p className="text-sm font-semibold leading-tight">Search Hub</p>
            <p className="text-[11px] leading-tight text-muted-foreground">{t("app.tagline")}</p>
          </div>
        </div>
        <Card>
          <CardContent className="p-6">
            <div className="mb-5">
              <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{subtitle}</p>
            </div>
            {children}
          </CardContent>
        </Card>
        {footer ? <div className="mt-4 text-center text-xs text-muted-foreground">{footer}</div> : null}
        {version ? <p className="mt-2 text-center text-[10px] text-muted-foreground/70">v{version}</p> : null}
      </div>
    </div>
  );
}

export function SetupPage() {
  const { setup, setupStatus } = useAuth();
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("Admin");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<unknown>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setDetails(null);
    if (password.length < 12) {
      setError(t("auth.setup.passwordTooShort"));
      return;
    }
    if (password !== confirm) {
      setError(t("auth.setup.passwordMismatch"));
      return;
    }
    setSubmitting(true);
    try {
      await setup({
        email,
        password,
        name: name.trim() || "Admin",
        ...(setupToken.trim() ? { setupToken: setupToken.trim() } : {}),
      });
      toast.success({ title: t("auth.setup.success") });
    } catch (caught) {
      const apiError = toApiError(caught);
      setError(apiError.message);
      setDetails(apiError.details ?? null);
    } finally {
      setSubmitting(false);
    }
  };

  const tokenRequired = setupStatus?.setupTokenRequired === true;

  return (
    <AuthLayout
      title={t("auth.setup.title")}
      subtitle={t("auth.setup.subtitle")}
      version={setupStatus?.version}
    >
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label={t("auth.email")} htmlFor="setup-email" required hint={t("auth.setup.emailHint")}>
          <Input
            id="setup-email"
            type="email"
            autoComplete="email"
            required
            maxLength={200}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="admin@example.com"
          />
        </Field>

        <Field label={t("auth.name")} htmlFor="setup-name" required>
          <Input
            id="setup-name"
            required
            maxLength={80}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>

        <Field
          label={t("auth.password")}
          htmlFor="setup-password"
          required
          hint={t("auth.setup.passwordHint")}
        >
          <Input
            id="setup-password"
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            maxLength={200}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>

        <Field label={t("auth.setup.confirmPassword")} htmlFor="setup-confirm" required>
          <Input
            id="setup-confirm"
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
          />
        </Field>

        <Field
          label={`${t("auth.setup.setupToken")} (${tokenRequired ? t("common.required") : t("common.optional")})`}
          htmlFor="setup-token"
          hint={t("auth.setup.setupTokenHint")}
        >
          <Input
            id="setup-token"
            autoComplete="off"
            value={setupToken}
            onChange={(event) => setSetupToken(event.target.value)}
            placeholder="SEARCH_HUB_SETUP_TOKEN"
          />
        </Field>

        {error ? (
          <Alert tone="error" title={error}>
            {details ? <span className="break-all font-mono">{JSON.stringify(details)}</span> : null}
          </Alert>
        ) : null}

        <Button type="submit" className="w-full" loading={submitting} size="lg">
          {submitting ? t("auth.setup.submitting") : t("auth.setup.submit")}
        </Button>

        <div className="flex items-start gap-2 rounded-md border bg-muted/30 p-3 text-[11px] leading-relaxed text-muted-foreground">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>{t("auth.setup.securityNote")}</span>
        </div>
      </form>
    </AuthLayout>
  );
}

export function LoginPage() {
  const { login, setupStatus } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
    } catch (caught) {
      setError(toApiError(caught).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthLayout
      title={t("auth.login.title")}
      subtitle={t("auth.login.subtitle")}
      version={setupStatus?.version}
    >
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label={t("auth.email")} htmlFor="login-email" required>
          <Input
            id="login-email"
            type="email"
            autoComplete="username"
            required
            maxLength={200}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="admin@example.com"
            autoFocus
          />
        </Field>

        <Field label={t("auth.password")} htmlFor="login-password" required>
          <Input
            id="login-password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>

        {error ? <Alert tone="error" title={t("auth.failed")}>{error}</Alert> : null}

        <Button type="submit" className="w-full" loading={submitting} size="lg">
          {submitting ? (
            <>
              <Loader2 className="animate-spin" aria-hidden />
              {t("auth.loggingIn")}
            </>
          ) : (
            <>
              <KeyRound aria-hidden />
              {t("auth.login.submit")}
            </>
          )}
        </Button>
      </form>
    </AuthLayout>
  );
}
