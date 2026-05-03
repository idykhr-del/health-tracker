interface Props {
  label: string
  value: string | number | null
  unit?: string
  change?: number | null
  changeUnit?: string
  highlight?: boolean
}

export default function SummaryCard({ label, value, unit = '', change, changeUnit = '', highlight }: Props) {
  const changeColor = change == null ? '' : change > 0 ? 'text-red-400' : change < 0 ? 'text-accentGreen' : 'text-muted'

  return (
    <div className={`rounded-xl p-4 flex flex-col gap-1 ${highlight ? 'bg-accent/10 border border-accent/30' : 'bg-card'}`}>
      <span className="text-xs text-muted">{label}</span>
      <div className="flex items-end gap-1">
        <span className="text-2xl font-bold text-white">
          {value ?? '—'}
        </span>
        {value != null && unit && <span className="text-sm text-muted mb-0.5">{unit}</span>}
      </div>
      {change != null && (
        <span className={`text-xs font-medium ${changeColor}`}>
          {change > 0 ? '+' : ''}{change}{changeUnit} 前週比
        </span>
      )}
    </div>
  )
}
