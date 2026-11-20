import type { KeyStatus } from "./types";

export type KeyStatusTone = "success" | "warning" | "destructive" | "muted";

/** Pure presentation contract shared by the badge and its regression tests. */
export const keyStatusTones: Record<KeyStatus, KeyStatusTone> = {
  healthy: "success",
  rate_limited: "warning",
  cooldown: "warning",
  invalid: "destructive",
  forbidden: "warning",
  quota_exhausted: "warning",
  disabled: "muted",
  unknown: "muted",
};
