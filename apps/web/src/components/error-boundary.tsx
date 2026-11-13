import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertOctagon } from "lucide-react";
import { Button, Card, CardContent, JsonPreview } from "./ui";
import { t } from "../lib/i18n";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  info: string | null;
}

/**
 * Top-level boundary. React cannot rethrow on re-render, so recovery is a
 * remount of the subtree after the user dismisses the error.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ info: info.componentStack ?? null });
    console.error("[search-hub] render error", error, info);
  }

  private reset = (): void => {
    this.setState({ error: null, info: null });
  };

  override render(): ReactNode {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6">
        <Card className="w-full max-w-2xl">
          <CardContent className="space-y-4 p-6">
            <div className="flex items-start gap-3">
              <AlertOctagon className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden />
              <div>
                <h1 className="text-base font-semibold">{t("errors.boundaryTitle")}</h1>
                <p className="mt-1 text-sm text-muted-foreground">{t("errors.boundaryDesc")}</p>
              </div>
            </div>
            <JsonPreview value={{ message: error.message, stack: error.stack, componentStack: info }} />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={this.reset}>
                {t("errors.boundaryReset")}
              </Button>
              <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
                {t("errors.boundaryReload")}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }
}
