interface Props {
  label: string
  current: number | null
  target: number | null
  unit?: string
  invert?: boolean  // lower is better (e.g. body fat %)
}

export default function ProgressBar({ label, current, target, unit = '', invert = false }: Props) {
  if (current == null || target == null) return null

  const progress = invert
    ? Math.max(0, Math.min(100, ((current - target) / current) * 100))
    : Math.max(0, Math.min(100, (current / target) * 100))

  const done = invert ? current <= target : current >= target

  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-between text-xs">
        <span className="text-muted">{label}</span>
        <span className={done ? 'text-accentGreen' : 'text-white'}>
          {current}{unit} / 目標 {target}{unit}
        </span>
      </div>
      <div className="h-2 bg-border rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${done ? 'bg-accentGreen' : 'bg-accent'}`}
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  )
}
