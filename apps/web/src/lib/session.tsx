import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { api, setCsrfToken, toApiError, type ApiError } from "./api";
import type { AuthSession, SetupInput, SetupStatus, User } from "./types";

export type AuthStatus = "loading" | "setup" | "anonymous" | "authenticated" | "unreachable";

export interface AuthContextValue {
  status: AuthStatus;
  user: User | null;
  setupStatus: SetupStatus | null;
  bootError: ApiError | null;
  login: (email: string, password: string) => Promise<void>;
  setup: (input: SetupInput) => Promise<void>;
  logout: () => Promise<void>;
  retry: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<User | null>(null);
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null);
  const [bootError, setBootError] = useState<ApiError | null>(null);
  const [bootVersion, setBootVersion] = useState(0);

  const applySession = useCallback((session: AuthSession) => {
    setCsrfToken(session.csrfToken);
    setUser(session.user);
    setStatus("authenticated");
  }, []);

  const clearSession = useCallback(() => {
    setCsrfToken(null);
    setUser(null);
    setStatus("anonymous");
  }, []);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setBootError(null);

    void (async () => {
      try {
        const statusResponse = await api.setupStatus();
        if (cancelled) return;
        setSetupStatus(statusResponse);
        if (!statusResponse.initialized) {
          setStatus("setup");
          return;
        }
        try {
          const session = await api.session();
          if (cancelled) return;
          applySession(session);
        } catch (error) {
          if (cancelled) return;
          const apiError = toApiError(error);
          if (apiError.isUnauthorized) {
            clearSession();
            return;
          }
          throw apiError;
        }
      } catch (error) {
        if (cancelled) return;
        setBootError(toApiError(error));
        setStatus("unreachable");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [applySession, clearSession, bootVersion]);

  useEffect(() => {
    const handler = () => {
      setCsrfToken(null);
      setUser(null);
      setStatus((current) => (current === "authenticated" ? "anonymous" : current));
    };
    window.addEventListener("sh:unauthorized", handler);
    return () => window.removeEventListener("sh:unauthorized", handler);
  }, []);

  const login = useCallback(
    async (email: string, password: string) => {
      const session = await api.login({ email, password });
      applySession(session);
    },
    [applySession],
  );

  const setup = useCallback(
    async (input: SetupInput) => {
      const session = await api.setup(input);
      applySession(session);
      setSetupStatus((current) =>
        current ? { ...current, initialized: true, admins: Math.max(1, current.admins) } : current,
      );
    },
    [applySession],
  );

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // Clearing the local session is still correct when the call fails.
    } finally {
      clearSession();
    }
  }, [clearSession]);

  const retry = useCallback(() => setBootVersion((value) => value + 1), []);

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, setupStatus, bootError, login, setup, logout, retry }),
    [status, user, setupStatus, bootError, login, setup, logout, retry],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider");
  return context;
}
