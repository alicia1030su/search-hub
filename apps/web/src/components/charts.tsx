import { useId, useMemo, useRef, useState } from "react";
import { formatAxisTime, formatMs, formatNumber } from "../lib/format";

export interface TimelinePoint {
  bucket: string;
  searches: number;
  errors: number;
  avgLatencyMs: number;
}

const PADDING = { top: 16, right: 24, bottom: 26, left: 44 };
const VIEW_WIDTH = 760;
const VIEW_HEIGHT = 260;

export function TimelineChart({
  points,
  labels,
}: {
  points: TimelinePoint[];
  labels: { searches: string; errors: string; latency: string };
}) {
  const gradientId = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const geometry = useMemo(() => {
    const plotWidth = VIEW_WIDTH - PADDING.left - PADDING.right;
    const plotHeight = VIEW_HEIGHT - PADDING.top - PADDING.bottom;
    const maxSearches = Math.max(1, ...points.map((point) => point.searches));
    const maxLatency = Math.max(1, ...points.map((point) => point.avgLatencyMs));
    const slot = points.length > 0 ? plotWidth / points.length : plotWidth;
    const barWidth = Math.max(1.5, Math.min(18, slot * 0.6));

    const xOf = (index: number) => PADDING.left + slot * index + slot / 2;
    const ySearches = (value: number) => PADDING.top + plotHeight - (value / maxSearches) * plotHeight;
    const yLatency = (value: number) => PADDING.top + plotHeight - (value / maxLatency) * plotHeight * 0.82;
    const linePath = points
      .map((point, index) => `${index === 0 ? "M" : "L"}${xOf(index).toFixed(1)},${yLatency(point.avgLatencyMs).toFixed(1)}`)
      .join(" ");

    const tickDecimals = maxSearches < 5 ? 1 : 0;
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((fraction) => ({
      value: (maxSearches * (1 - fraction)).toFixed(tickDecimals),
      y: PADDING.top + plotHeight * fraction,
    }));

    const labelIndexes: number[] = [];
    const labelCount = Math.min(6, points.length);
    if (points.length <= labelCount) {
      for (let index = 0; index < points.length; index += 1) labelIndexes.push(index);
    } else {
      for (let step = 0; step < labelCount; step += 1) {
        labelIndexes.push(Math.round((step / (labelCount - 1)) * (points.length - 1)));
      }
    }

    return {
      plotWidth,
      plotHeight,
      maxSearches,
      maxLatency,
      slot,
      barWidth,
      xOf,
      ySearches,
      yLatency,
      linePath,
      ticks,
      labelIndexes,
    };
  }, [points]);

  if (points.length === 0) {
    return null;
  }

  const hoveredPoint = hover === null ? null : points[hover];

  return (
    <div className="relative">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        className="w-full touch-none select-none"
        role="img"
        aria-label={`${labels.searches} / ${labels.errors} / ${labels.latency}`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const ratio = (event.clientX - rect.left) / rect.width;
          const x = ratio * VIEW_WIDTH;
          const index = Math.floor((x - PADDING.left) / geometry.slot);
          if (index < 0 || index >= points.length) {
            setHover(null);
            return;
          }
          setHover(index);
        }}
      >
        <defs>
          <linearGradient id={`${gradientId}-bar`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--foreground)" stopOpacity="0.55" />
            <stop offset="100%" stopColor="var(--foreground)" stopOpacity="0.18" />
          </linearGradient>
        </defs>

        {geometry.ticks.map((tick) => (
          <g key={`tick-${tick.y}`}>
            <line
              x1={PADDING.left}
              x2={VIEW_WIDTH - PADDING.right}
              y1={tick.y}
              y2={tick.y}
              stroke="var(--border)"
              strokeWidth={1}
            />
            <text
              x={PADDING.left - 8}
              y={tick.y + 3.5}
              textAnchor="end"
              fontSize={10}
              fill="var(--muted-foreground)"
            >
              {tick.value}
            </text>
          </g>
        ))}

        {points.map((point, index) => {
          const height = Math.max(0, PADDING.top + geometry.plotHeight - geometry.ySearches(point.searches));
          const errorHeight = point.errors > 0 ? (point.errors / geometry.maxSearches) * geometry.plotHeight : 0;
          return (
            <g key={point.bucket}>
              <rect
                x={geometry.xOf(index) - geometry.barWidth / 2}
                y={PADDING.top + geometry.plotHeight - height}
                width={geometry.barWidth}
                height={Math.max(height, point.searches > 0 ? 1.5 : 0)}
                rx={Math.min(3, geometry.barWidth / 3)}
                fill={`url(#${gradientId}-bar)`}
                opacity={hover === null || hover === index ? 1 : 0.55}
              />
              {errorHeight > 0 ? (
                <rect
                  x={geometry.xOf(index) - geometry.barWidth / 2}
                  y={PADDING.top + geometry.plotHeight - Math.max(errorHeight, 1.5)}
                  width={geometry.barWidth}
                  height={Math.max(errorHeight, 1.5)}
                  rx={Math.min(2, geometry.barWidth / 4)}
                  fill="var(--destructive)"
                  opacity={hover === null || hover === index ? 0.75 : 0.4}
                />
              ) : null}
            </g>
          );
        })}

        <path d={geometry.linePath} fill="none" stroke="var(--info)" strokeWidth={1.6} strokeLinejoin="round" />

        {hover !== null && hoveredPoint ? (
          <g>
            <line
              x1={geometry.xOf(hover)}
              x2={geometry.xOf(hover)}
              y1={PADDING.top}
              y2={PADDING.top + geometry.plotHeight}
              stroke="var(--ring)"
              strokeDasharray="3 3"
              strokeWidth={1}
            />
            <circle
              cx={geometry.xOf(hover)}
              cy={geometry.yLatency(hoveredPoint.avgLatencyMs)}
              r={3}
              fill="var(--info)"
            />
          </g>
        ) : null}

        {geometry.labelIndexes.map((index) => {
          const point = points[index];
          if (!point) return null;
          return (
            <text
              key={`label-${point.bucket}`}
              x={geometry.xOf(index)}
              y={VIEW_HEIGHT - 8}
              textAnchor="middle"
              fontSize={10}
              fill="var(--muted-foreground)"
            >
              {formatAxisTime(point.bucket)}
            </text>
          );
        })}
      </svg>

      {hoveredPoint ? (
        <div
          className="pointer-events-none absolute top-1 z-10 min-w-40 rounded-md border bg-card px-2.5 py-2 text-[11px] shadow-lg"
          style={{
            left: `calc(${(geometry.xOf(hover ?? 0) / VIEW_WIDTH) * 100}% + 8px)`,
            transform: (hover ?? 0) > points.length * 0.7 ? "translateX(-110%)" : undefined,
          }}
        >
          <p className="mb-1 font-medium">{formatAxisTime(hoveredPoint.bucket)}</p>
          <p className="flex justify-between gap-3 text-muted-foreground">
            <span>{labels.searches}</span>
            <span className="font-mono text-foreground">{formatNumber(hoveredPoint.searches)}</span>
          </p>
          <p className="flex justify-between gap-3 text-muted-foreground">
            <span>{labels.errors}</span>
            <span className="font-mono text-foreground">{formatNumber(hoveredPoint.errors)}</span>
          </p>
          <p className="flex justify-between gap-3 text-muted-foreground">
            <span>{labels.latency}</span>
            <span className="font-mono text-foreground">{formatMs(hoveredPoint.avgLatencyMs)}</span>
          </p>
        </div>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-4 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-3 rounded-sm bg-foreground/40" aria-hidden />
          {labels.searches}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-3 rounded-sm bg-destructive/70" aria-hidden />
          {labels.errors}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-4 rounded bg-info" aria-hidden />
          {labels.latency}
        </span>
      </div>
    </div>
  );
}

/** Horizontal stacked bar for key-pool health distribution. */
export function StackedBar({
  segments,
}: {
  segments: Array<{ label: string; value: number; className: string }>;
}) {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  if (total === 0) {
    return <div className="h-2 w-full rounded-full bg-muted" aria-hidden />;
  }
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
      {segments.map((segment) =>
        segment.value > 0 ? (
          <div
            key={segment.label}
            className={segment.className}
            style={{ width: `${(segment.value / total) * 100}%` }}
            title={`${segment.label}: ${segment.value}`}
          />
        ) : null,
      )}
    </div>
  );
}

/** Compact horizontal meter used inside tables. */
export function Meter({ ratio, tone = "bg-foreground/60" }: { ratio: number; tone?: string }) {
  const width = Math.max(0, Math.min(1, ratio)) * 100;
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${width}%` }} />
      </div>
      <span className="w-10 shrink-0 text-right font-mono text-[11px] text-muted-foreground">
        {(ratio * 100).toFixed(ratio > 0 && ratio < 0.01 ? 2 : 0)}%
      </span>
    </div>
  );
}
