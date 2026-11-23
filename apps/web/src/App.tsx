import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Loader2, PlugZap, RotateCcw } from "lucide-react";
import { AppShell } from "./components/app-shell";
import { Button, Card, CardContent } from "./components/ui";
import { useAuth } from "./lib/session";
import { useLocale } from "./lib/hooks";
import { t } from "./lib/i18n";
import { SetupPage, LoginPage } from "./pages/auth";
import { DashboardPage } from "./pages/dashboard";
import { ProvidersPage } from "./pages/providers";
import { ModelsPage } from "./pages/models";
import { LabPage } from "./pages/lab";
import { QualityPage } from "./pages/quality";
import { IntegrationsPage } from "./pages/integrations";
import { SettingsPage } from "./pages/settings";
import { BackupPage } from "./pages/backup";

function BootScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="flex items-center gap-2.5 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        {t("boot.loading")}
      </div>
    </div>
  );
}

function UnreachableScreen({ message }: { message: string }) {
  const { retry } = useAuth();
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md">
        <CardContent className="space-y-4 p-6">
          <div className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-destructive/10 text-destructive">
              <PlugZap className="size-4" aria-hidden />
            </span>
            <div>
              <h1 className="text-base font-semibold">{t("boot.unreachable")}</h1>
              <p className="mt-1 text-sm text-muted-foreground">{t("boot.unreachableDesc")}</p>
            </div>
          </div>
          <pre className="overflow-x-auto rounded-md border bg-muted/40 p-3 font-mono text-[11px] text-muted-foreground">
            {message}
          </pre>
          <Button size="sm" onClick={retry}>
            <RotateCcw aria-hidden />
            {t("boot.retry")}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function NotFoundPage() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 text-center">
      <p className="font-mono text-5xl font-semibold text-muted-foreground/40">404</p>
      <h1 className="text-lg font-semibold">{t("notfound.title")}</h1>
      <p className="max-w-sm text-sm text-muted-foreground">{t("notfound.desc")}</p>
      <Button size="sm" onClick={() => window.location.assign("/")}>
        {t("notfound.home")}
      </Button>
    </div>
  );
}

function AppRoutes() {
  const { status, bootError } = useAuth();

  if (status === "loading") return <BootScreen />;
  if (status === "unreachable") {
    return <UnreachableScreen message={bootError ? `${bootError.code}: ${bootError.message}` : "network error"} />;
  }

  return (
    <Routes>
      <Route
        path="/setup"
        element={
          status === "setup" ? (
            <SetupPage />
          ) : (
            <Navigate to={status === "authenticated" ? "/" : "/login"} replace />
          )
        }
      />
      <Route
        path="/login"
        element={
          status === "anonymous" ? (
            <LoginPage />
          ) : status === "setup" ? (
            <Navigate to="/setup" replace />
          ) : (
            <Navigate to="/" replace />
          )
        }
      />
      <Route
        element={
          status === "authenticated" ? (
            <AppShell />
          ) : (
            <Navigate to={status === "setup" ? "/setup" : "/login"} replace />
          )
        }
      >
        <Route path="/" element={<DashboardPage />} />
        <Route path="/providers" element={<ProvidersPage />} />
        <Route path="/models" element={<ModelsPage />} />
        <Route path="/lab" element={<LabPage />} />
        <Route path="/quality" element={<QualityPage />} />
        <Route path="/integrations" element={<IntegrationsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/backup" element={<BackupPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

export function App() {
  // Subscribing at the root means a language switch re-renders the whole tree,
  // including the pre-login screens. `t()` reads the locale at render time, so a
  // re-render is all that is needed — no dictionary has to be threaded through
  // props.
  useLocale();
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}
