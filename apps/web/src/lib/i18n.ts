import type {
  Freshness,
  KeyStatus,
  KeyStrategy,
  ModelKind,
  ModelProviderType,
  ProviderAuthType,
  ProviderCategory,
  ProviderImplementation,
  ProviderVerification,
  SearchMode,
  SearchStatus,
} from "./types";
import { en } from "./i18n-en.js";
import { zh, type MessageKey } from "./i18n-zh.js";

export type { MessageKey };
export type Locale = "zh-CN" | "en-US";

/**
 * Locale runtime.
 *
 * Chinese stays the default: an instance with no stored preference keeps the
 * original behaviour. The choice is persisted in `localStorage` so a reload, a
 * new tab and the E2E assertion after `page.reload()` all see the same language.
 *
 * `t()` is a plain function rather than a hook because ~900 call sites use it
 * directly. Switching locale therefore also dispatches an event and bumps a
 * module-level version; `useLocale()` subscribes to it so every component that
 * renders copy re-renders with the new dictionary.
 */
const STORAGE_KEY = "sh.locale";
const LOCALES: Locale[] = ["zh-CN", "en-US"];
const DICTIONARIES: Record<Locale, Record<MessageKey, string>> = {
  "zh-CN": zh,
  "en-US": en,
};

function detectInitialLocale(): Locale {
  if (typeof window === "undefined") return "zh-CN";
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored && LOCALES.includes(stored as Locale)) return stored as Locale;
  } catch {
    // A blocked storage (private mode, strict policy) must not break the app.
  }
  return "zh-CN";
}

let currentLocale: Locale = detectInitialLocale();
let version = 0;
const listeners = new Set<() => void>();

export function getLocale(): Locale {
  return currentLocale;
}

export function setLocale(next: Locale): void {
  if (!LOCALES.includes(next) || next === currentLocale) return;
  currentLocale = next;
  version += 1;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* preference is best effort; the session still switches */
    }
    document.documentElement.lang = next;
  }
  for (const listener of listeners) listener();
}

/** Subscribes to locale changes; returns the unsubscribe function. */
export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Monotonic counter used by `useSyncExternalStore` to detect a change. */
export function localeVersion(): number {
  return version;
}

export function availableLocales(): Array<{ value: Locale; label: string }> {
  return [
    { value: "zh-CN", label: "简体中文" },
    { value: "en-US", label: "English" },
  ];
}



export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  const dictionary = DICTIONARIES[currentLocale] ?? zh;
  const template = dictionary[key] ?? zh[key] ?? key;
  if (!vars) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
    const value = vars[name];
    return value === undefined ? match : String(value);
  });
}

/** Looks up a message in the current locale (alias kept for readability). */
export const tr = t;

export function keyStatusLabel(status: KeyStatus): string {
  return t(`keyStatus.${status}` as MessageKey);
}

export function searchStatusLabel(status: SearchStatus): string {
  return t(`searchStatus.${status}` as MessageKey);
}

export function keyStrategyLabel(strategy: KeyStrategy): string {
  return t(`keyStrategy.${strategy}` as MessageKey);
}

export function categoryLabel(category: ProviderCategory): string {
  return t(`category.${category}` as MessageKey);
}

export function implementationLabel(implementation: ProviderImplementation): string {
  return t(`implementation.${implementation}` as MessageKey);
}

export function verificationLabel(verification: ProviderVerification): string {
  return t(`verification.${verification}` as MessageKey);
}

export function providerAuthLabel(auth: ProviderAuthType): string {
  return t(`providersAuth.${auth}` as MessageKey);
}

export function freshnessLabel(freshness: Freshness): string {
  return t(`providers.freshness.${freshness}` as MessageKey);
}

export function searchModeLabel(mode: SearchMode): string {
  return t(`lab.mode.${mode}` as MessageKey);
}

export function modelKindLabel(kind: ModelKind): string {
  return t(`models.kind.${kind}` as MessageKey);
}

export function modelProviderTypeLabel(kind: ModelProviderType): string {
  return t(`models.providerType.${kind}` as MessageKey);
}

export const logLevels = ["fatal", "error", "warn", "info", "debug", "trace"] as const;
export type LogLevel = (typeof logLevels)[number];

export function logLevelLabel(level: string): string {
  // Log levels are identifiers, not prose: they read the same in every locale.
  return logLevels.includes(level as LogLevel) ? level : level;
}

export function droppedReasonLabel(reason: "exact_url" | "near_title"): string {
  return t(`lab.result.droppedReason.${reason}` as MessageKey);
}

/** The dictionary for the current locale; used by tests and the parity check. */
export function messages(): Record<MessageKey, string> {
  return DICTIONARIES[currentLocale] ?? zh;
}

export { zh, en };
