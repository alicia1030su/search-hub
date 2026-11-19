import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { isAbortError, toApiError, type ApiError } from "./api";
import { copyText } from "./format";
import { getLocale, localeVersion, setLocale, subscribeLocale, type Locale } from "./i18n";

export interface AsyncResource<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
}

/**
 * Runs an async loader with abort handling. Data is kept while reloading so
 * mutations can refresh tables without flashing a skeleton.
 */
export function useAsyncData<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
): AsyncResource<T> {
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const [tick, setTick] = useState(0);
  const [state, setState] = useState<{ data: T | null; error: ApiError | null; loading: boolean }>({
    data: null,
    error: null,
    loading: true,
  });

  useEffect(() => {
    const controller = new AbortController();
    setState((previous) => ({ data: previous.data, error: null, loading: true }));
    loaderRef
      .current(controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setState({ data, error: null, loading: false });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) return;
        setState((previous) => ({ data: previous.data, error: toApiError(error), loading: false }));
      });
    return () => controller.abort();
    // The caller owns the dependency list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => {
    setTick((value) => value + 1);
  }, []);

  return { data: state.data, error: state.error, loading: state.loading, reload };
}

/**
 * Polls a resource on a fixed interval, stopping when the caller says so.
 *
 * `intervalMs === null` means "this resource is terminal" — it is fetched once
 * and never again. That is the important half of the contract: a bulk test that
 * has already finished must not keep the browser polling the server forever,
 * and the caller (not this hook) decides when a run is over, because only the
 * caller knows what `status` means.
 *
 * Each fetch gets its own `AbortController`, aborted when the interval fires
 * again, when the dependencies change, or on unmount; a slow response therefore
 * cannot land after a newer one and overwrite it.
 */
export function usePolling<T>(
  load: (signal: AbortSignal) => Promise<T>,
  intervalMs: number | null,
  deps: readonly unknown[],
): { data: T | null; error: ApiError | null; refresh: () => void } {
  const loadRef = useRef(load);
  loadRef.current = load;

  const [tick, setTick] = useState(0);
  const [state, setState] = useState<{ data: T | null; error: ApiError | null }>({ data: null, error: null });

  useEffect(() => {
    let timer: number | null = null;
    let controller: AbortController | null = null;
    let stopped = false;

    const run = async (): Promise<void> => {
      if (stopped) return;
      // Abort the previous request: a slow response must never overwrite a newer
      // one, which is exactly what happens when a poll interval is shorter than
      // a slow endpoint's latency.
      controller?.abort();
      const current = new AbortController();
      controller = current;
      try {
        const data = await loadRef.current(current.signal);
        if (stopped || current.signal.aborted) return;
        setState({ data, error: null });
      } catch (error) {
        if (stopped || current.signal.aborted || isAbortError(error)) return;
        setState((previous) => ({ data: previous.data, error: toApiError(error) }));
      }
      if (stopped || intervalMs === null) return;
      timer = window.setTimeout(() => {
        void run();
      }, intervalMs);
    };

    void run();

    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
      controller?.abort();
    };
    // The caller owns the dependency list; `intervalMs` and `tick` are the
    // scheduling knobs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, intervalMs, tick]);

  const refresh = useCallback(() => {
    setTick((value) => value + 1);
  }, []);

  return { data: state.data, error: state.error, refresh };
}

export function useElapsed(startedAt: number | null): number {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (startedAt === null) {
      setElapsed(0);
      return;
    }
    setElapsed(Date.now() - startedAt);
    const timer = window.setInterval(() => {
      setElapsed(Date.now() - startedAt);
    }, 200);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  return elapsed;
}

export function useCopy(): { copied: boolean; copy: (text: string) => Promise<boolean> } {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);

  const copy = useCallback(async (text: string) => {
    const ok = await copyText(text);
    if (ok) {
      setCopied(true);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1800);
    }
    return ok;
  }, []);

  return { copied, copy };
}

export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = `${title} · Search Hub`;
  }, [title]);
}

export function useDisclosure(initial = false): {
  open: boolean;
  setOpen: (value: boolean) => void;
  onOpen: () => void;
  onClose: () => void;
} {
  const [open, setOpen] = useState(initial);
  return {
    open,
    setOpen,
    onOpen: useCallback(() => setOpen(true), []),
    onClose: useCallback(() => setOpen(false), []),
  };
}

/**
 * Locale subscription.
 *
 * `t()` is a plain function, so a component that only calls it would keep its
 * rendered strings until something else re-rendered it. Components that show
 * copy subscribe here, which makes a language switch re-render them without
 * threading a hook through 900 call sites.
 */
export function useLocale(): { locale: Locale; setLocale: (next: Locale) => void } {
  const snapshot = useSyncExternalStore(subscribeLocale, localeVersion, localeVersion);
  void snapshot;
  return { locale: getLocale(), setLocale };
}
