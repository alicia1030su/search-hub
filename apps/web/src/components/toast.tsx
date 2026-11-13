import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { classNames as cn } from "../lib/format";
import { t } from "../lib/i18n";

type ToastKind = "success" | "error" | "info";

interface ToastOptions {
  title: string;
  description?: string;
}

interface ToastItem extends ToastOptions {
  id: number;
  kind: ToastKind;
}

interface ToastApi {
  success: (options: ToastOptions) => void;
  error: (options: ToastOptions) => void;
  info: (options: ToastOptions) => void;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const icons = {
  success: CheckCircle2,
  error: AlertCircle,
  info: Info,
} as const;

const toneClasses: Record<ToastKind, string> = {
  success: "text-success",
  error: "text-destructive",
  info: "text-info",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id));
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (kind: ToastKind, options: ToastOptions) => {
      const id = nextId.current++;
      setItems((current) => [...current.slice(-3), { ...options, id, kind }]);
      const timer = window.setTimeout(() => dismiss(id), kind === "error" ? 8000 : 4500);
      timers.current.set(id, timer);
    },
    [dismiss],
  );

  useEffect(() => {
    const active = timers.current;
    return () => {
      for (const timer of active.values()) window.clearTimeout(timer);
      active.clear();
    };
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      success: (options) => push("success", options),
      error: (options) => push("error", options),
      info: (options) => push("info", options),
      dismiss,
    }),
    [push, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        className="pointer-events-none fixed right-3 top-3 z-[80] flex w-[min(94vw,380px)] flex-col gap-2"
        aria-live="polite"
        aria-atomic="false"
      >
        {items.map((item) => {
          const Icon = icons[item.kind];
          return (
            <div
              key={item.id}
              role={item.kind === "error" ? "alert" : "status"}
              className="animate-toast-in pointer-events-auto flex gap-3 rounded-lg border bg-card p-3 text-card-foreground shadow-lg"
            >
              <Icon className={cn("mt-0.5 size-4 shrink-0", toneClasses[item.kind])} aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium leading-snug">{item.title}</p>
                {item.description ? (
                  <p className="mt-0.5 break-words text-xs leading-relaxed text-muted-foreground">
                    {item.description}
                  </p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => dismiss(item.id)}
                className="mt-0.5 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
                aria-label={t("common.close")}
              >
                <X className="size-3.5" aria-hidden />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast must be used inside ToastProvider");
  return context;
}
