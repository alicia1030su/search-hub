import type { DashboardStats, KeyStatus } from "./types";

export interface DashboardKeySegment {
  status: KeyStatus;
  value: number;
  className: string;
}

/** Complete partition of the dashboard key pool; no status may be dropped. */
export function dashboardKeySegments(
  keys: DashboardStats["keys"],
  label: (status: KeyStatus) => string,
): Array<DashboardKeySegment & { label: string }> {
  const segments: DashboardKeySegment[] = [
    { status: "healthy", value: keys.healthy, className: "bg-success" },
    { status: "rate_limited", value: keys.rateLimited, className: "bg-warning" },
    { status: "cooldown", value: keys.cooldown, className: "bg-warning/55" },
    { status: "invalid", value: keys.invalid, className: "bg-destructive" },
    { status: "forbidden", value: keys.forbidden, className: "bg-warning/70" },
    { status: "quota_exhausted", value: keys.quotaExhausted, className: "bg-warning/85" },
    { status: "disabled", value: keys.disabled, className: "bg-muted-foreground/35" },
  ];
  return segments.map((segment) => ({ ...segment, label: label(segment.status) }));
}
