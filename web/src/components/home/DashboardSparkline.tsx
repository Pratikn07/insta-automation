import { cn } from "@/lib/utils";

interface DashboardSparklineProps {
  values: Array<number | null>;
  label: string;
  className?: string;
}

export function DashboardSparkline({ values, label, className }: DashboardSparklineProps) {
  const measured = values
    .map((value, index) => ({ value, index }))
    .filter((item): item is { value: number; index: number } => typeof item.value === "number");

  if (measured.length < 2) {
    return (
      <div
        role="img"
        aria-label={`${label}: not enough history yet`}
        className={cn("flex h-24 items-center justify-center rounded-xl border border-dashed text-xs text-muted-foreground", className)}
      >
        Trend appears after two snapshots
      </div>
    );
  }

  const width = 360;
  const height = 104;
  const inset = 8;
  const min = Math.min(...measured.map((item) => item.value));
  const max = Math.max(...measured.map((item) => item.value));
  const spread = Math.max(max - min, 1);
  const totalSlots = Math.max(values.length - 1, 1);
  const coords = measured.map((item) => ({
    x: inset + (item.index / totalSlots) * (width - inset * 2),
    y: height - inset - ((item.value - min) / spread) * (height - inset * 2),
  }));
  const line = coords.map((point) => `${point.x},${point.y}`).join(" ");
  const area = `${coords[0]!.x},${height - inset} ${line} ${coords.at(-1)!.x},${height - inset}`;

  return (
    <svg
      role="img"
      aria-label={`${label}: ${min.toFixed(1)}% to ${max.toFixed(1)}%`}
      viewBox={`0 0 ${width} ${height}`}
      className={cn("h-24 w-full overflow-visible", className)}
      preserveAspectRatio="none"
    >
      <title>{label}</title>
      <defs>
        <linearGradient id="audience-area" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgb(52 211 153)" stopOpacity="0.32" />
          <stop offset="100%" stopColor="rgb(52 211 153)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <line x1={inset} y1={height / 2} x2={width - inset} y2={height / 2} stroke="currentColor" strokeOpacity="0.1" strokeDasharray="4 6" />
      <polygon points={area} fill="url(#audience-area)" />
      <polyline
        points={line}
        fill="none"
        stroke="rgb(52 211 153)"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      {coords.map((point, index) => (
        <circle
          key={`${point.x}-${point.y}`}
          cx={point.x}
          cy={point.y}
          r={index === coords.length - 1 ? 4 : 2.5}
          fill={index === coords.length - 1 ? "rgb(52 211 153)" : "rgb(17 24 39)"}
          stroke="rgb(52 211 153)"
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
}
